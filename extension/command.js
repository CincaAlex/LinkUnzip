// The same extraction as text to paste on another machine (a server, a notebook): a Python
// script that needs nothing but Python 3.8+, a remotezip line for a handful of files, or the
// LinkUnzip command line on Windows. Never a password or a cookie: the script asks for a zip's
// password itself, and a link that needs a login won't work there.

import { fileNameFromUrl, folderNameFor } from "./fmt.js";

/** At most this many files for the remotezip line, and patterns for the helper's. */
const MAX_LISTED = 50;

/** JSON with every non-ASCII character as \uXXXX, so the text survives any shell or code page. */
const asciiJson = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** A POSIX shell word: single quotes, with ' written as '\''. */
const shQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** A Windows word: double quotes work in cmd and PowerShell, unless PowerShell would expand something. */
const winQuote = (s) => (/[$`"%]/.test(s) ? `'${String(s).replaceAll("'", "''")}'` : `"${s}"`);

const PYTHON = String.raw`import getpass, json, os, shutil, sys, urllib.request, zipfile

CONFIG = json.loads(__CONFIG__)
CHUNK = 1 << 20


class HttpFile:
    """A read-only file over HTTP Range requests, so zipfile fetches only what it reads."""

    def __init__(self, url):
        self.url, self.pos, self.buf, self.buf_at = url, 0, b"", 0
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Range": "bytes=0-0"})) as r:
            if r.status != 206:
                sys.exit("The server does not send parts of the file (no Range support).")
            self.size = int(r.headers["Content-Range"].rsplit("/", 1)[1])
            self.etag = r.headers.get("ETag") or r.headers.get("Last-Modified")

    def seekable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = (offset, self.pos + offset, self.size + offset)[whence]
        return self.pos

    def read(self, n=-1):
        end = self.size if n is None or n < 0 else min(self.size, self.pos + n)
        if end <= self.pos:
            return b""
        if not (self.buf_at <= self.pos and end <= self.buf_at + len(self.buf)):
            stop = min(self.size, max(end, self.pos + CHUNK))
            headers = {"Range": "bytes=%d-%d" % (self.pos, stop - 1)}
            if self.etag:
                headers["If-Range"] = self.etag
            with urllib.request.urlopen(urllib.request.Request(self.url, headers=headers)) as r:
                if r.status != 206:
                    sys.exit("The file changed on the server. Run the command again.")
                self.buf, self.buf_at = r.read(), self.pos
        data = self.buf[self.pos - self.buf_at:end - self.buf_at]
        self.pos += len(data)
        return data


def ticked(path, marks):
    """The nearest mark wins: the path's own, else its closest folder's, else the whole zip's."""
    if path in marks:
        return marks[path]
    i = path.rfind("/", 0, len(path) - 1)
    while i > 0:
        if path[:i + 1] in marks:
            return marks[path[:i + 1]]
        i = path.rfind("/", 0, i)
    return marks.get("", True)


def safe_parts(name):
    """The path's parts, or None for an absolute path, a drive letter or a ".." part."""
    parts = [p for p in name.split("/") if p not in ("", ".")]
    if name.startswith("/") or "\0" in name or ".." in parts or not parts:
        return None
    if len(parts[0]) >= 2 and parts[0][1] == ":" and parts[0][0].isalpha():
        return None
    if os.name == "nt":
        parts = ["".join("_" if c in '<>:"|?*' or ord(c) < 32 else c for c in p).rstrip(". ") or "_" for p in parts]
    return parts


def main():
    marks, folder = CONFIG["marks"], CONFIG["folder"]
    zf = zipfile.ZipFile(HttpFile(CONFIG["url"]))
    infos = [(i, i.filename.replace("\\", "/")) for i in zf.infolist()]
    # A zip that holds one folder with the zip's own name goes straight into that folder.
    tops = {p.split("/", 1)[0].lower() for _, p in infos}
    strip = tops == {folder.lower()} and all("/" in p for _, p in infos)
    infos = [(i, p) for i, p in infos if ticked(p, marks)]
    password, done, failed = None, 0, 0
    for info, path in infos:
        parts = safe_parts(path)
        if parts is None:
            print("Skipped (unsafe path): %s" % path)
            failed += 1
            continue
        if strip:
            parts = parts[1:]
        dest = os.path.join(folder, *parts)
        if info.is_dir():
            os.makedirs(dest, exist_ok=True)
            continue
        if info.compress_type == 99:
            print("Skipped (AES-encrypted, which Python's zipfile can't read): %s" % path)
            failed += 1
            continue
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        for attempt in range(3):
            if info.flag_bits & 1 and password is None:
                try:
                    password = getpass.getpass("Password for the zip: ").encode("utf-8")
                except EOFError:
                    password = b""
            try:
                with zf.open(info, pwd=password if info.flag_bits & 1 else None) as src, open(dest + ".part", "wb") as out:
                    shutil.copyfileobj(src, out, CHUNK)
                os.replace(dest + ".part", dest)
                done += 1
                break
            except RuntimeError as e:
                if os.path.exists(dest + ".part"):
                    os.remove(dest + ".part")
                if "password" not in str(e).lower() or attempt == 2:
                    print("Failed: %s (%s)" % (path, e))
                    failed += 1
                    break
                print("Wrong password.")
                password = None
            except (zipfile.BadZipFile, NotImplementedError, OSError) as e:
                if os.path.exists(dest + ".part"):
                    os.remove(dest + ".part")
                print("Failed: %s (%s)" % (path, e))
                failed += 1
                break
    print("%d files extracted into %s" % (done, os.path.abspath(folder)))
    sys.exit(1 if failed else 0)


main()
`;

/**
 * A Python 3.8+ script (standard library only) that extracts the files `marks` selects, straight
 * from `url` with Range requests. `{script, bash, powershell}`: the script, and the script wrapped
 * to paste into a shell.
 */
export function pythonCommand({ url, marks = null, folder = null }) {
  const config = { url, marks: marks || {}, folder: folder || folderNameFor(fileNameFromUrl(url)) };
  const script = PYTHON.replace("__CONFIG__", JSON.stringify(asciiJson(config)));
  return {
    script,
    bash: `python3 - <<'EOF'\n${script}EOF\n`,
    powershell: `@'\n${script}'@ | python -\n`,
  };
}

/** The ticked files when the marks are nothing but files picked one by one, else null. */
export function explicitFiles(marks) {
  if (!marks || marks[""] !== false) return null;
  const files = [];
  for (const [path, on] of Object.entries(marks)) {
    if (path === "" || !on) continue;
    if (path.endsWith("/")) return null;
    files.push(path);
  }
  return files;
}

/** `pip install remotezip` and its command for at most 50 files (`paths`, or files-only `marks`), else null. */
export function remotezipCommand({ url, paths = null, marks = null }) {
  const list = paths || explicitFiles(marks);
  if (!list?.length || list.length > MAX_LISTED) return null;
  return `pip install remotezip\nremotezip ${shQuote(url)} ${list.map(shQuote).join(" ")}\n`;
}

/** `*`, `?` and `[` stand for themselves in a helper pattern when written as `[*]`, `[?]`, `[[]`. */
const globEscape = (path) => path.replace(/[*?[]/g, (c) => `[${c}]`);

/**
 * The --include patterns for `marks`: [] for everything, one pattern per ticked folder or file
 * when the rest of the zip is unticked, null for nothing or for an untick inside a tick (which
 * patterns can't say).
 */
export function includePatterns(marks) {
  const m = Object.entries(marks || {}).filter(([, v]) => typeof v === "boolean");
  const rootOn = (marks || {})[""] !== false;
  if (rootOn) return m.every(([, v]) => v) ? [] : null;
  const on = m.filter(([k, v]) => v && k !== "").map(([k]) => k);
  const under = (path, folder) => folder.endsWith("/") && path !== folder && path.startsWith(folder);
  for (const [k, v] of m) if (!v && k !== "" && on.some((f) => under(k, f))) return null;
  const top = on.filter((k) => !on.some((f) => under(k, f)));
  if (!top.length) return null;
  return top.map((k) => (k.endsWith("/") ? `${globEscape(k)}*` : globEscape(k)));
}

/**
 * `linkunzip extract <url> -o <folder> --include ...` for Windows, when the selection is
 * everything or whole folders and files (`include` as patterns, or `marks`), else null.
 */
export function helperCommand({ url, include = null, marks = null, folder = null }) {
  const patterns = include || includePatterns(marks);
  if (!patterns || patterns.length > MAX_LISTED) return null;
  const out = folder || folderNameFor(fileNameFromUrl(url));
  return ["linkunzip extract", winQuote(url), "-o", winQuote(out), ...patterns.map((p) => `--include ${winQuote(p)}`)].join(" ");
}
