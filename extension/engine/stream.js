// One pass over a zip, from its first byte to its last, for servers that can't send parts of a
// file: GitHub's "Download ZIP" builds the zip while it sends it, so the index at the end can't be
// read first. Same rules as the helper's src/stream.rs:
//
// * one connection; no file list, total size or preview before it starts;
// * entries are read from their local headers. One written "streaming style" (flag bit 3) has its
//   sizes in a data descriptor after the data: a deflate one is inflated until its own end marker
//   (pako's inflater says where that is; the browser's DecompressionStream can't), a stored one
//   ends where a data descriptor matches the CRC-32 and size of everything read so far;
// * unsafe names are noticed when they arrive, so files before them may already be written;
// * a dropped connection starts the download again from the first byte and skips what is done;
// * at the end the central directory is read as well, and compared with what was extracted.

import { Inflate } from "../vendor/pako-inflate.js";
import { crc32 } from "./crc32.js";
import { checksCrc, parseAesExtra, realMethod } from "./crypto.js";
import { decryptorFor, entryChunks } from "./entry.js";
import { Coded, coded, failed, isTransient, transient } from "./errors.js";
import { sameFolder, sanitizeEntryName, topOf, withoutTop } from "./plan.js";
import { RETRY, delayAfter, openWhole, sleep } from "./source.js";
import { LOCAL_SIG, METHOD_DEFLATE, METHOD_STORED, decodeName, isDir, isEncrypted, looksLikeHtml, parseCentralDirectory, unsupportedReason } from "./zip.js";

const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const DESCRIPTOR_SIG = 0x08074b50;
const FLAG_DESCRIPTOR = 1 << 3;
const CHUNK = 1 << 20;
/** A stored entry of unknown length is searched for its data descriptor this much at a time. */
const SCAN = 64 * 1024;
/** Input handed to the inflater at a time (what it doesn't use stays for the next entry). */
const INFLATE_IN = 64 * 1024;
const PROGRESS_MS = 250;
/** With no size to hold an entry to: more than this much output per input byte, past 1 GB, is a bomb. */
const MAX_RATIO = 1000;
const RATIO_FROM = 1 << 30;
/** A central directory bigger than this isn't compared at the end. */
const MAX_LISTING = 64 << 20;

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u32 = (b, o) => view(b).getUint32(o, true);

