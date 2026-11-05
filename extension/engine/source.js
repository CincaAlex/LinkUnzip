// A remote zip read with HTTP Range requests: the probe, small reads for the index, and streaming
// reads for the data. Same checks as the helper's src/http.rs: the server must answer 206 with the
// bytes asked for, and the file must not change (ETag / Last-Modified) while we read it.
//
// Every range request after the probe also says which version of the file it wants (If-Range,
// with a strong ETag or else Last-Modified), so a server whose file changed answers with the new
// file instead of a part of it. The probe checks once that the server honours it.

import { Coded, failed, isTransient, transient } from "./errors.js";
import { LOCAL_FIXED_LEN, LOCAL_SIG, looksLikeHtml } from "./zip.js";

const SIGNATURE_PARAMS = [
  "x-amz-signature",
  "x-amz-expires",
  "x-amz-credential",
  "expires",
  "signature",
  "sig",
  "se",
  "sp",
  "x-goog-signature",
  "x-goog-expires",
  "token",
  "policy",
  "key-pair-id",
];

export const RETRY = { attempts: 5, baseMs: 500 };
export const delayAfter = (attempt) => Math.min(30_000, RETRY.baseMs * 2 ** Math.min(10, attempt - 1));

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function isSigned(url) {
  try {
    const names = [...new URL(url).searchParams.keys()].map((k) => k.toLowerCase());
    return names.some((n) => SIGNATURE_PARAMS.includes(n));
  } catch {
    return false;
  }
}

function statusError(status, requested, answered, what = "") {
  const signed = isSigned(requested) || isSigned(answered);
  let code = "failed";
  if (status === 401) code = "needs_login";
  else if (status === 403) code = signed ? "link_expired" : "needs_login";
  else if ((status === 400 || status === 410) && signed) code = "link_expired";
  else if (status === 404 || status === 410) code = "not_found";
  else if (status === 408 || status === 429 || (status >= 500 && status <= 599)) code = "server_error";
  return new Coded(code, `the server answered ${status}${what}`, { status, transient: code === "server_error" });
}

/** `bytes 0-0/12345` -> [start, end, total]; total is null for `*`. */
export function parseContentRange(value) {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value || "");
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), m[3] === "*" ? null : Number(m[3])];
}

const normalizeEtag = (e) => e.trim().replace(/^W\//, "");
const isWeak = (e) => /^\s*W\//.test(e);

/** The validator If-Range may carry: a strong ETag, else Last-Modified, else none. */
export function ifRangeValue(etag, lastModified) {
  if (etag && !isWeak(etag)) return etag.trim();
  if (etag) return null; // a weak ETag: the server must then always send the whole file
  return lastModified || null;
}

const CHANGED = "the file changed on the server since LinkUnzip read its index (the server sent the new file instead of the part asked for)";

/** fetch() turned into our errors: network trouble is transient, a cancel stays an AbortError. */
async function get(url, init) {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw transient(`could not connect: ${e?.message || e}`, { detail: String(e) });
  }
}

/**
 * Does `url` answer with a redirect? Asked without following it, so a redirect to a site the
 * extension may not read still shows up (as an opaque redirect, with no location).
 */
async function redirects(url, { credentials, signal }) {
  try {
    const resp = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" }, credentials, cache: "no-store", redirect: "manual", signal });
    resp.body?.cancel().catch(() => {});
    return resp.type === "opaqueredirect";
  } catch {
    return false;
  }
}

/**
 * Read a response body as exact byte counts. `pos` is the file offset of the next byte; `count`
 * is told about every byte that arrives.
 */
export class ByteReader {
  constructor(body, pos, count = () => {}) {
    this.reader = body.getReader();
    this.pos = pos;
    this.buf = null;
    this.off = 0;
    this.count = count;
  }

  async fill() {
    let r;
    try {
      r = await this.reader.read();
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw transient(`the connection dropped: ${e?.message || e}`);
    }
    if (r.done) throw transient("the connection ended early");
    this.count(r.value.length);
    this.buf = r.value;
    this.off = 0;
  }

