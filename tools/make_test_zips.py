#!/usr/bin/env python3
"""Generate ZIP test archives for LinkUnzip, plus a manifest with the SHA-256 of every file.

The manifest (<kind>.manifest.json) is the "original" that the Rust tests (and
tools/verify_extract.py) compare extracted files against, so the originals never need to be kept.

Kinds
  small     ~200 files in nested folders, unicode names, one CP437-encoded name, an empty folder,
            stored entries, a ZIP comment (so the EOCD is not the last 22 bytes).   (a few MB)
  streamed  Same content as `small`, but written to an *unseekable* stream: every entry uses a data
            descriptor (flag bit 3), and some entries carry a ZIP64 extra field in the LOCAL header
            only, so local and central extra-field lengths differ.
  many      70,000 tiny files: more than 65,535 entries forces a ZIP64 end-of-central-directory
            record without needing a huge archive.
  zip64     One file over 4 GiB (stored) with small files before and after it, so some local
            header offsets are past 4 GiB.                       (needs ~9 GiB free; --big-gib)
  demo      The video demo: by default 24 GiB extracted / ~17-18 GiB compressed of CSV, logs,
            text, JSON lines and incompressible binary.  Scale it with --size-gb.

Examples
  python tools/make_test_zips.py small --out test-data
  python tools/make_test_zips.py zip64 --out test-data --big-gib 4.5
  python tools/make_test_zips.py demo  --out D:/demo --size-gb 2      # quick rehearsal
  python tools/make_test_zips.py demo  --out D:/demo                  # the real thing (24 GiB)
"""

import argparse
import hashlib
import io
import json
import os
import random
import shutil
import sys
import time
import zipfile
from pathlib import Path

GiB = 1 << 30
MiB = 1 << 20
FIXED_TIME = (2024, 3, 1, 12, 0, 0)  # deterministic archives


# --------------------------------------------------------------------------------------
# Writing helpers
# --------------------------------------------------------------------------------------

class Cp437Info(zipfile.ZipInfo):
    """A ZipInfo that stores its name as CP437 with general-purpose flag bit 11 CLEAR.

    Python normally writes any non-ASCII name as UTF-8 (+ bit 11). Old DOS-era tools wrote CP437;
    this reproduces that so we can test the CP437 decoder against a real archive.
    """

    def _encodeFilenameFlags(self):
        return self.filename.encode("cp437"), self.flag_bits


class Unseekable(io.RawIOBase):
    """File wrapper without seek/tell: forces zipfile to use data descriptors (flag bit 3)."""

    def __init__(self, path):
        self._f = open(path, "wb")

    def writable(self):
        return True

    def write(self, b):
        return self._f.write(b)

    def flush(self):
        if not self._f.closed:
            self._f.flush()

    def close(self):
        super().close()  # flushes, then marks this wrapper closed
        self._f.close()


class Builder:
    """Wraps a ZipFile; records name, size, SHA-256 and header offset of everything it writes."""

    def __init__(self, zf):
        self.zf = zf
        self.files = []
        self.dirs = []

    def add_file(self, name, chunks, method=zipfile.ZIP_DEFLATED, *, level=None,
                 force_zip64=False, info_cls=zipfile.ZipInfo):
        """`chunks` is bytes or an iterable of bytes-like objects."""
        if isinstance(chunks, (bytes, bytearray)):
            chunks = [chunks]
        zi = info_cls(name, date_time=FIXED_TIME)
        zi.compress_type = method
        zi.external_attr = 0o644 << 16
        if level is not None:
            zi._compresslevel = level  # private, but stable from 3.7 to 3.13
        digest, size = hashlib.sha256(), 0
        with self.zf.open(zi, "w", force_zip64=force_zip64) as out:
            for chunk in chunks:
                out.write(chunk)
                digest.update(chunk)
                size += len(chunk)
        self.files.append({
            "name": name,
            "size": size,
            "sha256": digest.hexdigest(),
            "method": method,
            "compressed_size": zi.compress_size,
            "crc32": zi.CRC,
            "header_offset": zi.header_offset,
        })

    def add_dir(self, name):
        self.zf.mkdir(name.rstrip("/"))
        self.dirs.append(name.rstrip("/") + "/")


