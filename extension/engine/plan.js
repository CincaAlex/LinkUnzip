// Deciding what to extract and which byte ranges to fetch, all before touching the disk. Same
// rules as the helper's src/plan.rs and src/safety.rs:
//
// * Unsafe names are refused before a single byte is written: `..` ("zip slip"), absolute paths,
//   drive letters, NUL bytes.
// * Names Windows can't store are renamed and reported: invalid characters, reserved device names
//   (CON, NUL, COM1, con.txt, ...), trailing dots and spaces.
// * Neighbouring files are grouped into spans, so one Range request fetches a whole run of them.

import { coded, failed } from "./errors.js";
import { LOCAL_FIXED_LEN, isDir, unsupportedReason } from "./zip.js";

/** Selected entries further apart than this go into separate requests. */
export const GAP_THRESHOLD = 1 << 20;
/** Don't cut spans smaller than this just to balance connections. */
export const MIN_SPAN_BYTES = 1 << 20;
/** The resume journal's name: an entry may not take it. */
export const JOURNAL_NAME = ".linkunzip-resume.jsonl";

// ------------------------------------------------------------------------------------------
// Names
// ------------------------------------------------------------------------------------------

/** An entry's path the way the file list shows it: `\` becomes `/`. */
export const listPath = (name) => (name.includes("\\") ? name.replaceAll("\\", "/") : name);

const INVALID = /[<>:"|?*\u0000-\u001f]/g;

function isReserved(stem) {
  const s = stem.toUpperCase();
  if (["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].includes(s)) return true;
  return /^(COM|LPT)[1-9¹²³]$/.test(s);
}

function sanitizeComponent(c) {
  let s = c.replace(INVALID, "_");
  const kept = s.replace(/[. ]+$/, "").length;
  if (kept !== s.length) s = s.slice(0, kept) + "_".repeat(s.length - kept);
  const stem = s.split(".")[0].trimEnd();
  if (isReserved(stem)) s = `_${s}`;
  return s;
}

/** `{parts, path, changed}` for a safe relative path, or throws the reason it must be refused. */
export function sanitizeEntryName(name) {
  if (name.includes("\0")) throw new Error("the name contains a NUL character");
  const unified = name.replaceAll("\\", "/");
  if (unified.startsWith("/")) throw new Error("absolute path (starts with a slash or backslash)");
  const parts = [];
  let changed = false;
  for (const raw of unified.split("/")) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") throw new Error('contains ".." (path traversal)');
    if (parts.length === 0 && /^[A-Za-z]:/.test(raw)) throw new Error('starts with a drive letter (e.g. "C:")');
    const fixed = sanitizeComponent(raw);
    if (fixed !== raw) changed = true;
    parts.push(fixed);
  }
  if (!parts.length) throw new Error("the name is empty");
  if (parts.length === 1 && parts[0].toLowerCase() === JOURNAL_NAME) {
    parts[0] = `_${parts[0]}`;
    changed = true;
  }
  return { parts, path: parts.join("/"), changed };
}

// ------------------------------------------------------------------------------------------
// Selection
// ------------------------------------------------------------------------------------------

/** `*` (crossing `/`), `?` and `[...]` like the helper's --include, case-insensitive. */
function globToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close < 0) throw coded("bad_request", `invalid pattern ${JSON.stringify(pattern)}: unclosed [`);
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "is");
}

function inSet(set, path) {
  if (set.has(path)) return true;
  for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    if (set.has(path.slice(0, i + 1))) return true;
  }
  return false;
}

/** Which entries to extract: patterns (empty = all) and the file list's {paths, exclude}. */
export class Filter {
  constructor(includes = [], select = null) {
    this.includes = includes.filter(Boolean);
    this.patterns = this.includes.map(globToRegExp);
    this.paths = new Set(select?.paths || []);
    this.exclude = new Set(select?.exclude || []);
  }

  matches(name) {
    if (this.patterns.length && !this.patterns.some((p) => p.test(name))) return false;
    if (!this.paths.size && !this.exclude.size) return true;
    const path = listPath(name);
    return (!this.paths.size || inSet(this.paths, path)) && !inSet(this.exclude, path);
  }

  nothingSelected() {
    if (this.paths.size || this.exclude.size) return "nothing in the archive matches the selection";
    if (!this.patterns.length) return "the archive contains no entries";
    return `no entries in the archive match ${this.includes.join(", ")}`;
  }
}

// ------------------------------------------------------------------------------------------
// Checks and spans
// ------------------------------------------------------------------------------------------

function describeProblems(problems) {
  const shown = problems.slice(0, 10).map((p) => `  - ${p}`);
  if (problems.length > 10) shown.push(`  ... and ${problems.length - 10} more`);
  const n = problems.length;
  return `${n} selected entr${n === 1 ? "y" : "ies"} cannot be extracted:\n${shown.join("\n")}\nNothing was written.`;
}

