// The archive as folders and files for the file list: one folder's contents page by page, a
// search over every path, and the totals of a selection. Same answers as the helper's
// src/browse.rs. Sorted once up front, so a page is a slice even with 100,000+ files in a folder.

import { heldBackType } from "./dl-sink.js";
import { listPath } from "./plan.js";
import { isDir, unsupportedShort } from "./zip.js";

export const MAX_LIMIT = 2000;
/** Keep a reply well under the 64 MB a message may carry, even with absurdly long names. */
const LISTING_BUDGET = 4_000_000;

const fileName = (path) => path.slice(path.lastIndexOf("/") + 1);

/** `{held_back, held_back_types}`: files Chrome's downloads would hold back, most common type first. */
export function heldBack(counts) {
  const types = [...counts].sort((a, b) => b[1] - a[1]).map(([ext]) => ext);
  return { held_back: [...counts.values()].reduce((n, c) => n + c, 0), held_back_types: types };
}
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class Tree {
  constructor(entries) {
    this.entries = entries;
    this.folders = [{ name: "", path: "", parent: -1, folders: [], files: [], files_count: 0, size: 0, compressed: 0 }];
    this.byPath = new Map([["", 0]]);
    this.search = [];
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
        folder.files_count += 1;
        folder.size += entry.usize;
        folder.compressed += entry.csize;
        this.search.push([i, path.toLowerCase()]);
      }
    });
    for (let f = this.folders.length - 1; f >= 1; f--) {
      const folder = this.folders[f];
      const p = this.folders[folder.parent];
      p.files_count += folder.files_count;
      p.size += folder.size;
      p.compressed += folder.compressed;
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
    }
    this.search.sort((a, b) => byKey(a[1], b[1]));
  }

  addFolder(parent, name, path) {
    const index = this.folders.length;
    this.folders.push({ name, path, parent, folders: [], files: [], files_count: 0, size: 0, compressed: 0 });
    this.folders[parent].folders.push(index);
    this.byPath.set(path, index);
    return index;
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

  /** Files whose path contains `query` (case-insensitive), in path order. */
  find(query, limit) {
    const q = query.toLowerCase();
    let total = 0;
    const items = [];
    for (const [i, path] of this.search) {
      if (!path.includes(q)) continue;
      total += 1;
      if (items.length < limit) items.push(this.fileItem(i));
    }
    return { total, items: withinBudget(items) };
  }

  /** What extracting the files `filter` selects would write. */
  measure(filter) {
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

  /** The file entry shown in the list as `path`, or null. */
  entryAt(path) {
    for (const [i] of this.search) if (listPath(this.entries[i].name) === path) return this.entries[i];
    return null;
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