def write_manifest(out_dir, kind, zip_path, builder, extra=None):
    manifest = {
        "kind": kind,
        "archive": zip_path.name,
        "archive_size": zip_path.stat().st_size,
        "files": builder.files,
        "dirs": builder.dirs,
    }
    if extra:
        manifest.update(extra)
    path = out_dir / f"{kind}.manifest.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
    return path


# --------------------------------------------------------------------------------------
# Content generators
# --------------------------------------------------------------------------------------

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike "
         "november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu "
         "invoice shipment ledger account balance transfer customer supplier warehouse pallet").split()


def text_bytes(rng, n):
    """Compressible English-ish text of exactly n bytes."""
    out, size = [], 0
    while size < n:
        line = " ".join(rng.choices(WORDS, k=rng.randint(6, 14))) + "\n"
        out.append(line)
        size += len(line)
    return "".join(out).encode()[:n]


def csv_bytes(rng, n):
    out, size, i = ["id,value,label,score\n"], 22, 0
    while size < n:
        row = f"{i},{rng.randint(0, 10**6)},{rng.choice(WORDS)},{rng.random():.5f}\n"
        out.append(row)
        size += len(row)
        i += 1
    return "".join(out).encode()[:n]


def python_bytes(rng, n):
    out, size, i = [], 0, 0
    while size < n:
        block = f"def func_{i}(x):\n    # {rng.choice(WORDS)} {rng.choice(WORDS)}\n    return x * {rng.randint(1, 99)}\n\n"
        out.append(block)
        size += len(block)
        i += 1
    return "".join(out).encode()[:n]


def small_items(rng):
    """The content of the `small` / `streamed` archives: (name, bytes, method, extra-options)."""
    D, S = zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED
    items = []
    # documents: nested folders, two empty files
    for i in range(60):
        y, q = 2022 + i % 3, 1 + i % 4
        size = 0 if i in (7, 41) else rng.randint(500, 40_000)
        items.append((f"docs/{y}/q{q}/report_{i:03}.txt", text_bytes(rng, size), D, {}))
    # csv shards
    for i in range(60):
        items.append((f"data/shard_{i % 6:02}/part_{i:03}.csv", csv_bytes(rng, rng.randint(2_000, 60_000)), D, {}))
    # random binary blobs, half of them stored
    for i in range(30):
        items.append((f"bin/blob_{i:02}.bin", rng.randbytes(rng.randint(1_000, 50_000)), S if i % 2 else D, {}))
    # python sources
    for i in range(40):
        items.append((f"src/pkg_{i % 4}/sub_{i % 3}/mod_{i:02}.py", python_bytes(rng, rng.randint(300, 6_000)), D, {}))
    # unicode names (Python writes these as UTF-8 + flag bit 11)
    for name in ("unicode/日本語/ファイル.txt", "unicode/café/crème brûlée.md",
                 "unicode/Ελληνικά/κείμενο.txt", "unicode/emoji_😀_file.txt", "unicode/Привет мир.txt"):
        items.append((name, text_bytes(rng, 2_000), D, {}))
    # a name stored as CP437, flag bit 11 clear
    items.append(("legacy/café_cp437.txt", text_bytes(rng, 1_500), D, {"info_cls": Cp437Info}))
    items.append(("weird names/file with spaces (1).txt", text_bytes(rng, 1_000), D, {}))
    items.append(("weird names/dots.in.name.tar.gz.txt", text_bytes(rng, 1_000), D, {}))
    # explicitly stored entries
    items.append(("stored/README_stored.txt", text_bytes(rng, 4_000), S, {}))
    items.append(("stored/binary_stored.bin", rng.randbytes(300_000), S, {}))
    # a few big-ish files so a single Range request spans several MB (room for fault injection)
    items.append(("big/large_text.csv", csv_bytes(rng, 5 * MiB), D, {}))
    items.append(("big/large_random.bin", rng.randbytes(3 * MiB), D, {}))
    items.append(("big/large_stored.bin", rng.randbytes(2 * MiB), S, {}))
    return items


