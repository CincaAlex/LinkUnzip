// CRC-32 (the one zip uses), slicing-by-8: eight bytes per step, several hundred MB/s in V8.

const TABLES = (() => {
  const t = new Uint32Array(8 * 256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 8; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c >>> 0;
    }
  }
  return t;
})();

/** Continue a CRC over `bytes`. Start with 0; the result is the finished CRC of everything so far. */
export function crc32(crc, bytes) {
  const t = TABLES;
  let c = ~crc >>> 0;
  let i = 0;
  const n = bytes.length;
  const end8 = n - (n % 8);
  while (i < end8) {
    const a = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) ^ c;
    const b = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
    c =
      t[1792 + (a & 0xff)] ^
      t[1536 + ((a >>> 8) & 0xff)] ^
      t[1280 + ((a >>> 16) & 0xff)] ^
      t[1024 + (a >>> 24)] ^
      t[768 + (b & 0xff)] ^
      t[512 + ((b >>> 8) & 0xff)] ^
      t[256 + ((b >>> 16) & 0xff)] ^
      t[b >>> 24];
    i += 8;
  }
  while (i < n) c = t[(c ^ bytes[i++]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}
