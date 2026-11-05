// Password-protected entries: the old ZipCrypto (PKWARE's "traditional" encryption, flag bit 0)
// and WinZip's AES (method 99 with an 0x9901 extra field, AE-1 and AE-2, 128/192/256-bit keys).
// Strong Encryption (flag bit 6) is not supported.
//
// AES: the keys come from PBKDF2-HMAC-SHA1 (1000 rounds, the entry's own salt), done by the
// browser. The data is AES in counter mode with a little-endian counter, which WebCrypto's
// AES-CTR (big-endian) can't produce, so the block cipher is here; so is SHA-1, because the
// authentication code covers the whole entry and WebCrypto's HMAC only takes it in one piece.

import { coded, failed } from "./errors.js";
import { CRC_TABLE } from "./crc32.js";

const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DESCRIPTOR = 1 << 3;
export const METHOD_AES = 99;
const AES_EXTRA = 0x9901;
const AES_MAC_LEN = 10;
const ZIPCRYPTO_HEADER = 12;

// ------------------------------------------------------------------------------------------
// Which kind
// ------------------------------------------------------------------------------------------

/** WinZip's extra field: `{version, strength, method}`, or null. */
export function parseAesExtra(extra) {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let pos = 0; pos + 4 <= extra.length; ) {
    const id = dv.getUint16(pos, true);
    const len = dv.getUint16(pos + 2, true);
    if (pos + 4 + len > extra.length) return null;
    if (id === AES_EXTRA && len >= 7) {
      return { version: dv.getUint16(pos + 4, true), strength: extra[pos + 8], method: dv.getUint16(pos + 9, true) };
    }
    pos += 4 + len;
  }
  return null;
}

/** "aes", "zipcrypto" or null (not encrypted, or a kind LinkUnzip can't read). */
export function encryptionOf(entry) {
  if (entry.method === METHOD_AES) return entry.aes && entry.aes.strength >= 1 && entry.aes.strength <= 3 ? "aes" : null;
  if (entry.flags & FLAG_ENCRYPTED && !(entry.flags & (1 << 6))) return "zipcrypto";
  return null;
}

/** The compression method under the encryption. */
export const realMethod = (entry) => (entry.method === METHOD_AES ? entry.aes?.method ?? -1 : entry.method);

/** AE-2 entries store no CRC-32 (the authentication code is their check). */
export const checksCrc = (entry) => !(entry.method === METHOD_AES && entry.aes?.version === 2 && entry.crc === 0);

/** Encrypted bytes around the data: `[before, after]`. */
export function overhead(entry) {
  const kind = encryptionOf(entry);
  if (kind === "zipcrypto") return [ZIPCRYPTO_HEADER, 0];
  if (kind === "aes") return [saltLength(entry.aes.strength) + 2, AES_MAC_LEN];
  return [0, 0];
}

const saltLength = (strength) => 4 + 4 * strength; // 8, 12, 16
const keyLength = (strength) => 8 + 8 * strength; // 16, 24, 32

const passwordBytes = (password) => new TextEncoder().encode(password);

function wrongPassword(entry) {
  return coded("password_wrong", "The password doesn't fit this zip.", { detail: `the password check failed for ${JSON.stringify(entry.name)}` });
}

/**
 * Read the entry's encryption header from `reader` (positioned right after the local header)
 * and check `password`. Returns a decryptor: `update(chunk)` gives the plain bytes, `finish()`
 * reads and checks what follows the data (AES's authentication code). Throws `password_needed`
 * or `password_wrong`.
 */
