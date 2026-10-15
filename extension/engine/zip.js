// Reading a zip's index: the end-of-central-directory record (EOCD), ZIP64, and the central
// directory itself, with as few Range requests as possible. Same rules as the helper's
// src/zip/{eocd,central,index}.rs.

import { Coded, failed } from "./errors.js";

export const METHOD_STORED = 0;
export const METHOD_DEFLATE = 8;
export const LOCAL_SIG = 0x04034b50;
export const LOCAL_FIXED_LEN = 30;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_LEN = 22;
const ZIP64_LOCATOR_LEN = 20;
const ZIP64_EOCD_MIN_LEN = 56;
const CENTRAL_FIXED_LEN = 46;
/** The EOCD is 22 bytes plus a comment of up to 65,535; the ZIP64 locator sits right before it. */
export const TAIL_WINDOW = 65535 + EOCD_LEN + ZIP64_LOCATOR_LEN;
/** A browser tab can hold a big index, but not an unlimited one (~2.5 million files). */
const MAX_CENTRAL_DIR_BYTES = 256 * 1024 * 1024;

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

function u64(dv, o) {
  const v = dv.getBigUint64(o, true);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw failed("a size or offset in the zip is too large");
  return Number(v);
}

const METHOD_NAMES = {
  1: "shrink",
  6: "implode",
  9: "deflate64",
  12: "bzip2",
  14: "lzma",
  93: "zstd",
  95: "xz",
  98: "ppmd",
  99: "AES encryption",
};

export const isDir = (e) => e.name.endsWith("/") || e.name.endsWith("\\");
export const isEncrypted = (e) => (e.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0;

/** Why LinkUnzip can't extract this entry, or null when it can. Directories never matter. */
export function unsupportedReason(e) {
  if (isDir(e)) return null;
  if (isEncrypted(e)) return "encrypted";
  if (e.method === METHOD_STORED || e.method === METHOD_DEFLATE) return null;
  return `compression method ${e.method} (${METHOD_NAMES[e.method] || "unknown"})`;
}

/** The short form the file list shows: "encrypted", "method 12", or null. */
export function unsupportedShort(e) {
  if (isEncrypted(e)) return "encrypted";
  if (e.method === METHOD_STORED || e.method === METHOD_DEFLATE) return null;
  return `method ${e.method}`;
}

// ------------------------------------------------------------------------------------------
// End of central directory
// ------------------------------------------------------------------------------------------

/** Search backwards for the EOCD; prefer one whose comment ends exactly at the end of the file. */
function findEocd(tail) {
  if (tail.length < EOCD_LEN) throw new Coded("not_zip", "file is too small to be a ZIP archive");
  const dv = view(tail);
  let fallback = -1;
  for (let pos = tail.length - EOCD_LEN; pos >= 0; pos--) {
    if (dv.getUint32(pos, true) !== EOCD_SIG) continue;
    const end = pos + EOCD_LEN + dv.getUint16(pos + 20, true);
    if (end === tail.length) return pos;
    if (end < tail.length && fallback < 0) fallback = pos;
  }
  if (fallback >= 0) return fallback;
  throw new Coded("not_zip", "no End Of Central Directory record found: this does not look like a ZIP file");
}

/** `{zip64Offset}` when a ZIP64 locator is there, else `{loc: {count, size, offset}}`. */
export function parseTail(tail) {
  const pos = findEocd(tail);
  const dv = view(tail);
  const thisDisk = dv.getUint16(pos + 4, true);
  const cdDisk = dv.getUint16(pos + 6, true);
  const onDisk = dv.getUint16(pos + 8, true);
  const total = dv.getUint16(pos + 10, true);
  const cdSize = dv.getUint32(pos + 12, true);
  const cdOffset = dv.getUint32(pos + 16, true);
  if (pos >= ZIP64_LOCATOR_LEN) {
    const l = pos - ZIP64_LOCATOR_LEN;
    if (dv.getUint32(l, true) === ZIP64_LOCATOR_SIG) {
      if (dv.getUint32(l + 16, true) > 1) throw failed("multi-disk (split) ZIP archives are not supported");
      return { zip64Offset: u64(dv, l + 8) };
    }
  }
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw failed("the EOCD record says this is a ZIP64 archive, but there is no ZIP64 locator");
  }
  if (thisDisk !== 0 || cdDisk !== 0 || onDisk !== total) throw failed("multi-disk (split) ZIP archives are not supported");
  return { loc: { count: total, size: cdSize, offset: cdOffset } };
}

