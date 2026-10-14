// Saving through Chrome's own downloads, into Downloads/<folder>/... Nothing to pick and nothing
// to allow, but Chrome handles each file like any download (it names it, checks it, records it),
// which takes a moment per file: zips with a few big files don't notice, zips with thousands of
// small ones do (a folder the user picked is much faster for those).
//
// Each file is checked (size and CRC-32) before Chrome gets it, and Chrome only gives a file its
// real name once all of it is written, so a file that didn't check out never appears.

import { Coded } from "./errors.js";

/** Files Chrome saves at the same time: more than this doesn't go faster. */
const MAX_SAVING = 8;
/** Finished files waiting for Chrome, in bytes: beyond this reading the zip pauses. */
const MAX_WAITING = 256 << 20;
/** Data collected into one piece of the file's blob at a time. */
const PIECE = 8 << 20;

// Names Chrome's downloads refuse (net::IsSafePortablePathComponent): `~`, control and format
// characters anywhere; spaces or dots at either end (so `.gitignore`); shell extensions like
// .lnk; and a few names Windows treats specially.
const BAD_ANYWHERE = /[~\p{Cc}\p{Cf}]/gu;
const SHELL_EXTENSIONS = new Set(["lnk", "local", "scf", "url"]);
const MAGIC_NAMES = new Set(["desktop.ini", "thumbs.db"]);
const DEVICES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i;

function downloadsComponent(c) {
  let s = c.replace(BAD_ANYWHERE, "_");
  if (/^[\s.]/u.test(s)) s = `_${s}`;
  if (/[\s.]$/u.test(s)) s = `${s}_`;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 ? s.slice(dot + 1).toLowerCase() : "";
  if (SHELL_EXTENSIONS.has(ext) || /^\{.*\}$/.test(ext)) s = `${s}_`;
  if (MAGIC_NAMES.has(s.toLowerCase()) || DEVICES.test(s)) s = `_${s}`;
  return s;
}

// Types Chrome's downloads hold back until the user clicks Keep on each file (measured in Chrome
// 155 on Windows; .exe, .msi, .bat or .ps1 go through). A folder the user picked doesn't ask.
const HELD_BACK = new Set(["dll", "ini", "cfg", "manifest", "crx", "jse", "wsf", "cpl"]);

/** The extension of `name` if Chrome's downloads hold such files back, else "". */
export function heldBackType(name) {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  return HELD_BACK.has(ext) ? ext : "";
}

/** The path as Chrome's downloads take it, and whether it had to change. */
export function downloadsName(parts) {
  const fixed = parts.map(downloadsComponent);
  return { parts: fixed, changed: fixed.some((p, i) => p !== parts[i]) };
}

/** Only letters, digits and a few safe signs: for a name Chrome refused anyway. */
const strictName = (parts) => downloadsName(parts.map((p) => p.replace(/[^\p{L}\p{N} _.()[\]-]/gu, "_"))).parts;

/**
 * A sink into `Downloads/<sub>`. `save({url, filename, path})` asks the background to download
 * the blob URL and answers `{ok, held, code, error}`; `saved` (path -> "crc:size") remembers what
 * was saved before, so Resume can skip it.
 */
export function downloadsSink({ sub, label, save, saved }) {
  const renames = [];
  const held = [];
  let saving = 0;
  let waitingBytes = 0;
  let firstDone = false;
  const wakers = new Set();
  const wake = () => {
    for (const w of [...wakers]) w();
  };
  const nextWake = () =>
    new Promise((resolve) => {
      const w = () => {
        wakers.delete(w);
        resolve();
      };
      wakers.add(w);
    });

  async function saveBlob(blob, parts, entry) {
    const path = parts.join("/");
    let name = downloadsName(parts);
    // Until one file got through, one at a time: if Chrome is set to ask where to save each
    // file, it asks once, not eight times. (No await between the check and taking the place.)
    while (saving >= (firstDone ? MAX_SAVING : 1)) await nextWake();
    saving += 1;
    const url = URL.createObjectURL(blob);
    try {
      let r = await save({ url, filename: `${sub}/${name.parts.join("/")}`, path });
      if (r.code === "bad_name") {
        name = { parts: strictName(parts), changed: true };
        r = await save({ url, filename: `${sub}/${name.parts.join("/")}`, path });
      }
      if (r.code === "transient") r = await save({ url, filename: `${sub}/${name.parts.join("/")}`, path });
      if (!r.ok) throw fromSave(r, path);
      if (name.changed) renames.push([path, name.parts.join("/")]);
      if (r.held) held.push({ name: path, why: r.held, id: r.downloadId });
      else saved.set(path, `${entry.crc}:${entry.usize}`);
      firstDone = true;
    } finally {
      saving -= 1;
      URL.revokeObjectURL(url);
      wake();
    }
  }

  return {
    label,
    renames,
    held,

    // Chrome makes the folders a file needs; empty folders aren't kept.
    async mkdir() {},

    async create(parts, entry) {
      const pieces = [];
      let chunks = [];
      let buffered = 0;
      let size = 0;
      const fold = () => {
        if (!chunks.length) return;
        pieces.push(new Blob(chunks));
        chunks = [];
        buffered = 0;
      };
      return {
        async write(chunk) {
          // Many finished files still waiting for Chrome: let it catch up first.
          while (waitingBytes > MAX_WAITING) await nextWake();
          chunks.push(chunk);
          buffered += chunk.length;
          size += chunk.length;
          if (buffered >= PIECE) fold();
        },
        async close() {
          fold();
          // Without a type Chrome sniffs one and "fixes" the extension (data.csv -> data.txt).
          const blob = new Blob(pieces, { type: "application/octet-stream" });
          pieces.length = 0;
          waitingBytes += size;
          try {
            await saveBlob(blob, parts, entry);
          } finally {
            waitingBytes -= size;
            wake();
          }
        },
        async abort() {
          pieces.length = 0;
          chunks = [];
        },
      };
    },

    // Resume: Chrome's downloads can't be read back, so only what this page saved earlier counts.
    isDone(parts, entry) {
      return saved.get(parts.join("/")) === `${entry.crc}:${entry.usize}`;
    },
  };
}

function fromSave(r, path) {
  const detail = `${path}: ${r.error || r.code}`;
  switch (r.code) {
    case "ask_where":
      return new Coded("ask_where", "Chrome is set to ask where to save each download.", { detail });
    case "disk_full":
      return new Coded("disk_full", "The drive is full.", { detail });
    case "bad_name":
      return new Coded("folder_not_writable", `Chrome's downloads didn't accept the name ${path}.`, { detail });
    default:
      return new Coded("folder_not_writable", `Chrome couldn't save ${path} into Downloads.`, { detail });
  }
}
