#!/usr/bin/env python3
"""Build what a user downloads, into dist/:

    dist/linkunzip-setup.exe            Windows installer: the program + browser registration
    dist/linkunzip-extension-<v>.zip    the extension as the Chrome Web Store wants it (no "key")
    dist/SHA256SUMS.txt                 checksums of both, in `sha256sum -c` format

    python tools/package.py [--skip-build]

The extension IDs allowed to talk to the program are the development ID (derived from the "key"
in extension/manifest.json) plus any in LINKUNZIP_EXTRA_IDS (comma separated), e.g. the Chrome
Web Store and Edge Add-ons IDs once the extension is published there.

Code signing (optional, see docs/signing.md): set LINKUNZIP_SIGN_COMMAND to a command line with
{file} where the file name goes (unquoted: it is quoted for you), e.g.

    signtool sign /fd sha256 /tr http://time.certum.pl /td sha256 /sha1 <thumbprint> {file}

It signs linkunzip.exe before Inno Setup packs it, then Inno Setup runs it on the uninstaller and
the finished setup. The build stops if signing was requested and did not work. Without it the
build is unsigned.

LINKUNZIP_REPO_URL (e.g. https://github.com/CincaAlex/LinkUnzip) sets the publisher, support and
updates links shown in Installed apps; the release workflow sets it.

Needs: Rust (cargo), Inno Setup 6 (winget install JRSoftware.InnoSetup), Python 3.
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
DIST = os.path.join(ROOT, "dist")
STAGE = os.path.join(DIST, "stage")
EXT = os.path.join(ROOT, "extension")
LOCAL = os.environ.get("LOCALAPPDATA", "")
TARGET = os.environ.get("CARGO_TARGET_DIR") or os.path.join(ROOT, "target")
BUNDLED_SETUP = "linkunzip-setup.exe"  # copied into extension/ for unpacked test installs, never into the store zip


def cargo_version():
    with open(os.path.join(ROOT, "Cargo.toml"), encoding="utf-8") as fh:
        m = re.search(r'^version\s*=\s*"([^"]+)"', fh.read(), re.M)
    return m.group(1)


def extension_id(public_key_b64):
    """Chrome's ID for an extension: first 32 hex digits of SHA-256(public key), 0-f mapped to a-p."""
    digest = hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def find_iscc():
    candidates = [
        os.environ.get("ISCC", ""),
        os.path.join(LOCAL, "Programs", "Inno Setup 6", "ISCC.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", ""), "Inno Setup 6", "ISCC.exe"),
        os.path.join(os.environ.get("ProgramFiles", ""), "Inno Setup 6", "ISCC.exe"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    sys.exit("Inno Setup not found: winget install JRSoftware.InnoSetup (or set ISCC=path\\to\\ISCC.exe)")


def sign_command():
    """The signing command from LINKUNZIP_SIGN_COMMAND, or None for an unsigned build."""
    cmd = os.environ.get("LINKUNZIP_SIGN_COMMAND", "").strip()
    if cmd and "{file}" not in cmd:
        sys.exit("LINKUNZIP_SIGN_COMMAND must contain {file} where the file name goes (see docs/signing.md)")
    return cmd or None


def signature_status(path):
    """Windows' verdict on a file's Authenticode signature: Valid, NotSigned, HashMismatch, ..."""
    literal = path.replace("'", "''")
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         f"(Get-AuthenticodeSignature -LiteralPath '{literal}').Status.ToString()"],
        capture_output=True, text=True,
    )
    return out.stdout.strip() or f"unknown ({out.stderr.strip()})"


def check_signed(path):
    name = os.path.relpath(path, ROOT)
    status = signature_status(path)
    if status in ("NotSigned", "HashMismatch", "NotSupportedFileFormat") or status.startswith("unknown"):
        sys.exit(f"signing was requested, but {name} is not properly signed (Windows says: {status})")
    if status != "Valid":
        print(f"  warning: {name} is signed, but Windows doesn't trust the certificate ({status}): "
              "fine for a test certificate, not for a release")


def sign(cmd, path):
    """Sign one file with the LINKUNZIP_SIGN_COMMAND line; stop the build if that fails."""
    # A plain string goes to CreateProcess as it is (no cmd.exe), the way Inno Setup runs it too.
    if subprocess.run(cmd.replace("{file}", f'"{path}"')).returncode != 0:
        sys.exit(f"signing {os.path.relpath(path, ROOT)} failed: check LINKUNZIP_SIGN_COMMAND (docs/signing.md)")
    check_signed(path)


def inno_sign_tool(cmd):
    """The same command in Inno Setup's Sign Tool syntax: $f is the quoted file name, $q a quote."""
    return cmd.replace("$", "$$").replace('"', "$q").replace("{file}", "$f")