export function parseZip64Eocd(rec) {
  if (rec.length < ZIP64_EOCD_MIN_LEN) throw failed("ZIP64 EOCD record is truncated");
  const dv = view(rec);
  if (dv.getUint32(0, true) !== ZIP64_EOCD_SIG) throw failed("ZIP64 locator points at something that is not a ZIP64 EOCD record");
  if (u64(dv, 4) < 44) throw failed("ZIP64 EOCD record has an invalid size field");
  if (dv.getUint32(16, true) !== 0 || dv.getUint32(20, true) !== 0 || u64(dv, 24) !== u64(dv, 32)) {
    throw failed("multi-disk (split) ZIP archives are not supported");
  }
  return { count: u64(dv, 32), size: u64(dv, 40), offset: u64(dv, 48) };
}

// ------------------------------------------------------------------------------------------
// Central directory
// ------------------------------------------------------------------------------------------

const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";
const utf8 = new TextDecoder("utf-8");

/** UTF-8 if flag bit 11 is set, otherwise the original DOS code page 437. */
export function decodeName(raw, flags) {
  if (flags & FLAG_UTF8) return utf8.decode(raw);
  let ascii = true;
  for (let i = 0; i < raw.length; i++) if (raw[i] >= 0x80) ascii = false;
  if (ascii) return utf8.decode(raw);
  let s = "";
  for (let i = 0; i < raw.length; i++) s += raw[i] < 0x80 ? String.fromCharCode(raw[i]) : CP437_HIGH[raw[i] - 0x80];
  return s;
}

/** Replace 0xFFFFFFFF fields with the ZIP64 extra field's 64-bit values (in this fixed order). */
function applyZip64(entry, buf, dv, extraStart, extraLen, needs) {
  let pos = extraStart;
  const end = extraStart + extraLen;
  while (pos + 4 <= end) {
    const id = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (pos + 4 + len > end) throw failed(`entry ${JSON.stringify(entry.name)}: extra field block is truncated`);
    const data = pos + 4;
    pos += 4 + len;
    if (id !== 0x0001) continue;
    let at = data;
    const next = (wanted) => {
      if (!wanted) return null;
      if (at + 8 > data + len) throw failed(`entry ${JSON.stringify(entry.name)}: ZIP64 extra field is too short for the sizes this entry needs`);
      at += 8;
      return u64(dv, at - 8);
    };
    const usize = next(needs.usize);
    if (usize != null) entry.usize = usize;
    const csize = next(needs.csize);
    if (csize != null) entry.csize = csize;
    const offset = next(needs.offset);
    if (offset != null) entry.offset = offset;
    return;
  }
  throw failed(`entry ${JSON.stringify(entry.name)}: a size or offset is 0xFFFFFFFF but the entry has no ZIP64 extra field`);
}

