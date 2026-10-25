// The archive as folders and files for the file list: one folder's contents page by page, a
// search over every path, and the totals of a selection. Same answers as the helper's
// src/browse.rs. Sorted once up front, so a page is a slice even with 100,000+ files in a folder.
//
// Every folder also carries the totals of everything under it, so the totals of a selection add
// up whole folders and only look at single files where a tick inside differs.

import { heldBackType } from "./dl-sink.js";
import { globToRegExp, listPath, nearestMark } from "./plan.js";
import { isDir, unsupportedShort } from "./zip.js";

export const MAX_LIMIT = 2000;
/** Keep a reply well under the 64 MB a message may carry, even with absurdly long names. */
const LISTING_BUDGET = 4_000_000;
/** File types listed for the search chips. */
const TOP_EXTENSIONS = 6;

const fileName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** `{held_back, held_back_types}`: files Chrome's downloads would hold back, most common type first. */
export function heldBack(counts) {
  const types = [...counts].sort((a, b) => b[1] - a[1]).map(([ext]) => ext);
  return { held_back: [...counts.values()].reduce((n, c) => n + c, 0), held_back_types: types };
}
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** "jpg" for "a/b.JPG"; "" without one. */
function extensionOf(path) {
  const base = fileName(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** A search as the file list types it: `*.jpg`-style patterns, or text anywhere in the path. */
export function matcher(query) {
  const q = query.trim().toLowerCase();
  if (/[*?[]/.test(q)) {
    const re = globToRegExp(q);
    return (lower) => re.test(lower);
  }
  return (lower) => lower.includes(q);
}

/** Every folder that has `path` somewhere under it ("" for anything but the whole zip itself). */
function addParents(set, path) {
  for (let i = path.lastIndexOf("/", path.length - 2); i > 0; i = path.lastIndexOf("/", i - 1)) set.add(path.slice(0, i + 1));
  if (path !== "") set.add("");
}

export class Tree {
  constructor(entries) {
    this.entries = entries;
    this.folders = [this.newFolder("", "", -1)];
    this.byPath = new Map([["", 0]]);
    this.fileIndex = new Map(); // list path -> entry index
    this.folderOf = new Int32Array(entries.length).fill(-1);
    this.posInFolder = new Int32Array(entries.length).fill(-1);
    this.search = [];
    const exts = new Map();
    entries.forEach((entry, i) => {
      const path = listPath(entry.name);
      const dir = isDir(entry);
      const folderPart = dir ? path : path.slice(0, path.lastIndexOf("/") + 1);
      let current = 0;
      let start = 0;
      for (let slash = folderPart.indexOf("/"); slash >= 0; slash = folderPart.indexOf("/", slash + 1)) {
        const folderPath = folderPart.slice(0, slash + 1);
        let f = this.byPath.get(folderPath);
        if (f === undefined) f = this.addFolder(current, folderPart.slice(start, slash), folderPath);
        current = f;
        start = slash + 1;
      }
      if (!dir) {
        const folder = this.folders[current];
        folder.files.push(i);
        this.countFile(folder, entry);
        this.folderOf[i] = current;
        if (!this.fileIndex.has(path)) this.fileIndex.set(path, i);
        this.search.push([i, path.toLowerCase()]);
        const ext = extensionOf(path);
        if (ext) exts.set(ext, (exts.get(ext) || 0) + 1);
      }
    });
    // Parents come before their children, so this adds every folder into its parent in time.
    for (let f = this.folders.length - 1; f >= 1; f--) {
      const folder = this.folders[f];
      const p = this.folders[folder.parent];
      p.files_count += folder.files_count;
      p.size += folder.size;
      p.compressed += folder.compressed;
      p.unsupported += folder.unsupported;
      if (folder.held) for (const [ext, n] of Object.entries(folder.held)) this.addHeld(p, ext, n);
    }
    const folderKeys = this.folders.map((f) => f.name.toLowerCase());
    const fileKeys = new Map();
    const fileKey = (i) => {
      let k = fileKeys.get(i);
      if (k === undefined) fileKeys.set(i, (k = fileName(listPath(entries[i].name)).toLowerCase()));
      return k;
    };
    for (const folder of this.folders) {
      folder.folders.sort((a, b) => byKey(folderKeys[a], folderKeys[b]));
      folder.files.sort((a, b) => byKey(fileKey(a), fileKey(b)));
      folder.files.forEach((i, k) => (this.posInFolder[i] = k));
    }
    this.search.sort((a, b) => byKey(a[1], b[1]));
    this.extensions = [...exts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_EXTENSIONS)
      .map(([ext, files]) => ({ ext, files }));
  }

  newFolder(name, path, parent) {
    return { name, path, parent, folders: [], files: [], files_count: 0, size: 0, compressed: 0, unsupported: 0, held: null };
  }

  addFolder(parent, name, path) {
    const index = this.folders.length;
    this.folders.push(this.newFolder(name, path, parent));
    this.folders[parent].folders.push(index);
    this.byPath.set(path, index);
    return index;
  }

  addHeld(folder, ext, n) {
    folder.held ??= {};
    folder.held[ext] = (folder.held[ext] || 0) + n;
  }

  countFile(folder, entry) {
    folder.files_count += 1;
    folder.size += entry.usize;
    folder.compressed += entry.csize;
    if (unsupportedShort(entry)) folder.unsupported += 1;
    const ext = heldBackType(entry.name);
    if (ext) this.addHeld(folder, ext, 1);
  }

  /** Folders, the implied ones included (the root does not count). */
  get folderCount() {
    return this.folders.length - 1;
  }

  /** One page of folder `dir`: folders first, then files. null if there is no such folder. */
  list(dir, offset, limit) {
    const f = this.byPath.get(dir);
    if (f === undefined) return null;
    const folder = this.folders[f];
    const subs = folder.folders.length;
    const total = subs + folder.files.length;
    const end = Math.min(total, offset + Math.min(limit, MAX_LIMIT));
    const items = [];
    for (let k = Math.min(offset, end); k < end; k++) {
      items.push(k < subs ? this.folderItem(folder.folders[k]) : this.fileItem(folder.files[k - subs]));
    }
    return { dir, offset, total, items: withinBudget(items) };
  }

  /** Files whose path contains `query`, or matches it as a pattern (`*.jpg`), in path order. */
  find(query, limit) {
    const test = matcher(query);
    let total = 0;
    const items = [];
    for (const [i, path] of this.search) {
      if (!test(path)) continue;
      total += 1;
      if (items.length < limit) items.push(this.fileItem(i));
    }
    return { total, items: withinBudget(items) };
  }

  /** What extracting the files `filter` selects would write. */
  measure(filter) {
    if (filter.marksOnly) return this.measureMarks(filter.marks || new Map());
    const m = { files: 0, extracted: 0, compressed: 0, unsupported: 0 };
    const held = new Map();
    for (const e of this.entries) {
      if (isDir(e) || !filter.matches(e.name)) continue;
      m.files += 1;
      m.extracted += e.usize;
      m.compressed += e.csize;
      if (unsupportedShort(e)) m.unsupported += 1;
      const ext = heldBackType(e.name);
      if (ext) held.set(ext, (held.get(ext) || 0) + 1);
    }
    return { ...m, ...heldBack(held) };
  }

  /** The same totals for ticks alone, a whole folder at a time where nothing inside differs. */
  measureMarks(marks) {
    const m = { files: 0, extracted: 0, compressed: 0, unsupported: 0 };
    const held = new Map();
    const addHeld = (ext, n) => held.set(ext, (held.get(ext) || 0) + n);
    const inside = new Set();
    for (const k of marks.keys()) addParents(inside, k);
    const stack = [[0, marks.has("") ? marks.get("") : true]];
    while (stack.length) {
      const [f, inherited] = stack.pop();
      const folder = this.folders[f];
      const state = f !== 0 && marks.has(folder.path) ? marks.get(folder.path) : inherited;
      if (!inside.has(folder.path)) {
        if (!state) continue;
        m.files += folder.files_count;
        m.extracted += folder.size;
        m.compressed += folder.compressed;
        m.unsupported += folder.unsupported;
        if (folder.held) for (const [ext, n] of Object.entries(folder.held)) addHeld(ext, n);
        continue;
      }
      for (const sub of folder.folders) stack.push([sub, state]);
      for (const i of folder.files) {
        const e = this.entries[i];
        const path = listPath(e.name);
        if (!(marks.has(path) ? marks.get(path) : state)) continue;
        m.files += 1;
        m.extracted += e.usize;
        m.compressed += e.csize;
        if (unsupportedShort(e)) m.unsupported += 1;
        const ext = heldBackType(e.name);
        if (ext) addHeld(ext, 1);
      }
    }
    return { ...m, ...heldBack(held) };
  }

  /**
   * Tick (or untick) every file the search `query` finds, on top of `marks`, and say the result
   * with as few marks as possible: a folder whose files all end up the same gets one mark, and
   * inside a mixed folder the files that differ from most of it get their own.
   */
  tickMatches(marksObject, query, ticked) {
    const marks = new Map(Object.entries(marksObject || {}).filter(([, v]) => typeof v === "boolean"));
    const test = matcher(query);
    const on = new Uint8Array(this.entries.length);
    let matched = 0;
    for (const [i, lower] of this.search) {
      if (test(lower)) {
        matched += 1;
        on[i] = ticked ? 1 : 0;
      } else {
        on[i] = nearestMark(marks, listPath(this.entries[i].name)) ? 1 : 0;
      }
    }
    // Ticked files under each folder, children before parents.
    const onCount = new Float64Array(this.folders.length);
    for (let f = this.folders.length - 1; f >= 0; f--) {
      const folder = this.folders[f];
      for (const i of folder.files) onCount[f] += on[i];
      if (f > 0) onCount[folder.parent] += onCount[f];
    }
    const out = {};
    const stack = [[0, true]];
    while (stack.length) {
      const [f, inherited] = stack.pop();
      const folder = this.folders[f];
      const total = folder.files_count;
      if (!total) {
        // An empty folder keeps what it was.
        const was = nearestMark(marks, folder.path);
        if (was !== inherited) out[folder.path] = was;
        continue;
      }
      const state = onCount[f] * 2 >= total;
      if (state !== inherited) out[folder.path] = state;
      if (onCount[f] === 0 || onCount[f] === total) continue;
      for (const sub of folder.folders) stack.push([sub, state]);
      for (const i of folder.files) if (Boolean(on[i]) !== state) out[listPath(this.entries[i].name)] = Boolean(on[i]);
    }
    return { marks: out, matched };
  }

  /** The file entry shown in the list as `path`, or null. */
  entryAt(path) {
    const i = this.fileIndex.get(path);
    return i === undefined ? null : this.entries[i];
  }

  /** The files before and after `path` in its folder (ones LinkUnzip can read), for Prev / Next. */
  neighbors(path) {
    const i = this.fileIndex.get(path);
    if (i === undefined) return null;
    const files = this.folders[this.folderOf[i]].files;
    const at = this.posInFolder[i];
    const step = (dir) => {
      for (let k = at + dir; k >= 0 && k < files.length; k += dir) {
        const e = this.entries[files[k]];
        if (!unsupportedShort(e)) return listPath(e.name);
      }
      return null;
    };
    return { prev: step(-1), next: step(1), position: at + 1, total: files.length };
  }

  folderItem(f) {
    const folder = this.folders[f];
    return { name: folder.name, path: folder.path, dir: true, size: folder.size, compressed: folder.compressed, files: folder.files_count };
  }

  fileItem(i) {
    const e = this.entries[i];
    const path = listPath(e.name);
    return { name: fileName(path), path, dir: false, size: e.usize, compressed: e.csize, unsupported: unsupportedShort(e) };
  }
}

function withinBudget(items) {
  let used = 0;
  const kept = [];
  for (const item of items) {
    used += item.name.length * 2 + item.path.length * 2 + 120;
    if (used > LISTING_BUDGET) break;
    kept.push(item);
  }
  return kept;
}