  /** The next up to `max` bytes (at least 1), as a view into the received chunk. */
  async next(max) {
    if (!this.buf || this.off >= this.buf.length) await this.fill();
    const n = Math.min(max, this.buf.length - this.off);
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    this.pos += n;
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
    while (n > 0) n -= (await this.next(n)).length;
  }

  async skipTo(offset) {
    if (offset < this.pos) throw failed(`internal: asked to go back from ${this.pos} to ${offset}`);
    await this.skip(offset - this.pos);
  }

  cancel() {
    this.reader.cancel().catch(() => {});
  }
}

export class Source {
  constructor(url, credentials, signal) {
    this.url = url;
    this.credentials = credentials;
    this.signal = signal;
    this.size = 0;
    this.etag = null;
    this.lastModified = null;
    this.ifRange = null;
    this.indexBytes = 0;
    this.indexRequests = 0;
  }

  init(range) {
    const headers = { Range: range };
    if (this.ifRange) headers["If-Range"] = this.ifRange;
    return {
      headers,
      credentials: this.credentials,
      cache: "no-store",
      redirect: "follow",
      signal: this.signal,
    };
  }

  /** `Range: bytes=0-0` must answer 206 with the total size. */
  static async probe(url, { credentials = "omit", signal } = {}) {
    const src = new Source(url, credentials, signal);
    let resp;
    for (let attempt = 1; ; attempt++) {
      try {
        resp = await get(url, src.init("bytes=0-0"));
        if (resp.status >= 500 || resp.status === 408 || resp.status === 429) throw statusError(resp.status, url, resp.url, " to the probe request");
        break;
      } catch (e) {
        // The browser blocks the answer of a redirect to a site LinkUnzip may not read, and that
        // looks like a network error: find out once instead of retrying a connection that works.
        if (attempt === 1 && e?.code === "network" && (await redirects(url, { credentials, signal }))) {
          throw new Coded("redirect_access", "the link redirects to another site, and the browser didn't let LinkUnzip read the answer from there", { detail: e.detail || e.message });
        }
        if (!isTransient(e) || attempt >= RETRY.attempts) throw e;
        await sleep(delayAfter(attempt), signal);
      }
    }
    src.indexRequests = 1;
    const status = resp.status;
    if (status === 416) throw failed("the server answered 416 Range Not Satisfiable to a request for the first byte; is the file empty?");
    if (status !== 206 && status !== 200) throw statusError(status, url, resp.url, " to the probe request");
    const contentType = resp.headers.get("content-type");
    // A 200 is read only far enough to tell a web page from the file, then dropped.
    const sample = await readSample(resp, 4096);
    src.indexBytes = sample.length;
    if (looksLikeHtml(contentType, sample)) {
      throw new Coded("html_page", `the server answered ${status} with a web page (${contentType || "no Content-Type"}) instead of the file`, { status });
    }
    if (status === 200) {
      throw new Coded("no_range", "this server does not support HTTP Range requests (it answered 200 OK with the whole file instead of 206 Partial Content)", { status });
    }
    const cr = parseContentRange(resp.headers.get("content-range"));
    if (!cr) {
      throw failed(
        resp.headers.get("content-range") == null
          ? "the server sent 206 but no Content-Range header the extension can read, so the file size is unknown"
          : `could not read the total file size from Content-Range: ${resp.headers.get("content-range")}`,
      );
    }
    if (cr[2] == null) throw failed("the server did not say how big the file is (Content-Range ends in /*)");
    src.size = cr[2];
    src.etag = resp.headers.get("etag");
    src.lastModified = resp.headers.get("last-modified");
    await src.checkIfRange();
    return src;
  }