/** Parse `count` records out of the whole central directory `buf`. */
export function parseCentralDirectory(buf, count) {
  const dv = view(buf);
  const entries = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const where = `central directory entry #${i + 1} (at byte ${pos})`;
    if (buf.length - pos < CENTRAL_FIXED_LEN) throw failed(`${where}: central directory is truncated`);
    if (dv.getUint32(pos, true) !== CENTRAL_SIG) throw failed(`${where}: bad central directory signature (corrupt archive?)`);
    const flags = dv.getUint16(pos + 8, true);
    const method = dv.getUint16(pos + 10, true);
    const time = dv.getUint16(pos + 12, true);
    const date = dv.getUint16(pos + 14, true);
    const crc = dv.getUint32(pos + 16, true);
    const comp32 = dv.getUint32(pos + 20, true);
    const uncomp32 = dv.getUint32(pos + 24, true);
    const nameLen = dv.getUint16(pos + 28, true);
    const extraLen = dv.getUint16(pos + 30, true);
    const commentLen = dv.getUint16(pos + 32, true);
    const offset32 = dv.getUint32(pos + 42, true);
    const total = CENTRAL_FIXED_LEN + nameLen + extraLen + commentLen;
    if (buf.length - pos < total) throw failed(`${where}: central directory is truncated inside an entry`);
    const nameStart = pos + CENTRAL_FIXED_LEN;
    const entry = {
      name: decodeName(buf.subarray(nameStart, nameStart + nameLen), flags),
      flags,
      method,
      crc,
      csize: comp32,
      usize: uncomp32,
      offset: offset32,
      time,
      date,
    };
    const needs = { usize: uncomp32 === 0xffffffff, csize: comp32 === 0xffffffff, offset: offset32 === 0xffffffff };
    if (needs.usize || needs.csize || needs.offset) applyZip64(entry, buf, dv, nameStart + nameLen, extraLen, needs);
    entries.push(entry);
    pos += total;
  }
  return entries;
}

/** `buf` holds file bytes from `bufStart`; the `len` bytes at `offset` if they are all inside. */
function sliceOf(buf, bufStart, offset, len) {
  const rel = offset - bufStart;
  if (rel < 0 || rel + len > buf.length) return null;
  return buf.subarray(rel, rel + len);
}

/**
 * Fetch and parse the central directory: (1) the last ~64 KB, (2) the ZIP64 record if it isn't in
 * there, (3) the central directory in one request unless the tail already holds it.
 */
export async function readIndex(src) {
  const size = src.size;
  if (size < EOCD_LEN) throw new Coded("not_zip", `the file is only ${size} bytes: too small to be a ZIP archive`);
  const tailStart = size - Math.min(size, TAIL_WINDOW);
  const tail = await src.getBytes(tailStart, size - 1);
  let info;
  try {
    info = parseTail(tail);
  } catch (e) {
    if (tailStart === 0 && looksLikeHtml(null, tail)) {
      throw new Coded("html_page", "the server sent a web page (HTML), not a ZIP file", { status: 206 });
    }
    throw e;
  }
  let loc = info.loc;
  if (!loc) {
    let rec = sliceOf(tail, tailStart, info.zip64Offset, ZIP64_EOCD_MIN_LEN);
    if (!rec) {
      if (info.zip64Offset + ZIP64_EOCD_MIN_LEN > size) throw failed("the ZIP64 locator points outside the file");
      rec = await src.getBytes(info.zip64Offset, info.zip64Offset + ZIP64_EOCD_MIN_LEN - 1);
    }
    loc = parseZip64Eocd(rec);
  }
  if (loc.offset + loc.size > size) {
    throw failed(`the central directory (offset ${loc.offset}, ${loc.size} bytes) lies outside the ${size}-byte file`);
  }
  if (loc.size > MAX_CENTRAL_DIR_BYTES) {
    throw new Coded("too_big", `the zip's index is ${Math.round(loc.size / 1048576)} MB, too big to read in the browser. The LinkUnzip command line can handle it.`);
  }
  if (loc.count === 0) return { entries: [], centralDirOffset: loc.offset };
  const cd = sliceOf(tail, tailStart, loc.offset, loc.size) || (await src.getBytes(loc.offset, loc.offset + loc.size - 1));
  return { entries: parseCentralDirectory(cd, loc.count), centralDirOffset: loc.offset };
}

/** Is this a web page rather than the file? `<` first means markup, `P` (of "PK") means a zip. */
export function looksLikeHtml(contentType, sample) {
  let i = 0;
  if (sample[0] === 0xef && sample[1] === 0xbb && sample[2] === 0xbf) i = 3;
  while (i < sample.length && (sample[i] === 0x20 || (sample[i] >= 0x09 && sample[i] <= 0x0d))) i++;
  if (i < sample.length) {
    if (sample[i] === 0x3c) return true;
    if (sample[i] === 0x50) return false;
  }
  const ct = (contentType || "").trim().toLowerCase();
  return ct.startsWith("text/html") || ct.startsWith("application/xhtml+xml");
}
