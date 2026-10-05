// Small helpers shared by the background worker and the popup.

/** Same units as the LinkUnzip CLI and Windows Explorer: 1024-based steps, labelled KB/MB/GB/TB. */
export function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (n < 1024) return `${Math.round(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

/** `1.4s`, `1m 23s`, `2h 05m`. */
export function humanDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** `0:42`, `12:05`, `1:02:03` for ETAs. */
export function clock(secs) {
  if (secs == null) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The last path segment of a URL, decoded; falls back to the host name. */
export function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    // GitHub's "Download ZIP" links end in the branch name; the file you would get is <repo>-<branch>.zip.
    const gh = u.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:zip|archive)\/(?:refs\/(?:heads|tags)\/)?(.+?)(?:\.zip)?$/);
    if (gh && /(^|\.)github\.com$/i.test(u.hostname)) {
      return `${decodeURIComponent(gh[2])}-${decodeURIComponent(gh[3]).replaceAll("/", "-")}.zip`;
    }
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return url;
  }
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** A folder name for the extracted files that Windows accepts: `Blender4.2.zip` -> `Blender4.2`. */
export function folderNameFor(fileName) {
  let name = fileName.replace(/\.zip$/i, "");
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!name) name = "extracted";
  if (RESERVED.test(name.split(".")[0])) name = `_${name}`;
  return name.slice(0, 80);
}

/** `C:\Users\me\Downloads` + `x` -> `C:\Users\me\Downloads\x` (no doubled separators). */
export function joinPath(base, name) {
  return `${base.replace(/[\\/]+$/, "")}\\${name}`;
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** The permission pattern for a link's site: `https://example.com/*` (null for non-web links). */
export function sitePattern(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? `${u.origin}/*` : null;
  } catch {
    return null;
  }
}