  /**
   * Ask for the first byte again with If-Range: a server that honours it answers 206. One that
   * answers 200 (some CDNs, or a Last-Modified it counts as weak) would send the whole file on
   * every request, so If-Range stays off there and the checks after each answer do the work.
   */
  async checkIfRange() {
    const value = ifRangeValue(this.etag, this.lastModified);
    if (!value) return;
    this.ifRange = value;
    this.indexRequests += 1;
    let resp;
    try {
      resp = await get(this.url, this.init("bytes=0-0"));
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      this.ifRange = null;
      return;
    }
    resp.body?.cancel().catch(() => {});
    if (resp.status !== 206) this.ifRange = null;
  }

  /** What the viewer needs to read from the same file again. */
  toJSON() {
    return { url: this.url, credentials: this.credentials, size: this.size, etag: this.etag, lastModified: this.lastModified, ifRange: this.ifRange };
  }

  static from(info, signal) {
    if (info.outer) return new SubSource(Source.from(info.outer, signal), info.base, info.size, info.path);
    const src = new Source(info.url, info.credentials, signal);
    Object.assign(src, { size: info.size, etag: info.etag, lastModified: info.lastModified, ifRange: info.ifRange ?? null });
    return src;
  }

  /** Start a streaming GET for bytes start..end (inclusive), checked. */
  async openRange(start, end, signal = this.signal) {
    const resp = await get(this.url, { ...this.init(`bytes=${start}-${end}`), signal });
    try {
      this.check(resp, start);
    } catch (e) {
      // Whatever came instead (a whole new file, an error page) isn't read any further.
      resp.body?.cancel().catch(() => {});
      throw e;
    }
    return resp;
  }

  check(resp, start) {
    const status = resp.status;
    if (status === 200 && this.ifRange) throw failed(CHANGED);
    if (status === 200) throw failed("the server ignored the Range header and answered 200 OK (it stopped supporting ranges, or the file changed)");
    if (status === 416) throw failed("416 Range Not Satisfiable: the file on the server changed size");
    if (status !== 206) throw statusError(status, this.url, resp.url);
    const raw = resp.headers.get("content-range");
    const cr = parseContentRange(raw);
    if (!cr || cr[0] !== start || (cr[2] != null && cr[2] !== this.size)) {
      throw failed(`the server returned a different range than requested (asked for start ${start}, size ${this.size}; got ${JSON.stringify(raw)})`);
    }
    const etag = resp.headers.get("etag");
    if (this.etag && etag && normalizeEtag(this.etag) !== normalizeEtag(etag)) {
      throw failed("the file changed on the server during the download (ETag changed)");
    }
    // Last-Modified decides whenever the ETags couldn't be compared (none at first, or none now).
    const lm = resp.headers.get("last-modified");
    if (!(this.etag && etag) && this.lastModified && lm && lm !== this.lastModified) {
      throw failed("the file changed on the server during the download (Last-Modified changed)");
    }
  }

  /**
   * Bytes start..end (inclusive) into memory, with retries. Counted as index bytes. `onData(n)`
   * hears about every n bytes as they arrive (a retry starts again from the first byte).
   */
  async getBytes(start, end, onData = () => {}) {
    const len = end - start + 1;
    for (let attempt = 1; ; attempt++) {
      let got = 0;
      try {
        this.indexRequests += 1;
        const resp = await this.openRange(start, end);
        const reader = new ByteReader(resp.body, start, (n) => {
          got += n;
          onData(n);
        });
        const bytes = await reader.readExact(len);
        reader.cancel();
        this.indexBytes += len;
        return bytes;
      } catch (e) {
        if (!isTransient(e) || attempt >= RETRY.attempts) throw e;
        onData(-got);
        await sleep(delayAfter(attempt), this.signal);
      }
    }
  }

  /**
   * What names this exact version of the file, for the index cache: the size plus a strong ETag
   * and/or Last-Modified. null when the server gives neither (then nothing is cached).
   */
  identityKey() {
    const etag = this.etag && !/^\s*W\//.test(this.etag) ? this.etag.trim() : "";
    const lm = this.lastModified || "";
    if (!etag && !lm) return null;
    return [this.url, this.size, etag, lm].join("\n");
  }
}