function unsupportedMessage(list) {
  const n = list.length;
  let names = list
    .slice(0, 5)
    .map(([name, reason]) => `${name} (${reason})`)
    .join(", ");
  if (n > 5) names += ` and ${n - 5} more`;
  const count = n === 1 ? "1 of the selected files" : `${n} of the selected files`;
  return `${count} can't be extracted by LinkUnzip: ${names}. Leave ${n === 1 ? "it" : "them"} out and try again.`;
}

/**
 * Select the entries and refuse anything unsafe or unsupported. Returns the files sorted by their
 * position in the archive (each with its safe path and where its region ends), folders to create
 * and every rename.
 */
export function check(index, filter) {
  const problems = [];
  const unsupported = [];
  const files = [];
  const dirs = [];
  const renames = [];
  const taken = new Map(); // lower-cased output path -> entry name

  const offsets = [...new Set([...index.entries.map((e) => e.offset), index.centralDirOffset])].sort((a, b) => a - b);
  const regionEnd = (offset) => {
    let lo = 0;
    let hi = offsets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return offsets[lo];
  };

  for (const entry of index.entries) {
    if (!filter.matches(entry.name)) continue;
    const reason = unsupportedReason(entry);
    if (reason) {
      problems.push(`${entry.name}: ${reason}`);
      unsupported.push([entry.name, reason]);
      continue;
    }
    let safe;
    try {
      safe = sanitizeEntryName(entry.name);
    } catch (e) {
      problems.push(`${JSON.stringify(entry.name)}: unsafe path, ${e.message}`);
      continue;
    }
    if (safe.changed) renames.push([entry.name, safe.path]);
    const key = safe.path.toLowerCase();
    const keys = isDir(entry) ? [key] : [key, `${key}.part`];
    let clash = null;
    for (const k of keys) {
      if (taken.has(k)) clash = taken.get(k);
      taken.set(k, entry.name);
    }
    if (clash != null) {
      problems.push(`${JSON.stringify(entry.name)} and ${JSON.stringify(clash)} would be written to the same file`);
      continue;
    }
    if (isDir(entry)) {
      dirs.push(safe.parts);
      continue;
    }
    const end = regionEnd(entry.offset);
    if (end === undefined || entry.offset + LOCAL_FIXED_LEN + entry.csize > end) {
      problems.push(`${JSON.stringify(entry.name)}: its data overlaps the next entry (corrupt or hostile archive)`);
      continue;
    }
    if (entry.method === 0 && entry.csize !== entry.usize) {
      problems.push(`${JSON.stringify(entry.name)}: stored entry whose compressed and uncompressed sizes differ`);
      continue;
    }
    files.push({ entry, parts: safe.parts, path: safe.path, regionEnd: end });
  }

  if (problems.length) {
    const detail = describeProblems(problems);
    if (unsupported.length === problems.length) {
      throw coded("unsupported_entries", unsupportedMessage(unsupported), { detail });
    }
    throw failed(detail);
  }
  if (!files.length && !dirs.length) throw failed(filter.nothingSelected());
  files.sort((a, b) => a.entry.offset - b.entry.offset);
  for (let i = 1; i < files.length; i++) {
    if (files[i].entry.offset === files[i - 1].entry.offset) {
      throw failed(`${JSON.stringify(files[i - 1].entry.name)} and ${JSON.stringify(files[i].entry.name)} share the same data in the archive (hostile archive)`);
    }
  }
  return { files, dirs, renames };
}

const regionLen = (f) => f.regionEnd - f.entry.offset;

/** Group files (sorted, non-overlapping) into about `jobs` spans, never bridging a big gap. */
export function splitSpans(files, jobs) {
  jobs = Math.max(1, jobs);
  const total = files.reduce((n, f) => n + regionLen(f), 0);
  const spans = [];
  let current = [];
  let currentBytes = 0;
  let closedBytes = 0;
  const close = () => {
    spans.push({ files: current, start: current[0].entry.offset, end: current[current.length - 1].regionEnd - 1 });
    current = [];
  };
  for (const file of files) {
    const prev = current[current.length - 1];
    if (prev) {
      const gap = Math.max(0, file.entry.offset - prev.regionEnd);
      const share = (total * (spans.length + 1)) / jobs;
      const balanced = spans.length + 1 < jobs && currentBytes >= MIN_SPAN_BYTES && closedBytes + currentBytes >= share;
      if (gap > GAP_THRESHOLD || balanced) {
        closedBytes += currentBytes;
        close();
        currentBytes = 0;
      }
    }
    currentBytes += regionLen(file);
    current.push(file);
  }
  if (current.length) close();
  return spans;
}