export async function openDecryptor(reader, entry, password) {
  const kind = encryptionOf(entry);
  if (!kind) throw failed(`${entry.name}: encrypted in a way LinkUnzip can't read`);
  if (password == null || password === "") {
    throw coded("password_needed", "This zip is password-protected.", { detail: `${JSON.stringify(entry.name)} is encrypted` });
  }
  if (kind === "zipcrypto") {
    const dec = new ZipCrypto(passwordBytes(password));
    const header = dec.update(await reader.readExact(ZIPCRYPTO_HEADER));
    const check = header[11];
    // The last header byte repeats the CRC's top byte, or the time's with a data descriptor.
    const byCrc = (entry.crc >>> 24) & 0xff;
    const byTime = (entry.time >>> 8) & 0xff;
    const ok = entry.flags & FLAG_DESCRIPTOR ? check === byTime || check === byCrc : check === byCrc || check === byTime;
    if (!ok) throw wrongPassword(entry);
    return {
      kind,
      before: ZIPCRYPTO_HEADER,
      after: 0,
      update: (c) => dec.update(c),
      // Stream mode decrypts ahead of the inflater; what it didn't use is past the entry's end,
      // where ZipCrypto's state no longer matters.
      decrypt: (c) => dec.update(c),
      authenticate() {},
      rewind() {},
      finish: async () => {},
    };
  }
  const { strength } = entry.aes;
  const salt = await reader.readExact(saltLength(strength));
  const verifier = await reader.readExact(2);
  const keys = await deriveAesKeys(passwordBytes(password), salt, strength);
  if (keys.verifier[0] !== verifier[0] || keys.verifier[1] !== verifier[1]) throw wrongPassword(entry);
  const ctr = new AesCtr(keys.enc);
  const mac = new HmacSha1(keys.mac);
  return {
    kind,
    before: salt.length + 2,
    after: AES_MAC_LEN,
    update(c) {
      mac.update(c);
      return ctr.update(c);
    },
    // The same in two steps, for stream mode: decrypt ahead, authenticate what was used, and
    // move the counter back over what wasn't.
    decrypt: (c) => ctr.update(c),
    authenticate: (c) => mac.update(c),
    rewind: (n) => ctr.seek(ctr.position - n),
    async finish() {
      const code = await reader.readExact(AES_MAC_LEN);
      const want = mac.digest();
      for (let i = 0; i < AES_MAC_LEN; i++) {
        if (code[i] !== want[i]) throw failed("the encrypted data failed its authentication check: the file is corrupt or was changed");
      }
    },
  };
}

/** `{enc, mac, verifier}` from the password and the entry's salt. */
export async function deriveAesKeys(password, salt, strength) {
  const n = keyLength(strength);
  const base = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-1", salt, iterations: 1000 }, base, (2 * n + 2) * 8));
  return { enc: bits.slice(0, n), mac: bits.slice(n, 2 * n), verifier: bits.slice(2 * n) };
}

// ------------------------------------------------------------------------------------------
// ZipCrypto
// ------------------------------------------------------------------------------------------

export class ZipCrypto {
  constructor(password) {
    this.k0 = 0x12345678;
    this.k1 = 0x23456789;
    this.k2 = 0x34567890;
    for (const b of password) this.step(b);
  }

  step(b) {
    const t = CRC_TABLE;
    this.k0 = (t[(this.k0 ^ b) & 0xff] ^ (this.k0 >>> 8)) >>> 0;
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = (t[(this.k2 ^ (this.k1 >>> 24)) & 0xff] ^ (this.k2 >>> 8)) >>> 0;
  }

  update(cipher) {
    const out = new Uint8Array(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
      const k = (this.k2 | 2) & 0xffff;
      const c = cipher[i] ^ ((Math.imul(k, k ^ 1) >>> 8) & 0xff);
      out[i] = c;
      this.step(c);
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// AES (encryption direction only: counter mode never needs the other)
// ------------------------------------------------------------------------------------------

const SBOX = new Uint8Array(256);
const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);
(() => {
  const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const s2 = ((s << 1) ^ (s & 0x80 ? 0x11b : 0)) & 0xff;
    const s3 = s2 ^ s;
    const w = ((s2 << 24) | (s << 16) | (s << 8) | s3) >>> 0;
    T0[i] = w;
    T1[i] = ((w >>> 8) | (w << 24)) >>> 0;
    T2[i] = ((w >>> 16) | (w << 16)) >>> 0;
    T3[i] = ((w >>> 24) | (w << 8)) >>> 0;
  }
})();

const subWord = (w) => ((SBOX[w >>> 24] << 24) | (SBOX[(w >>> 16) & 0xff] << 16) | (SBOX[(w >>> 8) & 0xff] << 8) | SBOX[w & 0xff]) >>> 0;

export class Aes {
  constructor(key) {
    const nk = key.length / 4;
    if (![4, 6, 8].includes(nk)) throw new Error("AES keys are 16, 24 or 32 bytes");
    this.rounds = nk + 6;
    const w = new Uint32Array(4 * (this.rounds + 1));
    for (let i = 0; i < nk; i++) w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    let rcon = 1;
    for (let i = nk; i < w.length; i++) {
      let t = w[i - 1];
      if (i % nk === 0) {
        t = subWord(((t << 8) | (t >>> 24)) >>> 0) ^ (rcon << 24);
        rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
      } else if (nk > 6 && i % nk === 4) t = subWord(t);
      w[i] = (w[i - nk] ^ t) >>> 0;
    }
    this.w = w;
  }