def build(version):
    cargo = shutil.which("cargo") or os.path.join(os.path.expanduser("~"), ".cargo", "bin", "cargo.exe")
    env = {**os.environ, "CARGO_TARGET_DIR": TARGET}
    subprocess.run([cargo, "build", "--release"], cwd=ROOT, env=env, check=True)
    exe = os.path.join(TARGET, "release", "linkunzip.exe")
    out = subprocess.run([exe, "--version"], capture_output=True, text=True, check=True).stdout.strip()
    if out != f"linkunzip {version}":
        sys.exit(f"built binary says {out!r}, expected linkunzip {version}")
    return exe


def stage(exe, ids):
    shutil.rmtree(STAGE, ignore_errors=True)
    os.makedirs(STAGE)
    shutil.copy2(exe, os.path.join(STAGE, "linkunzip.exe"))
    manifest = {
        "name": "com.linkunzip.host",
        "description": "LinkUnzip: extract a ZIP straight from a URL without saving the ZIP",
        # Relative to this file: Chrome on Windows resolves it next to the manifest.
        "path": "linkunzip.exe",
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{i}/" for i in ids],
    }
    with open(os.path.join(STAGE, "com.linkunzip.host.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)


def installer(version, sign_cmd):
    iss = os.path.join(ROOT, "installer", "linkunzip.iss")
    args = [find_iscc(), "/Q", f"/DAppVersion={version}", f"/DStageDir={STAGE}"]
    repo = os.environ.get("LINKUNZIP_REPO_URL", "").strip().rstrip("/")
    if repo:
        args.append(f"/DRepoUrl={repo}")
    if sign_cmd:
        # Inno Setup signs the uninstaller it generates and then the finished setup.
        args += [f"/Slinkunzipsign={inno_sign_tool(sign_cmd)}", "/DSign"]
    if subprocess.run(args + [iss]).returncode != 0:
        sys.exit("Inno Setup failed" + (" (while signing? see its message above)" if sign_cmd else ""))
    setup = os.path.join(DIST, "linkunzip-setup.exe")
    if sign_cmd:
        check_signed(setup)
    return setup


def store_zip(version):
    """The extension without the development "key" (the store assigns its own ID)."""
    with open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as fh:
        manifest = json.load(fh)
    manifest.pop("key", None)
    path = os.path.join(DIST, f"linkunzip-extension-{version}.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for folder, _, files in os.walk(EXT):
            for name in sorted(files):
                full = os.path.join(folder, name)
                rel = os.path.relpath(full, EXT).replace(os.sep, "/")
                if rel in ("README.md", BUNDLED_SETUP):
                    continue
                if rel == "manifest.json":
                    z.writestr(rel, json.dumps(manifest, indent=2) + "\n")
                else:
                    z.write(full, rel)
        z.write(os.path.join(ROOT, "LICENSE"), "LICENSE.txt")
    return path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def checksums(paths):
    """SHA256SUMS.txt next to the files, in the format `sha256sum -c` reads."""
    out = os.path.join(DIST, "SHA256SUMS.txt")
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        for p in paths:
            fh.write(f"{sha256(p)}  {os.path.basename(p)}\n")
    return out


def describe(path):
    size = os.path.getsize(path)
    print(f"  {os.path.relpath(path, ROOT):<38} {size / 1e6:6.2f} MB  sha256 {sha256(path)[:16]}...")


def main():
    version = cargo_version()
    with open(os.path.join(EXT, "manifest.json"), encoding="utf-8") as fh:
        ext_manifest = json.load(fh)
    if ext_manifest["version"] != version:
        sys.exit(f"extension/manifest.json is version {ext_manifest['version']}, Cargo.toml is {version}")
    ids = [extension_id(ext_manifest["key"])]
    ids += [i.strip() for i in os.environ.get("LINKUNZIP_EXTRA_IDS", "").split(",") if i.strip()]
    sign_cmd = sign_command()

    if "--skip-build" in sys.argv:
        exe = os.path.join(TARGET, "release", "linkunzip.exe")
    else:
        exe = build(version)
    stage(exe, ids)
    if sign_cmd:
        sign(sign_cmd, os.path.join(STAGE, "linkunzip.exe"))
    setup = installer(version, sign_cmd)
    # The unpacked (test) extension offers this copy on its setup page while DOWNLOAD_URL is empty.
    shutil.copy2(setup, os.path.join(EXT, BUNDLED_SETUP))
    ext_zip = store_zip(version)
    sums = checksums([setup, ext_zip])
    print(f"LinkUnzip {version}, {'signed' if sign_cmd else 'unsigned'}  (extension ids: {', '.join(ids)})")
    describe(setup)
    describe(ext_zip)
    print(f"  {os.path.relpath(sums, ROOT)}")


if __name__ == "__main__":
    main()
