#!/usr/bin/env python3
"""Verify an extracted folder against a manifest written by make_test_zips.py.

Checks, for every file in the manifest: it exists, has the right size, and has the right SHA-256.
Also reports files that should not be there (including leftover *.part files).

    python tools/verify_extract.py Z:\\demo D:\\demo\\demo.manifest.json

If you extracted only part of the archive (linkunzip --include ...), pass the same patterns with
--only so just those files are expected:

    python tools/verify_extract.py Z:\\demo D:\\demo\\demo.manifest.json --only "logs/*" --only "*.csv"

Patterns match like LinkUnzip's --include: case-insensitive, and `*` also matches `/`.
Hashing 24 GB takes a few minutes; it uses all CPU cores. Exit code 0 = everything matches.
"""

import argparse
import fnmatch
import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb", buffering=0) as f:
        while chunk := f.read(8 << 20):
            h.update(chunk)
    return h.hexdigest()


def main():
    sys.stdout.reconfigure(errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", type=Path, help="the extracted folder")
    ap.add_argument("manifest", type=Path, help="<kind>.manifest.json from make_test_zips.py")
    ap.add_argument("--only", action="append", default=[], metavar="GLOB",
                    help="expect only manifest files matching this pattern (repeatable); use with --include")
    ap.add_argument("--threads", type=int, default=os.cpu_count() or 4)
    args = ap.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    files = manifest["files"]
    if args.only:
        pats = [p.lower() for p in args.only]
        files = [f for f in files if any(fnmatch.fnmatchcase(f["name"].lower(), p) for p in pats)]
        if not files:
            sys.exit("no manifest files match --only")
    expected = {f["name"] for f in files}
    total = sum(f["size"] for f in files)
    print(f"Verifying {len(files)} files ({total / (1 << 30):.2f} GiB) in {args.folder} ...", flush=True)

    problems = []
    # Extra files first (cheap): anything on disk that is not in the manifest.
    for root, _, names in os.walk(args.folder):
        for n in names:
            rel = Path(root, n).relative_to(args.folder).as_posix()
            if rel not in expected:
                problems.append(f"unexpected file: {rel}")

    done_bytes = 0
    start = time.time()

    def check(f):
        path = args.folder / f["name"]
        if not path.is_file():
            return f"missing: {f['name']}"
        size = path.stat().st_size
        if size != f["size"]:
            return f"wrong size: {f['name']} ({size} instead of {f['size']})"
        if sha256_of(path) != f["sha256"]:
            return f"SHA-256 mismatch: {f['name']}"
        return None

    with ThreadPoolExecutor(args.threads) as pool:
        for f, problem in zip(files, pool.map(check, files)):
            done_bytes += f["size"]
            if problem:
                problems.append(problem)
            print(f"\r  {done_bytes / (1 << 30):6.2f} / {total / (1 << 30):.2f} GiB  {time.time() - start:5.0f}s", end="", flush=True)
    print()

    if problems:
        print(f"FAILED: {len(problems)} problem(s)")
        for p in problems[:20]:
            print("  -", p)
        sys.exit(1)
    print(f"OK: all {len(files)} files match the originals (size + SHA-256), nothing extra, no .part leftovers.")


if __name__ == "__main__":
    main()