  /** Encrypt one block given as four big-endian words; the result goes into `out` (4 words). */
  encryptWords(s0, s1, s2, s3, out) {
    const w = this.w;
    s0 ^= w[0];
    s1 ^= w[1];
    s2 ^= w[2];
    s3 ^= w[3];
    let k = 4;
    for (let r = 1; r < this.rounds; r++) {
      const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
      const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
      const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
      const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
      s0 = t0;
      s1 = t1;
      s2 = t2;
      s3 = t3;
      k += 4;
    }
    out[0] = ((SBOX[s0 >>> 24] << 24) | (SBOX[(s1 >>> 16) & 0xff] << 16) | (SBOX[(s2 >>> 8) & 0xff] << 8) | SBOX[s3 & 0xff]) ^ w[k];
    out[1] = ((SBOX[s1 >>> 24] << 24) | (SBOX[(s2 >>> 16) & 0xff] << 16) | (SBOX[(s3 >>> 8) & 0xff] << 8) | SBOX[s0 & 0xff]) ^ w[k + 1];
    out[2] = ((SBOX[s2 >>> 24] << 24) | (SBOX[(s3 >>> 16) & 0xff] << 16) | (SBOX[(s0 >>> 8) & 0xff] << 8) | SBOX[s1 & 0xff]) ^ w[k + 2];
    out[3] = ((SBOX[s3 >>> 24] << 24) | (SBOX[(s0 >>> 16) & 0xff] << 16) | (SBOX[(s1 >>> 8) & 0xff] << 8) | SBOX[s2 & 0xff]) ^ w[k + 3];
  }

  /** Encrypt the 16 bytes at `input[i]` into `out[o]`. */
  encryptBlock(input, i, out, o) {
    const word = (j) => (input[j] << 24) | (input[j + 1] << 16) | (input[j + 2] << 8) | input[j + 3];
    const r = new Uint32Array(4);
    this.encryptWords(word(i), word(i + 4), word(i + 8), word(i + 12), r);
    for (let j = 0; j < 4; j++) {
      out[o + 4 * j] = r[j] >>> 24;
      out[o + 4 * j + 1] = (r[j] >>> 16) & 0xff;
      out[o + 4 * j + 2] = (r[j] >>> 8) & 0xff;
      out[o + 4 * j + 3] = r[j] & 0xff;
    }
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** A number's low 32 bits with the byte order reversed. */
const swap32 = (x) => ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);

/** WinZip's counter mode: the counter is a little-endian number starting at 1. */
export class AesCtr {
  constructor(key) {
    this.aes = new Aes(key);
    this.block = 0; // blocks used so far; the next one is counter block + 1
    this.ks = new Uint32Array(4);
    this.stream = new Uint8Array(16);
    this.used = 16;
    this.position = 0; // bytes of data so far
  }

  /** Jump to byte `offset` of the data (counter mode can start anywhere). */
  seek(offset) {
    this.position = offset;
    this.block = Math.floor(offset / 16);
    this.used = 16;
    if (offset % 16) {
      this.next(this.stream);
      this.used = offset % 16;
    }
  }

  /** The next block of key stream, as four words in `this.ks` (and as bytes in `bytes`, if given). */
  next(bytes) {
    this.block += 1;
    const n = this.block;
    this.aes.encryptWords(swap32(n >>> 0), swap32(Math.floor(n / 2 ** 32)), 0, 0, this.ks);
    if (bytes) {
      for (let j = 0; j < 4; j++) {
        const v = this.ks[j];
        bytes[4 * j] = v >>> 24;
        bytes[4 * j + 1] = (v >>> 16) & 0xff;
        bytes[4 * j + 2] = (v >>> 8) & 0xff;
        bytes[4 * j + 3] = v & 0xff;
      }
    }
  }