/**
 * A zip stored (not compressed, not encrypted) inside another one: its bytes are one continuous
 * range of the outer file, so it is read with Range requests like any zip. Same interface as
 * Source; every range is moved by `base` and has to stay inside the inner file.
 */
export class SubSource {
  constructor(outer, base, size, path) {
    this.outer = outer;
    this.base = base;
    this.size = size;
    this.path = path;
    this.url = outer.url;
    this.credentials = outer.credentials;
    this.signal = outer.signal;
    // What reading the outer zip's index cost belongs to this one's too.
    this.indexBytes = outer.indexBytes;
    this.indexRequests = outer.indexRequests;
  }

  /**
   * The inner zip `entry` of `outer`: one small read of its local header says where its data
   * starts. `regionEnd` is where the next entry (or the central directory) begins.
   */
  static async open(outer, entry, path, regionEnd) {
    const head = await outer.getBytes(entry.offset, Math.min(outer.size, entry.offset + LOCAL_FIXED_LEN) - 1);
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < LOCAL_FIXED_LEN || dv.getUint32(0, true) !== LOCAL_SIG) {
      throw failed(`${path}: expected a local file header but found something else (corrupt archive)`);
    }
    const base = entry.offset + LOCAL_FIXED_LEN + dv.getUint16(26, true) + dv.getUint16(28, true);
    if (base + entry.csize > Math.min(regionEnd ?? outer.size, outer.size)) {
      throw failed(`${path}: its data runs past its own place in the archive (corrupt or hostile archive)`);
    }
    const sub = new SubSource(outer, base, entry.csize, path);
    sub.indexBytes = outer.indexBytes;
    sub.indexRequests = outer.indexRequests;
    return sub;
  }

  get etag() {
    return this.outer.etag;
  }

  get lastModified() {
    return this.outer.lastModified;
  }

  get ifRange() {
    return this.outer.ifRange;
  }

  inside(start, end) {
    if (start < 0 || end < start || end >= this.size) {
      throw failed(`asked for bytes ${start}-${end} of a ${this.size}-byte zip inside the zip (corrupt archive?)`);
    }
  }

  openRange(start, end, signal = this.signal) {
    this.inside(start, end);
    return this.outer.openRange(this.base + start, this.base + end, signal);
  }

  async getBytes(start, end, onData = () => {}) {
    this.inside(start, end);
    const bytes = await this.outer.getBytes(this.base + start, this.base + end, onData);
    this.indexBytes += bytes.length;
    this.indexRequests += 1;
    return bytes;
  }

  toJSON() {
    return { outer: this.outer.toJSON(), base: this.base, size: this.size, path: this.path };
  }

  /** The outer zip's version plus where this one sits in it. */
  identityKey() {
    const outer = this.outer.identityKey();
    return outer == null ? null : `${outer}\n>${this.path}`;
  }
}

/**
 * The whole file in one GET from its first byte, for servers that can't send parts of it (stream
 * mode). `{body, length, etag, lastModified, contentType}`; `length` is null when the server
 * doesn't say (GitHub's zips are built while they are sent).
 */
export async function openWhole(url, { credentials = "omit", signal } = {}) {
  const resp = await get(url, { credentials, cache: "no-store", redirect: "follow", signal });
  if (!resp.ok) {
    resp.body?.cancel().catch(() => {});
    throw statusError(resp.status, url, resp.url);
  }
  const declared = resp.headers.get("content-length");
  const encoded = (resp.headers.get("content-encoding") || "identity") !== "identity";
  return {
    body: resp.body,
    length: declared != null && !encoded ? Number(declared) : null,
    etag: resp.headers.get("etag"),
    lastModified: resp.headers.get("last-modified"),
    contentType: resp.headers.get("content-type"),
  };
}

async function readSample(resp, max) {
  if (!resp.body) return new Uint8Array(0);
  const reader = resp.body.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } catch {
    // What arrived is enough to decide.
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - at);
    out.set(p.subarray(0, take), at);
    at += take;
    if (at >= out.length) break;
  }
  return out;
}