# --------------------------------------------------------------------------------------
# Kinds
# --------------------------------------------------------------------------------------

def make_small(out_dir, seed, streamed=False):
    kind = "streamed" if streamed else "small"
    zip_path = out_dir / f"{kind}.zip"
    rng = random.Random(seed)
    target = Unseekable(zip_path) if streamed else str(zip_path)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        # A non-empty comment means the EOCD is not the last 22 bytes. (A comment containing a fake
        # EOCD signature is covered by a unit test instead: Python's own reader gets that wrong.)
        zf.comment = b"linkunzip test archive"
        b = Builder(zf)
        b.add_dir("empty_dir")
        b.add_dir("docs")
        for n, (name, data, method, opts) in enumerate(small_items(rng)):
            # In the streamed archive, every 5th entry gets a ZIP64 extra in its local header.
            force = streamed and n % 5 == 0
            b.add_file(name, data, method, force_zip64=force, **opts)
    return write_manifest(out_dir, kind, zip_path, b), zip_path


def make_many(out_dir, count):
    zip_path = out_dir / "many.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        b = Builder(zf)
        for i in range(count):
            b.add_file(f"many/d{i % 100:03}/f{i:05}.txt", f"file number {i}\n".encode() * (1 + i % 7))
    return write_manifest(out_dir, "many", zip_path, b), zip_path


def make_zip64(out_dir, seed, big_gib):
    zip_path = out_dir / "zip64.zip"
    rng = random.Random(seed)
    big_size = int(big_gib * GiB)
    need = big_size * 2 + 64 * MiB
    free = shutil.disk_usage(out_dir).free
    if free < need:
        sys.exit(f"Need about {need / GiB:.1f} GiB free in {out_dir} (zip + room for the extraction test), "
                 f"only {free / GiB:.1f} GiB available. Use a smaller --big-gib (>2.0 still triggers ZIP64 in Python).")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        b = Builder(zf)
        b.add_file("zip64/before_1.txt", text_bytes(rng, 5_000))
        b.add_file("zip64/before_2.bin", rng.randbytes(20_000), zipfile.ZIP_STORED)

        def big_chunks():
            left = big_size
            while left > 0:
                n = min(MiB, left)
                yield rng.randbytes(n)  # fresh random data: incompressible, never periodic
                left -= n

        print(f"writing {big_size / GiB:.2f} GiB entry ...", flush=True)
        b.add_file("zip64/big_incompressible.bin", big_chunks(), zipfile.ZIP_STORED, force_zip64=True)
        b.add_file("zip64/after_1.txt", text_bytes(rng, 7_000))
        b.add_file("zip64/after_2.csv", csv_bytes(rng, 300_000))
        b.add_file("zip64/after_3.bin", rng.randbytes(40_000), zipfile.ZIP_STORED)
    return write_manifest(out_dir, "zip64", zip_path, b), zip_path


# ---- demo -----------------------------------------------------------------------------

def _pool(rng, make_row, target=4 * MiB):
    out, size, i = [], 0, 0
    while size < target:
        row = make_row(i)
        out.append(row)
        size += len(row)
        i += 1
    return "".join(out).encode()


