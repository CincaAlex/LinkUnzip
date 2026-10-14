// A remote zip read with HTTP Range requests: the probe, small reads for the index, and streaming
// reads for the data. Same checks as the helper's src/http.rs: the server must answer 206 with the
// bytes asked for, and the file must not change (ETag / Last-Modified) while we read it.

import { Coded, failed, isTransient, transient } from "./errors.js";
import { looksLikeHtml } from "./zip.js";

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
    this.indexBytes = 0;
    this.indexRequests = 0;
  }

  init(range) {
    return {
      headers: { Range: range },
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
    return src;
  }

  /** What the viewer needs to read from the same file again. */
  toJSON() {
    return { url: this.url, credentials: this.credentials, size: this.size, etag: this.etag, lastModified: this.lastModified };
  }

  static from(info, signal) {
    const src = new Source(info.url, info.credentials, signal);
    Object.assign(src, { size: info.size, etag: info.etag, lastModified: info.lastModified });
    return src;
  }

  /** Start a streaming GET for bytes start..end (inclusive), checked. */
  async openRange(start, end, signal = this.signal) {
    const resp = await get(this.url, { ...this.init(`bytes=${start}-${end}`), signal });
    this.check(resp, start);
    return resp;
  }

  check(resp, start) {
    const status = resp.status;
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
    const lm = resp.headers.get("last-modified");
    if (!this.etag && this.lastModified && lm && lm !== this.lastModified) {
      throw failed("the file changed on the server during the download (Last-Modified changed)");
    }
  }

  /** Bytes start..end (inclusive) into memory, with retries. Counted as index bytes. */
  async getBytes(start, end) {
    const len = end - start + 1;
    for (let attempt = 1; ; attempt++) {
      try {
        this.indexRequests += 1;
        const resp = await this.openRange(start, end);
        const reader = new ByteReader(resp.body, start);
        const bytes = await reader.readExact(len);
        reader.cancel();
        this.indexBytes += len;
        return bytes;
      } catch (e) {
        if (!isTransient(e) || attempt >= RETRY.attempts) throw e;
        await sleep(delayAfter(attempt), this.signal);
      }
    }
  }
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
