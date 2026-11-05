// Zips built byte by byte for the engine tests (tools/engine_test.mjs): stored or deflate, with
// or without data descriptors, ZipCrypto or WinZip AES, zips inside zips, and a central directory
// that can be made to disagree with the local headers. The encryption here uses node:crypto, not
// the extension's own code, so the tests check one against the other.

import crypto from "node:crypto";
import zlib from "node:zlib";

import { crc32 } from "../extension/engine/crc32.js";

const TIME = 0x6a2f; // 13:17:30
const DATE = 0x5b5f; // 2025-10-31

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** ZipCrypto, the encrypting direction. */
function zipCrypto(password, plain) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const step = (b) => {
    k0 = (table[(k0 ^ b) & 0xff] ^ (k0 >>> 8)) >>> 0;
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = (table[(k2 ^ (k1 >>> 24)) & 0xff] ^ (k2 >>> 8)) >>> 0;
  };
  for (const b of Buffer.from(password, "utf8")) step(b);
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) {
    const t = (k2 | 2) & 0xffff;
    out[i] = plain[i] ^ ((Math.imul(t, t ^ 1) >>> 8) & 0xff);
    step(plain[i]);
  }
  return out;
}

/** WinZip AES: salt, verifier, AES-CTR with a little-endian counter from 1, 10-byte HMAC-SHA1. */
function winzipAes(password, plain, strength, { corruptMac = false } = {}) {
  const keyLen = 8 + 8 * strength;
  const salt = crypto.randomBytes(4 + 4 * strength);
  const keys = crypto.pbkdf2Sync(Buffer.from(password, "utf8"), salt, 1000, 2 * keyLen + 2, "sha1");
  const encKey = keys.subarray(0, keyLen);
  const macKey = keys.subarray(keyLen, 2 * keyLen);
  const ecb = crypto.createCipheriv(`aes-${keyLen * 8}-ecb`, encKey, null).setAutoPadding(false);
  const blocks = Math.ceil(plain.length / 16);
  const counters = Buffer.alloc(blocks * 16);
  for (let b = 0; b < blocks; b++) counters.writeUInt32LE(b + 1, b * 16);
  const stream = ecb.update(counters);
  const enc = Buffer.from(plain.map((x, i) => x ^ stream[i]));
  const mac = crypto.createHmac("sha1", macKey).update(enc).digest().subarray(0, 10);
  if (corruptMac) mac[0] ^= 1;
  return Buffer.concat([salt, keys.subarray(2 * keyLen), enc, mac]);
}

/**
 * A zip of `files`: `{name, data, method = 8, descriptor, encryption: "zipcrypto"|"aes",
 * password, strength = 3, ae = 2, corruptMac, listedSize}`. `listedSize` puts another size in the
 * central directory than in the local header (a zip that shows different files to different tools).
 */
export function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = Buffer.from(f.data);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(0, data);
    let method = f.method ?? 8;
    let body = method === 8 ? zlib.deflateRawSync(data) : data;
    let flags = 0x800;
    let extra = Buffer.alloc(0);
    let crcField = crc;
    if (f.encryption === "zipcrypto") {
      flags |= 1;
      const header = crypto.randomBytes(12);
      header[11] = f.descriptor ? (TIME >>> 8) & 0xff : crc >>> 24;
      body = zipCrypto(f.password, Buffer.concat([header, body]));
    } else if (f.encryption === "aes") {
      flags |= 1;
      const strength = f.strength ?? 3;
      const ae = f.ae ?? 2;
      extra = Buffer.concat([u16(0x9901), u16(7), u16(ae), Buffer.from("AE"), Buffer.from([strength]), u16(method)]);
      body = winzipAes(f.password, body, strength, f);
      method = 99;
      if (ae === 2) crcField = 0;
    }
    if (f.descriptor) flags |= 8;
    const header = Buffer.concat([
      u32(0x04034b50), u16(method === 99 ? 51 : 20), u16(flags), u16(method), u16(TIME), u16(DATE),
      u32(f.descriptor ? 0 : crcField), u32(f.descriptor ? 0 : body.length), u32(f.descriptor ? 0 : data.length),
      u16(name.length), u16(extra.length), name, extra,
    ]);
    const descriptor = f.descriptor ? Buffer.concat([u32(0x08074b50), u32(crcField), u32(body.length), u32(data.length)]) : Buffer.alloc(0);
    parts.push(header, body, descriptor);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(0x031e), u16(method === 99 ? 51 : 20), u16(flags), u16(method), u16(TIME), u16(DATE),
      u32(crcField), u32(body.length), u32(f.listedSize ?? data.length),
      u16(name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(offset), name, extra,
    ]));
    offset += header.length + body.length + descriptor.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset), u16(0)]);
  return Buffer.concat([...parts, cd, eocd]);
}

/** Deterministic bytes, so two versions of a file can be told apart and checked. */
export function bytesOf(seed, n) {
  const out = Buffer.alloc(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
}

export const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