def build_pools(rng):
    """4 MiB of realistic, compressible content per file type; files reuse them with unique
    headers and different start offsets (deflate's 32 KB window can't exploit the repetition)."""
    statuses = ["PAID", "PAID", "PAID", "PENDING", "SHIPPED", "REFUNDED", "CANCELLED"]
    countries = ["US", "DE", "FR", "GB", "RO", "PL", "JP", "BR", "CA", "SE"]
    t = [1_700_000_000]

    def csv_row(i):
        t[0] += rng.randint(1, 90)
        return (f"{i},{t[0]},C{rng.randint(1, 200000):06},SKU-{rng.randint(1, 9999):04},{rng.randint(1, 12)},"
                f"{rng.uniform(1, 500):.2f},{rng.choice([0, 0, 0, 5, 10, 15])},{rng.choice(statuses)},{rng.choice(countries)}\n")

    levels = ["INFO", "INFO", "INFO", "INFO", "DEBUG", "WARN", "ERROR"]
    services = ["OrderService", "PaymentGateway", "InventoryClient", "AuthFilter", "CacheManager"]

    def log_row(i):
        t[0] += rng.randint(0, 3)
        ms = rng.randint(0, 999)
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t[0]))
        return (f"{stamp}.{ms:03}Z {rng.choice(levels):<5} [http-nio-8080-exec-{rng.randint(1, 24)}] "
                f"com.example.{rng.choice(services)} - request {rng.randint(1, 10**7)} handled in {rng.randint(1, 900)} ms "
                f"(user=u-{rng.randint(1, 99999)})\n")

    syllables = ["ka", "to", "ri", "me", "su", "na", "lo", "vi", "da", "pe", "gor", "tin", "mar", "sel", "ond"]
    vocab = ["".join(rng.choices(syllables, k=rng.randint(1, 4))) for _ in range(4000)]
    weights = [1.0 / (r + 1) for r in range(len(vocab))]  # Zipf-like word frequencies

    def text_row(i):
        return " ".join(rng.choices(vocab, weights, k=rng.randint(8, 20))).capitalize() + ".\n"

    events = ["click", "view", "purchase", "login", "logout", "search"]

    def json_row(i):
        t[0] += rng.randint(0, 5)
        return (f'{{"ts":{t[0]},"user":"u-{rng.randint(1, 50000)}","event":"{rng.choice(events)}",'
                f'"value":{rng.uniform(0, 100):.3f},"session":"{rng.getrandbits(64):016x}"}}\n')

    return {
        "csv": _pool(rng, csv_row),
        "log": _pool(rng, log_row),
        "txt": _pool(rng, text_row),
        "jsonl": _pool(rng, json_row),
    }


TEXT_KINDS = {  # kind -> (folder, file pattern)
    "csv": ("warehouse/csv", "transactions_{n:04}.csv"),
    "log": ("logs/app", "server-{n:04}.log"),
    "txt": ("corpus/text", "articles_{n:04}.txt"),
    "jsonl": ("export/events", "events_{n:04}.jsonl"),
}


def text_chunks(pool, n, rng, name):
    header = f"# {name}\n".encode()
    yield header
    n -= len(header)
    view, pos = memoryview(pool), rng.randrange(len(pool))
    while n > 0:
        take = min(n, len(pool) - pos, MiB)
        yield view[pos:pos + take]
        n -= take
        pos = (pos + take) % len(pool)


def random_chunks(rng, n):
    while n > 0:
        take = min(n, MiB)
        yield rng.randbytes(take)
        n -= take


