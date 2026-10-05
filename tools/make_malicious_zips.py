#!/usr/bin/env python3
"""Generate hostile ZIP archives to test LinkUnzip's safety checks.

Each archive is deliberately broken or dangerous. LinkUnzip must refuse or neutralise it without
writing outside the output folder. NEVER extract these with other tools you do not trust.

  zipslip.zip      a harmless file plus "../evil.txt" and "..\\..\\evil2.txt" (path traversal)
  absolute.zip     "/abs/evil.txt", "\\\\server\\share\\evil.txt" (absolute / UNC paths)
  drive.zip        "C:\\Windows\\evil.txt" and "C:evil.txt" (drive letters)
  reserved.zip     Windows device names: con, NUL.txt, aux.c, COM1, lpt9.log (plus a normal file)
  badchars.zip     names with : < > | ? * " and trailing dots/spaces
  collide.zip      "Readme.txt" and "README.TXT" (the same file on Windows)
  bomb.zip         DECLARES 1 KiB of output but the deflate stream really expands to --bomb-mib MiB
  bomb_stored.zip  a stored entry whose compressed and uncompressed sizes disagree
  crc.zip          valid data with a wrong CRC-32 in the central directory
  truncated.zip    an entry whose data is cut off (central directory says it is longer)
  overlap.zip      two central directory entries that point at the same local header
  encrypted.zip    an entry with the encryption flag set (+ a normal file)
  bzip2.zip        an entry using an unsupported compression method (+ a normal file)

Usage:
  python tools/make_malicious_zips.py --out test-data/malicious [--bomb-mib 64]

Also writes malicious.manifest.json listing every archive with the expected behaviour.
"""

import argparse
import json
import struct
import sys
import zlib
import zipfile
from pathlib import Path

FIXED_TIME = (2024, 3, 1, 12, 0, 0)


def write_zip(path, entries):
    """entries: list of (name, data[, method]). Python's zipfile does not sanitise names."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for item in entries:
            name, data = item[0], item[1]
            method = item[2] if len(item) > 2 else zipfile.ZIP_DEFLATED
            zi = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            zi.compress_type = method
            # ZipInfo normalises os.sep; keep backslash names exactly as given.
            zi.filename = name
            zf.writestr(zi, data)


def patch_central(path, entry_index, field_offset, fmt, value):
    """Overwrite one field of the Nth central directory record in an existing zip."""
    data = bytearray(path.read_bytes())
    pos = data.rfind(b"PK\x05\x06")
    cd_offset = struct.unpack_from("<I", data, pos + 16)[0]
    p = cd_offset
    for _ in range(entry_index):
        n, m, k = struct.unpack_from("<HHH", data, p + 28)
        p += 46 + n + m + k
    struct.pack_into(fmt, data, p + field_offset, value)
    path.write_bytes(bytes(data))


def patch_local(path, entry_index, field_offset, fmt, value):
    """Overwrite one field of the Nth entry's LOCAL header (found through the central directory)."""
    data = bytearray(path.read_bytes())
    pos = data.rfind(b"PK\x05\x06")
    p = struct.unpack_from("<I", data, pos + 16)[0]
    for _ in range(entry_index):
        n, m, k = struct.unpack_from("<HHH", data, p + 28)
        p += 46 + n + m + k
    local = struct.unpack_from("<I", data, p + 42)[0]
    struct.pack_into(fmt, data, local + field_offset, value)
    path.write_bytes(bytes(data))