function u64(dv, o) {
  const v = dv.getBigUint64(o, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw failed("a size in the zip is too large");
  return Number(v);
}

/**
 * The response body with look-ahead: `peek` without consuming, `next` / `readExact` / `skip` /
 * `consume` to move on. Same `next` and `readExact` as ByteReader, so entryChunks reads from it.
 */
class Input {
  constructor(body, onBytes) {
    this.reader = body.getReader();
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.pos = 0;
    this.eof = false;
    this.onBytes = onBytes;
  }

  get available() {
    return this.buf.length - this.off;
  }

  async fill() {
    let r;
    try {
      r = await this.reader.read();
    } catch (e) {
      if (e?.name === "AbortError" || e instanceof Coded) throw e;
      throw transient(`the connection dropped: ${e?.message || e}`);
    }
    if (r.done) {
      this.eof = true;
      return;
    }
    this.onBytes(r.value.length);
    const rest = this.buf.subarray(this.off);
    if (!rest.length) this.buf = r.value;
    else {
      // A new array: views handed out earlier keep their bytes.
      const joined = new Uint8Array(rest.length + r.value.length);
      joined.set(rest);
      joined.set(r.value, rest.length);
      this.buf = joined;
    }
    this.off = 0;
  }

  /** Up to `n` upcoming bytes without consuming them (fewer only at the end of the body). */
  async peek(n) {
    while (this.available < n && !this.eof) await this.fill();
    return this.buf.subarray(this.off, this.off + Math.min(n, this.available));
  }

  consume(n) {
    this.off += n;
    this.pos += n;
  }

  async next(max) {
    while (!this.available) {
      if (this.eof) throw transient("the download ended before the end of the archive");
      await this.fill();
    }
    const n = Math.min(max, this.available);
    const out = this.buf.subarray(this.off, this.off + n);
    this.consume(n);
    return out;
  }

  async readExact(n) {
    const out = new Uint8Array(n);
    let got = 0;
    while (got < n) {
      const part = await this.next(n - got);
      out.set(part, got);
      got += part.length;
    }
    return out;
  }

  async skip(n) {
    while (n > 0) n -= (await this.next(Math.min(n, CHUNK))).length;
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

// ------------------------------------------------------------------------------------------
// Local headers and data descriptors
// ------------------------------------------------------------------------------------------

/** Sizes with ZIP64's 64-bit values where the 32-bit fields say 0xFFFFFFFF. */
function localSizes(extra, comp32, uncomp32) {
  const dv = view(extra);
  for (let pos = 0; pos + 4 <= extra.length; ) {
    const id = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (pos + 4 + len > extra.length) throw failed("extra field block is truncated");
    if (id === 0x0001) {
      let at = pos + 4;
      const end = at + len;
      let usize = uncomp32;
      let csize = comp32;
      if (uncomp32 === 0xffffffff && at + 8 <= end) {
        usize = u64(dv, at);
        at += 8;
      }
      if (comp32 === 0xffffffff && at + 8 <= end) csize = u64(dv, at);
      return { csize, usize, zip64: true };
    }
    pos += 4 + len;
  }
  return { csize: comp32, usize: uncomp32, zip64: false };
}

async function readHeader(input) {
  const offset = input.pos;
  const fixed = await input.readExact(30);
  const dv = view(fixed);
  const flags = dv.getUint16(6, true);
  const method = dv.getUint16(8, true);
  const comp32 = dv.getUint32(18, true);
  const uncomp32 = dv.getUint32(22, true);
  const name = await input.readExact(dv.getUint16(26, true));
  const extra = await input.readExact(dv.getUint16(28, true));
  let { csize, usize, zip64 } = localSizes(extra, comp32, uncomp32);
  const descriptor = (flags & FLAG_DESCRIPTOR) !== 0;
  // "Sizes follow the data" written as 0xFFFFFFFF placeholders: not real sizes.
  if (descriptor && !zip64 && (comp32 === 0xffffffff || uncomp32 === 0xffffffff)) {
    csize = 0;
    usize = 0;
  }
  const entry = {
    name: decodeName(name, flags),
    flags,
    method,
    crc: dv.getUint32(14, true),
    csize,
    usize,
    offset,
    time: dv.getUint16(10, true),
    date: dv.getUint16(12, true),
  };
  if (method === 99) entry.aes = parseAesExtra(extra);
  // Is the data's length known before reading it? A deflate stream says itself where it ends.
  let known = !descriptor;
  if (descriptor && realMethod(entry) === METHOD_STORED) known = csize !== 0;
  return { entry, descriptor, zip64, known };
}

/**
 * The data descriptor at the start of `bytes`, tried in the layouts writers use (with or without
 * its signature, 4- or 8-byte sizes): `{len, crc}` for the one whose sizes match, or null.
 */
function matchDescriptor(bytes, csize, usize, zip64) {
  const start = bytes.length >= 4 && u32(bytes, 0) === DESCRIPTOR_SIG ? 4 : 0;
  const dv = view(bytes);
  for (const width of zip64 ? [8, 4] : [4, 8]) {
    const need = start + 4 + 2 * width;
    if (bytes.length < need) continue;
    const c = width === 8 ? Number(dv.getBigUint64(start + 4, true)) : dv.getUint32(start + 4, true);
    const u = width === 8 ? Number(dv.getBigUint64(start + 12, true)) : dv.getUint32(start + 8, true);
    if (c === csize && u === usize) return { len: need, crc: dv.getUint32(start, true) };
  }
  return null;
}

async function readDescriptor(input, h, csize, usize) {
  const peeked = await input.peek(24);
  const d = matchDescriptor(peeked, csize, usize, h.zip64);
  if (d) {
    input.consume(d.len);
    return d.crc;
  }
  if (input.eof && peeked.length < 24) throw transient("the download ended before the entry's data descriptor");
  throw failed(`${h.entry.name}: the data descriptor does not match its data (corrupt archive)`);
}

// ------------------------------------------------------------------------------------------
// Entry data
// ------------------------------------------------------------------------------------------

/**
 * Read the entry's data from `input`, hand the uncompressed bytes to `write` (null: read past
 * them), check them. Leaves `input` at the next entry's header.
 */
async function readData(input, h, write, { password, signal }) {
  const { entry } = h;
  let crc = 0;
  let written = 0;
  const take = async (chunk) => {
    if (signal.aborted) throw signal.reason;
    written += chunk.length;
    crc = crc32(crc, chunk);
    if (write) await write(chunk);
  };

  let expected;
  if (h.known) {
    if (!write) {
      // Nothing to keep: no need to decrypt or inflate.
      await input.skip(entry.csize);
      if (h.descriptor) await readDescriptor(input, h, entry.csize, entry.usize);
      return { written: entry.usize };
    }
    const dec = await decryptorFor(input, entry, password);
    let consumed = 0;
    try {
      for await (const chunk of entryChunks(input, entry, (n) => (consumed += n), 0, dec)) {
        if (written + chunk.length > entry.usize && !h.descriptor) {
          throw failed(`the data expands beyond the ${entry.usize} bytes declared for this entry (zip bomb or corrupt archive)`);
        }
        await take(chunk);
      }
    } catch (e) {
      // Padding after a complete deflate stream: what's left of the data is read past.
      if (!e.junk || dec) throw e;
      await input.skip(entry.csize - consumed);
    }
    expected = h.descriptor ? await readDescriptor(input, h, entry.csize, written) : entry.crc;
  } else if (realMethod(entry) === METHOD_DEFLATE) {
    const dec = await decryptorFor(input, entry, password);
    let consumed = await inflateToEnd(input, entry, take, dec);
    if (dec) {
      await dec.finish();
      consumed += dec.before + dec.after;
    }
    expected = await readDescriptor(input, h, consumed, written);
  } else {
    expected = await scanStored(input, h, take);
  }
  if (!h.descriptor && written !== entry.usize) {
    throw failed(`size mismatch: the entry says ${entry.usize} bytes, the data gave ${written}`);
  }
  if (checksCrc({ ...entry, crc: expected }) && crc !== expected) {
    throw failed(`CRC-32 mismatch (expected ${expected.toString(16).padStart(8, "0")}, got ${crc.toString(16).padStart(8, "0")}): the data is corrupt`);
  }
  return { written, crc: expected };
}

/**
 * A deflate stream of unknown length, inflated until its end marker. Returns its length. An
 * encrypted one (`dec`) is decrypted ahead of the inflater; what the inflater didn't use is
 * given back to the decryptor.
 */
async function inflateToEnd(input, entry, take, dec = null) {
  const inflater = new Inflate({ raw: true, chunkSize: 256 * 1024 });
  let out = [];
  inflater.onData = (c) => out.push(c);
  inflater.onEnd = () => {};
  let consumed = 0;
  let produced = 0;
  while (!inflater.ended) {
    const window = await input.peek(INFLATE_IN);
    if (!window.length) throw transient(`the download ended inside ${JSON.stringify(entry.name)}`);
    inflater.push(dec ? dec.decrypt(window) : window, false);
    if (inflater.err) throw failed(`the compressed data of this entry is corrupt (${inflater.msg || inflater.err})`);
    const used = inflater.ended ? window.length - inflater.strm.avail_in : window.length;
    if (dec) {
      dec.authenticate(window.subarray(0, used));
      if (used < window.length) dec.rewind(window.length - used);
    }
    input.consume(used);
    consumed += used;
    for (const c of out) {
      produced += c.length;
      if (produced > RATIO_FROM && produced > MAX_RATIO * consumed) {
        throw failed(`${JSON.stringify(entry.name)} expands more than ${MAX_RATIO} times (zip bomb or corrupt archive)`);
      }
      await take(c);
    }
    out = [];
  }
  return consumed;
}

/**
 * A stored entry whose length the header doesn't give: its data ends where a data descriptor
 * appears whose CRC-32 and both sizes match everything read so far (a match by chance is as
 * unlikely as a CRC-32 and two lengths agreeing at random). Returns that CRC-32.
 */
async function scanStored(input, h, take) {
  let total = 0;
  let crc = 0;
  for (;;) {
    const window = await input.peek(SCAN + 24);
    if (!window.length) throw transient(`the download ended inside the stored entry ${JSON.stringify(h.entry.name)}`);
    // A short window means the body ended, so every position has all the bytes it needs.
    const limit = window.length < SCAN + 24 ? window.length : SCAN;
    let found = null;
    for (let i = window.indexOf(0x50); i >= 0 && i < limit; i = window.indexOf(0x50, i + 1)) {
      if (i + 4 > window.length || u32(window, i) !== DESCRIPTOR_SIG) continue;
      const d = matchDescriptor(window.subarray(i), total + i, total + i, h.zip64);
      if (d && d.crc === crc32(crc, window.subarray(0, i))) {
        found = { at: i, len: d.len, crc: d.crc };
        break;
      }
    }
    const part = window.subarray(0, found ? found.at : limit);
    crc = crc32(crc, part);
    total += part.length;
    if (part.length) await take(part);
    if (found) {
      input.consume(found.at + found.len);
      return found.crc;
    }
    input.consume(limit);
    if (input.eof && !input.available) {
      throw transient(`the download ended before the end of the stored entry ${JSON.stringify(h.entry.name)} (or its data descriptor has no signature, which can't be found)`);
    }
  }
}

// ------------------------------------------------------------------------------------------
// The extraction
// ------------------------------------------------------------------------------------------

function notZip(head, contentType, at) {
  if (at > 0) return failed(`unexpected data at byte ${at} of the archive (corrupt archive?)`);
  if (!head.length) return coded("not_zip", "the server sent an empty response");
  if (looksLikeHtml(contentType, head)) return coded("html_page", "the server sent a web page (HTML), not a ZIP file");
  const hex = [...head.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  return coded("not_zip", `the response is not a ZIP file (it starts with ${hex})`);
}

/** Does the folder already hold this file, checked (Resume, entries whose CRC-32 comes first)? */
async function alreadyThere(sink, parts, entry, signal) {
  if (sink.isDone) return sink.isDone(parts, entry);
  if ((await sink.stat?.(parts)) !== entry.usize) return false;
  let crc = 0;
  for await (const chunk of sink.read(parts)) {
    if (signal.aborted) throw signal.reason;
    crc = crc32(crc, chunk);
  }
  return crc === entry.crc;
}

/**
 * Extract the zip `open()` sends from its first byte (`{body, length, etag, lastModified,
 * contentType}`, see openWhole) into `sink`. Only entries `filter` selects are written.
 */
export async function streamExtract({ url, credentials = "omit", open, sink, filter, resume = false, password = null, signal, onProgress = () => {} }) {
  open ??= () => openWhole(url, { credentials, signal });
  const started = Date.now();
  const stats = { downloaded: 0, extracted: 0, filesDone: 0, retries: 0, requests: 0, length: null, active: "", samples: [] };
  const state = { done: new Set(), dirs: new Set(), renames: [], skipped: 0, skippedBytes: 0, extractedNames: new Map() };
  const progress = () => {
    const now = Date.now();
    stats.samples.push([now, stats.downloaded]);
    while (stats.samples.length > 2 && now - stats.samples[0][0] > 4000) stats.samples.shift();
    const [t0, d0] = stats.samples[0];
    const rate = now > t0 ? ((stats.downloaded - d0) * 1000) / (now - t0) : 0;
    const total = stats.length || 0;
    return {
      type: "progress",
      downloaded: stats.downloaded,
      total_compressed: total,
      extracted: stats.extracted,
      total_extracted: 0,
      files_done: stats.filesDone,
      total_files: 0,
      skipped_files: state.skipped,
      skipped_compressed: 0,
      skipped_extracted: state.skippedBytes,
      rate: Math.round(rate),
      eta_secs: total && rate >= 1 ? Math.round(Math.max(0, total - stats.downloaded) / rate) : null,
      active: stats.active ? [stats.active] : [],
      active_count: stats.active ? 1 : 0,
      retries: stats.retries,
      requests: stats.requests,
      zip_on_disk: 0,
      free: null,
      elapsed_ms: now - started,
      stream: true,
    };
  };

  let first = null;
  const timer = setInterval(() => onProgress(progress()), PROGRESS_MS);
  let listing = null;
  let ok = false;
  try {
    for (let attempt = 1; ; attempt++) {
      stats.requests += 1;
      let input = null;
      try {
        const d = await open();
        if (!first) {
          first = d;
          stats.length = d.length;
          const etag = d.etag ? d.etag.trim().replace(/^W\//, "") : null;
          const key = d.etag || d.lastModified ? [url, d.length ?? "", etag ?? "", d.lastModified ?? ""].join("\n") : null;
          await sink.begin?.({ key, identity: { v: 1, size: d.length, etag, last_modified: d.lastModified || null }, resume });
        } else if (changed(first, d)) {
          d.body?.cancel().catch(() => {});
          throw failed("the file changed on the server while it was being downloaded");
        }
        stats.downloaded = 0; // the file starts over
        input = new Input(d.body, (n) => (stats.downloaded += n));
        listing = await pass(input, d.contentType, { sink, filter, resume: resume && attempt === 1, password, signal, stats, state });
        break;
      } catch (e) {
        input?.cancel();
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("cancelled", "AbortError");
        if (isTransient(e) && attempt < RETRY.attempts) {
          stats.retries += 1;
          await sleep(delayAfter(attempt), signal);
          continue;
        }
        if (e instanceof Coded && isTransient(e)) e.detail = `extracting failed after ${attempt} attempts: ${e.detail || e.message}`;
        throw e;
      }
    }
    ok = true;
  } finally {
    clearInterval(timer);
    await sink.end?.(ok).catch(() => {});
  }
  if (!stats.filesDone && !state.skipped && !state.dirs.size) throw failed(filter.nothingSelected());
  onProgress(progress());

  const differs = listing ? compareListing(listing, state.extractedNames) : null;
  return {
    files: stats.filesDone,
    dirs: state.dirs.size,
    extracted_bytes: stats.extracted,
    downloaded_bytes: stats.downloaded,
    index_bytes: 0,
    verified_files: stats.filesDone + state.skipped,
    skipped_existing: state.skipped,
    skipped_bytes: state.skippedBytes,
    archive_size: stats.length ?? stats.downloaded,
    normal_needs: (stats.length ?? stats.downloaded) + stats.extracted + state.skippedBytes,
    elapsed_ms: Date.now() - started,
    retries: stats.retries,
    requests: stats.requests,
    zip_bytes_on_disk: 0,
    renamed: state.renames.length + sink.renames.length,
    renamed_sample: [...state.renames, ...sink.renames].slice(0, 3),
    held: sink.held?.length || 0,
    held_sample: (sink.held || []).slice(0, 5),
    held_ids: (sink.held || []).slice(0, 1000).map((f) => f.id),
    listing_checked: Boolean(differs),
    listing_differs: differs?.length || 0,
    listing_differs_sample: (differs || []).slice(0, 5),
    stream: true,
  };
}

/** A restarted download must be the same file, or skipping "finished" entries would mix two versions. */
function changed(a, b) {
  const strip = (e) => e.trim().replace(/^W\//, "");
  if (a.etag && b.etag) return strip(a.etag) !== strip(b.etag);
  if (a.lastModified && b.lastModified) return a.lastModified !== b.lastModified;
  return a.length != null && b.length != null && a.length !== b.length;
}

/** One pass: entry after entry until the central directory starts; then that directory. */
async function pass(input, contentType, ctx) {
  const taken = new Map();
  for (;;) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const head = await input.peek(4);
    if (head.length < 4) {
      if (input.pos === 0) throw notZip(head, contentType, 0);
      throw transient("the download ended before the end of the archive");
    }
    const sig = u32(head, 0);
    if (sig === LOCAL_SIG) {
      await entry(input, ctx, taken);
      continue;
    }
    if (sig === CENTRAL_SIG || sig === EOCD_SIG || sig === ZIP64_EOCD_SIG) return readListing(input).catch(() => null);
    throw notZip(await input.peek(64), contentType, input.pos);
  }
}

async function entry(input, ctx, taken) {
  const { sink, filter, stats, state, signal } = ctx;
  const h = await readHeader(input);
  const { entry: e } = h;
  const opts = { password: ctx.password, signal };
  // The zip's own top folder (see wrappingFolder), decided on the first entry: the rest hasn't
  // come yet. An entry that turns out to be outside it keeps its whole path.
  if (state.top === undefined) {
    const top = topOf(e.name, isDir(e));
    state.top = sameFolder(top, sink.folder) && !(await sink.holdsOnly?.(top).catch(() => false)) ? top : null;
  }
  if (!filter.matches(e.name)) return readData(input, h, null, opts);

  // An encrypted stored entry whose size comes after it: its end can't be searched for.
  const why = unsupportedReason(e) || (isEncrypted(e) && !h.known && realMethod(e) === METHOD_STORED ? "encrypted, with its size only after the data" : null);
  if (why) {
    throw coded("unsupported_entries", `1 of the selected files can't be extracted by LinkUnzip: ${e.name} (${why}). Leave it out and try again.`, { detail: `${e.name}: ${why}` });
  }
  let safe;
  try {
    safe = sanitizeEntryName(e.name);
  } catch (err) {
    throw failed(`${JSON.stringify(e.name)}: unsafe path, ${err.message}`);
  }
  if (state.top && topOf(e.name, isDir(e)) === state.top) {
    if (safe.parts.length === 1) return readData(input, h, null, opts); // the top folder itself
    const parts = withoutTop(safe.parts);
    safe = { parts: [...parts], path: parts.join("/"), changed: safe.changed || parts.renamed };
  }
  const key = safe.path.toLowerCase();
  if (safe.changed && !state.renames.some(([from]) => from === e.name)) state.renames.push([e.name, safe.path]);
  for (const k of isDir(e) ? [key] : [key, `${key}.part`]) {
    const other = taken.get(k);
    if (other != null) throw failed(`${JSON.stringify(e.name)} and ${JSON.stringify(other)} would be written to the same file`);
    taken.set(k, e.name);
  }

  if (isDir(e)) {
    if (!state.dirs.has(key)) await sink.mkdir(safe.parts);
    state.dirs.add(key);
    return readData(input, h, null, opts);
  }
  if (state.done.has(key)) return readData(input, h, null, opts); // finished before the connection dropped
  if (ctx.resume && h.known && !h.descriptor && (await alreadyThere(sink, safe.parts, e, signal).catch(() => false))) {
    state.done.add(key);
    state.skipped += 1;
    state.skippedBytes += e.usize;
    return readData(input, h, null, opts);
  }

  stats.active = e.name;
  const out = await sink.create(safe.parts, e);
  let written = 0;
  try {
    const r = await readData(input, h, async (chunk) => {
      await out.write(chunk);
      written += chunk.length;
      stats.extracted += chunk.length;
    }, opts);
    // The size and CRC-32 may only have come after the data: the record for Resume gets them.
    const finished = { parts: safe.parts, path: safe.path, entry: { ...e, usize: r.written, crc: r.crc } };
    await out.close();
    sink.finished?.(finished);
    stats.filesDone += 1;
    state.done.add(key);
    state.extractedNames.set(e.name, { usize: r.written, crc: r.crc });
  } catch (err) {
    stats.extracted -= written;
    await out.abort();
    throw err;
  } finally {
    stats.active = "";
  }
}

/** The central directory right after the entries, parsed (null when it's too big to compare). */
async function readListing(input) {
  const records = [];
  let bytes = 0;
  for (;;) {
    const head = await input.peek(46);
    if (head.length < 46 || u32(head, 0) !== CENTRAL_SIG) break;
    const dv = view(head);
    const len = 46 + dv.getUint16(28, true) + dv.getUint16(30, true) + dv.getUint16(32, true);
    bytes += len;
    if (bytes > MAX_LISTING) return null;
    records.push(await input.readExact(len));
  }
  const all = new Uint8Array(bytes);
  let at = 0;
  for (const r of records) {
    all.set(r, at);
    at += r.length;
  }
  return parseCentralDirectory(all, records.length);
}

/**
 * Files whose size or CRC-32 differs from the central directory's, or that it doesn't list at
 * all: a zip that shows other files to tools that read its index.
 */
function compareListing(listing, extracted) {
  const listed = new Map(listing.map((e) => [e.name, e]));
  const differs = [];
  for (const [name, got] of extracted) {
    const l = listed.get(name);
    if (!l || l.usize !== got.usize || (checksCrc(l) && l.crc !== got.crc)) differs.push(name);
  }
  return differs;
}