def make_demo(out_dir, seed, size_gb, binary_fraction, force):
    zip_path = out_dir / "demo.zip"
    total = int(size_gb * GiB)
    est_zip = int(total * (binary_fraction + (1 - binary_fraction) * 0.3))
    free = shutil.disk_usage(out_dir).free
    print(f"Target: {total / GiB:.1f} GiB extracted, roughly {est_zip / GiB:.1f} GiB zip. "
          f"Free space in {out_dir}: {free / GiB:.1f} GiB.")
    if free < est_zip * 1.05 and not force:
        sys.exit("Not enough free space for the zip. Free some space, use a smaller --size-gb, or pass --force.")

    rng = random.Random(seed)
    pools = build_pools(rng)

    # Decide file sizes (log-normal spread, scaled to hit the total) and which are binary.
    n_files = max(24, int(size_gb * 6))
    weights = [rng.lognormvariate(0, 0.8) for _ in range(n_files)]
    scale = total / sum(weights)
    sizes = [max(64 * 1024, int(w * scale)) for w in weights]
    order = list(range(n_files))
    rng.shuffle(order)
    binary_budget, kinds, text_i, bin_i = binary_fraction * sum(sizes), {}, 0, 0
    text_kind_names = list(TEXT_KINDS)
    for i in order:
        if binary_budget > 0:
            kinds[i] = ("bin_stored" if bin_i % 2 == 0 else "bin_deflate")
            bin_i += 1
            binary_budget -= sizes[i]
        else:
            kinds[i] = text_kind_names[text_i % len(text_kind_names)]
            text_i += 1

    start, written = time.time(), 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, allowZip64=True, compresslevel=1) as zf:
        b = Builder(zf)
        for n, i in enumerate(range(n_files), 1):
            kind, size = kinds[i], sizes[i]
            if kind == "bin_stored":
                name = f"media/raw/capture_{n:04}.bin"
                b.add_file(name, random_chunks(rng, size), zipfile.ZIP_STORED, force_zip64=size > GiB)
            elif kind == "bin_deflate":
                name = f"media/packed/blob_{n:04}.dat"
                b.add_file(name, random_chunks(rng, size), zipfile.ZIP_DEFLATED, level=1, force_zip64=size > GiB)
            else:
                folder, pattern = TEXT_KINDS[kind]
                name = f"{folder}/{pattern.format(n=n)}"
                b.add_file(name, text_chunks(pools[kind], size, rng, name), zipfile.ZIP_DEFLATED, level=1,
                           force_zip64=size > GiB)
            written += size
            elapsed = time.time() - start
            print(f"[{n:3}/{n_files}] {name:<42} {size / MiB:9.1f} MiB   total {written / GiB:6.2f} GiB   {elapsed:6.0f}s",
                  flush=True)
    extra = {"extracted_size": sum(f["size"] for f in b.files)}
    manifest = write_manifest(out_dir, "demo", zip_path, b, extra)
    zsize = zip_path.stat().st_size
    print(f"\nDone in {time.time() - start:.0f}s: {zsize / GiB:.2f} GiB zip, {extra['extracted_size'] / GiB:.2f} GiB extracted "
          f"(ratio {zsize / extra['extracted_size']:.2f}).")
    return manifest, zip_path


# --------------------------------------------------------------------------------------

def main():
    sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kind", choices=["small", "streamed", "many", "zip64", "demo", "all-small"],
                    help="which archive to build; all-small = small + streamed + many")
    ap.add_argument("--out", type=Path, default=Path("test-data"), help="output directory (default: test-data)")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--count", type=int, default=70_000, help="[many] number of files (must exceed 65535)")
    ap.add_argument("--big-gib", type=float, default=4.5, help="[zip64] size of the big entry in GiB")
    ap.add_argument("--size-gb", type=float, default=24.0, help="[demo] total EXTRACTED size in GiB")
    ap.add_argument("--binary-fraction", type=float, default=0.6,
                    help="[demo] share of extracted bytes that is incompressible binary (0.6 gives ~18 GiB of zip for 24 GiB)")
    ap.add_argument("--force", action="store_true", help="[demo] skip the free-space check")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    kinds = ["small", "streamed", "many"] if args.kind == "all-small" else [args.kind]
    for kind in kinds:
        t0 = time.time()
        if kind == "small":
            manifest, zip_path = make_small(args.out, args.seed)
        elif kind == "streamed":
            manifest, zip_path = make_small(args.out, args.seed, streamed=True)
        elif kind == "many":
            manifest, zip_path = make_many(args.out, args.count)
        elif kind == "zip64":
            manifest, zip_path = make_zip64(args.out, args.seed, args.big_gib)
        else:
            manifest, zip_path = make_demo(args.out, args.seed, args.size_gb, args.binary_fraction, args.force)
        print(f"{kind}: {zip_path} ({zip_path.stat().st_size / MiB:.1f} MiB), manifest {manifest}  [{time.time() - t0:.1f}s]")


if __name__ == "__main__":
    main()