def main():
    sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("test-data/malicious"))
    ap.add_argument("--bomb-mib", type=int, default=64, help="real expanded size of bomb.zip's entry")
    args = ap.parse_args()
    out = args.out
    out.mkdir(parents=True, exist_ok=True)
    good = (b"this is a perfectly fine file\n", )
    manifest = {}

    def make(name, entries, expect, **extra):
        path = out / name
        write_zip(path, entries)
        manifest[name] = {"expect": expect, **extra}
        return path

    make("zipslip.zip", [("safe/ok.txt", good[0]), ("../evil.txt", b"pwned"), ("..\\..\\evil2.txt", b"pwned")],
         "rejected", reason="traversal")
    make("absolute.zip", [("ok.txt", good[0]), ("/abs/evil.txt", b"pwned"), ("\\\\server\\share\\evil.txt", b"pwned")],
         "rejected", reason="absolute")
    make("drive.zip", [("ok.txt", good[0]), ("C:\\Windows\\evil.txt", b"pwned"), ("C:evil.txt", b"pwned")],
         "rejected", reason="drive")
    make("reserved.zip", [("normal.txt", b"normal"), ("con", b"c"), ("NUL.txt", b"n"), ("src/aux.c", b"a"),
                          ("COM1", b"1"), ("lpt9.log", b"9")],
         "sanitised", renamed={"con": "_con", "NUL.txt": "_NUL.txt", "src/aux.c": "src/_aux.c", "COM1": "_COM1",
                               "lpt9.log": "_lpt9.log"}, untouched=["normal.txt"])
    make("badchars.zip", [("dir/report: Q1 <draft> | v2?.txt", b"1"), ("dir/star*name.txt", b"2"),
                          ("dir/trailing dot.", b"3"), ("dir/stream.txt:hidden", b"4")],
         "sanitised",
         renamed={"dir/report: Q1 <draft> | v2?.txt": "dir/report_ Q1 _draft_ _ v2_.txt",
                  "dir/star*name.txt": "dir/star_name.txt", "dir/trailing dot.": "dir/trailing dot_",
                  "dir/stream.txt:hidden": "dir/stream.txt_hidden"})
    make("collide.zip", [("Readme.txt", b"one"), ("README.TXT", b"two")], "rejected", reason="same file")

    # bomb: a small file that really expands to --bomb-mib MiB, but whose central directory
    # claims 1 KiB (and whose local header claims it too).
    bomb = out / "bomb.zip"
    real = args.bomb_mib << 20
    write_zip(bomb, [("bomb.bin", bytes(real)), ("ok.txt", good[0])])
    patch_central(bomb, 0, 24, "<I", 1024)  # uncompressed size
    patch_local(bomb, 0, 22, "<I", 1024)
    manifest["bomb.zip"] = {"expect": "fatal", "reason": "expands beyond the declared size",
                            "declared": 1024, "real": real, "zip_size": bomb.stat().st_size}

    # stored entry whose two sizes disagree (a stored entry must have equal sizes)
    sb = out / "bomb_stored.zip"
    write_zip(sb, [("s.bin", b"x" * 5000, zipfile.ZIP_STORED)])
    patch_central(sb, 0, 24, "<I", 10)
    manifest["bomb_stored.zip"] = {"expect": "rejected", "reason": "stored sizes differ"}

    # wrong CRC in the central directory
    crc = out / "crc.zip"
    write_zip(crc, [("a.txt", b"A" * 1000), ("b.txt", b"B" * 1000), ("c.txt", b"C" * 1000)])
    patch_central(crc, 1, 16, "<I", 0xDEADBEEF)
    manifest["crc.zip"] = {"expect": "fatal", "reason": "CRC-32 mismatch", "bad_entry": "b.txt",
                           "good_entries": ["a.txt"]}

    # truncated data: the central directory says the entry is longer than what is stored
    tr = out / "truncated.zip"
    write_zip(tr, [("a.txt", b"A" * 1000, zipfile.ZIP_STORED), ("b.txt", b"B" * 1000, zipfile.ZIP_STORED)])
    patch_central(tr, 0, 20, "<I", 4000)
    patch_central(tr, 0, 24, "<I", 4000)
    manifest["truncated.zip"] = {"expect": "rejected", "reason": "overlaps the next entry"}

    # two central directory entries sharing one local header
    ov = out / "overlap.zip"
    write_zip(ov, [("a.txt", b"A" * 100), ("b.txt", b"B" * 100)])
    data = bytearray(ov.read_bytes())
    pos = data.rfind(b"PK\x05\x06")
    cd = struct.unpack_from("<I", data, pos + 16)[0]
    n, m, k = struct.unpack_from("<HHH", data, cd + 28)
    second = cd + 46 + n + m + k
    struct.pack_into("<I", data, second + 42, struct.unpack_from("<I", data, cd + 42)[0])
    ov.write_bytes(bytes(data))
    manifest["overlap.zip"] = {"expect": "rejected", "reason": "share the same data"}

    # encrypted + unsupported method
    enc = out / "encrypted.zip"
    write_zip(enc, [("ok.txt", good[0]), ("secret.txt", b"top secret")])
    patch_central(enc, 1, 8, "<H", 0x0001)
    manifest["encrypted.zip"] = {"expect": "rejected", "reason": "encrypted", "excluded_ok": "ok.txt"}
    bz = out / "bzip2.zip"
    write_zip(bz, [("ok.txt", good[0]), ("packed.bin", b"data")])
    patch_central(bz, 1, 10, "<H", 12)
    manifest["bzip2.zip"] = {"expect": "rejected", "reason": "compression method 12", "excluded_ok": "ok.txt"}

    with open(out / "malicious.manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    for name in sorted(manifest):
        print(f"{name:<18} {(out / name).stat().st_size:>10} bytes   expect: {manifest[name]['expect']}")


if __name__ == "__main__":
    main()
