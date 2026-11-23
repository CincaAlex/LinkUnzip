// Small helpers shared by the background worker and the popup.

import { num, t, tn } from "./i18n.js";

/** "1 file", "5,518 files", in the language shown. */
export const files = (n) => tn("{count} file", "{count} files", n);

// Characters that reorder the text around them: `invoice<U+202E>fdp.exe` would show as
// "invoiceexe.pdf". Names from a zip or a server are shown with each one spelled out instead.
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** A name from a zip or a link, safe to show: direction controls made visible as "(U+202E)". */
export const safeName = (name) => String(name).replace(BIDI_CONTROLS, (c) => `(U+${c.charCodeAt(0).toString(16).toUpperCase()})`);

/**
 * Same units as the LinkUnzip CLI and Windows Explorer: 1024-based steps, labelled KB/MB/GB/TB
 * (Ko/Mo/Go/To in French), with the language's own decimal mark.
 */
export function humanBytes(n) {
  if (n == null || Number.isNaN(n)) return "?";
  const units = [t("B"), t("KB"), t("MB"), t("GB"), t("TB")];
  if (n < 1024) return `${num(Math.round(n))} ${units[0]}`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${num(value, unit >= 3 ? 2 : 1)} ${units[unit]}`;
}

/** `1.4 s`, `1 min 23 s`, `2 h 05 min`. */
export function humanDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return t("{s} s", { s: num(s, 1) });
  if (s < 3600) return t("{m} min {s} s", { m: Math.floor(s / 60), s: String(Math.floor(s % 60)).padStart(2, "0") });
  return t("{h} h {m} min", { h: Math.floor(s / 3600), m: String(Math.floor((s % 3600) / 60)).padStart(2, "0") });
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

/** The last part of a path inside the zip: `c.txt` for `a/b/c.txt`. */
export const fileName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** "jpg" for "a/b.JPG"; "" when there is none (".gitignore" has none). */
export function extensionOf(path) {
  const base = fileName(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "a/" -> "", and "" (the whole zip) -> null. */
export function parentOf(path) {
  if (path === "") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
}

/** The site of a link (`example.com:8080`), or "" for something that isn't one. */
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