  update(data) {
    const out = new Uint8Array(data.length);
    this.position += data.length;
    let i = 0;
    // What is left of a block started earlier.
    while (this.used < 16 && i < data.length) out[i] = data[i++] ^ this.stream[this.used++];
    const ks = this.ks;
    if (i % 4 === 0 && LITTLE_ENDIAN) {
      // Whole blocks four bytes at a time: the data copied into `out`, the key stream XORed in.
      const n = (data.length - i) & ~15;
      out.set(data.subarray(i, i + n), i);
      const words = new Uint32Array(out.buffer, i, n / 4);
      for (let j = 0; j < words.length; j += 4) {
        this.next(null);
        words[j] ^= swap32(ks[0]);
        words[j + 1] ^= swap32(ks[1]);
        words[j + 2] ^= swap32(ks[2]);
        words[j + 3] ^= swap32(ks[3]);
      }
      i += n;
    }
    for (; i + 16 <= data.length; i += 16) {
      this.next(null);
      for (let j = 0; j < 4; j++) {
        const v = ks[j];
        const at = i + 4 * j;
        out[at] = data[at] ^ (v >>> 24);
        out[at + 1] = data[at + 1] ^ ((v >>> 16) & 0xff);
        out[at + 2] = data[at + 2] ^ ((v >>> 8) & 0xff);
        out[at + 3] = data[at + 3] ^ (v & 0xff);
      }
    }
    if (i < data.length) {
      this.next(this.stream);
      this.used = 0;
      while (i < data.length) out[i] = data[i++] ^ this.stream[this.used++];
    }
    return out;
  }
}

// ------------------------------------------------------------------------------------------
// SHA-1 and HMAC, fed piece by piece
// ------------------------------------------------------------------------------------------

export class Sha1 {
  constructor() {
    this.h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    this.block = new Uint8Array(64);
    this.used = 0;
    this.length = 0;
    this.w = new Uint32Array(80);
  }

  update(data) {
    this.length += data.length;
    let i = 0;
    if (this.used) {
      const n = Math.min(64 - this.used, data.length);
      this.block.set(data.subarray(0, n), this.used);
      this.used += n;
      i = n;
      if (this.used < 64) return this;
      this.compress(this.block, 0);
      this.used = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.used = data.length - i;
    }
    return this;
  }

  compress(d, at) {
    const w = this.w;
    for (let t = 0; t < 16; t++) w[t] = (d[at + 4 * t] << 24) | (d[at + 4 * t + 1] << 16) | (d[at + 4 * t + 2] << 8) | d[at + 4 * t + 3];
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = this.h[0];
    let b = this.h[1];
    let c = this.h[2];
    let dd = this.h[3];
    let e = this.h[4];
    let t = 0;
    for (; t < 20; t++) {
      const temp = (((a << 5) | (a >>> 27)) + ((b & c) | (~b & dd)) + e + 0x5a827999 + w[t]) | 0;
      e = dd;
      dd = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    for (; t < 40; t++) {
      const temp = (((a << 5) | (a >>> 27)) + (b ^ c ^ dd) + e + 0x6ed9eba1 + w[t]) | 0;
      e = dd;
      dd = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    for (; t < 60; t++) {
      const temp = (((a << 5) | (a >>> 27)) + ((b & c) | (b & dd) | (c & dd)) + e + 0x8f1bbcdc + w[t]) | 0;
      e = dd;
      dd = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    for (; t < 80; t++) {
      const temp = (((a << 5) | (a >>> 27)) + (b ^ c ^ dd) + e + 0xca62c1d6 + w[t]) | 0;
      e = dd;
      dd = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    const h = this.h;
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += dd;
    h[4] += e;
  }

  digest() {
    const bits = this.length * 8;
    const pad = new Uint8Array((this.used < 56 ? 64 : 128) - this.used);
    pad[0] = 0x80;
    const tail = new DataView(pad.buffer);
    tail.setUint32(pad.length - 8, Math.floor(bits / 2 ** 32));
    tail.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(20);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 5; i++) dv.setUint32(4 * i, this.h[i]);
    return out;
  }
}

export class HmacSha1 {
  constructor(key) {
    const k = new Uint8Array(64);
    k.set(key.length > 64 ? new Sha1().update(key).digest() : key);
    const ipad = k.map((b) => b ^ 0x36);
    this.opad = k.map((b) => b ^ 0x5c);
    this.inner = new Sha1().update(ipad);
  }

  update(data) {
    this.inner.update(data);
    return this;
  }

  digest() {
    return new Sha1().update(this.opad).update(this.inner.digest()).digest();
  }
}
