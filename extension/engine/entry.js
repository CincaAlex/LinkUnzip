// One entry's data: position on it, then yield its uncompressed bytes as they arrive. Used by the
// extraction and by the file preview. Inflating is the browser's own DecompressionStream; an
// encrypted entry goes through its decryptor (crypto.js) first.

import { crc32 } from "./crc32.js";
import { checksCrc, openDecryptor, realMethod } from "./crypto.js";
import { failed } from "./errors.js";
import { ByteReader } from "./source.js";
import { LOCAL_FIXED_LEN, LOCAL_SIG, METHOD_STORED, needsPassword } from "./zip.js";

const CHUNK = 1 << 20;

const NOT_LOCAL = "expected a local file header (PK\\x03\\x04) but found something else: wrong offset or corrupt archive";

/** Skip to the entry's local header and past it; the local name and extra lengths decide. */
export async function seekToData(reader, entry) {
  await reader.skipTo(entry.offset);
  const header = await reader.readExact(LOCAL_FIXED_LEN);
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (dv.getUint32(0, true) !== LOCAL_SIG) throw failed(NOT_LOCAL);
  await reader.skip(dv.getUint16(26, true) + dv.getUint16(28, true));
}

/** Where the entry's data starts in `src`: one small read of its local header. */
export async function dataStartOf(src, entry) {
  const head = await src.getBytes(entry.offset, Math.min(src.size, entry.offset + LOCAL_FIXED_LEN) - 1);
  const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < LOCAL_FIXED_LEN || dv.getUint32(0, true) !== LOCAL_SIG) throw failed(NOT_LOCAL);
  return entry.offset + LOCAL_FIXED_LEN + dv.getUint16(26, true) + dv.getUint16(28, true);
}

/**
 * The entry's uncompressed bytes as a ReadableStream, fetched with one range request (up to
 * `regionEnd`, where the next entry starts): a compressed zip inside the zip read in one pass,
 * and the preview's streamed files. `skip` leaves out the first bytes and `limit` stops after
 * that many (a player that asked for one part). Read to its end, the size and CRC-32 are
 * checked; a mismatch errors the stream. `onData(n)` hears about the bytes downloaded.
 */
export function entryBody(src, entry, regionEnd, password, { skip = 0, limit = Infinity, signal, onData = () => {} } = {}) {
  let reader = null;
  let gen = null;
  let crc = 0;
  let size = 0;
  let sent = 0;
  const stop = () => {
    gen?.return();
    reader?.cancel();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        if (!gen) {
          const resp = await src.openRange(entry.offset, regionEnd - 1, signal);
          reader = new ByteReader(resp.body, entry.offset, onData);
          await seekToData(reader, entry);
          gen = entryChunks(reader, entry, () => {}, 0, await decryptorFor(reader, entry, password));
        }
        for (;;) {
          const r = await gen.next();
          if (r.done) {
            if (size !== entry.usize || (checksCrc(entry) && crc !== entry.crc)) {
              return controller.error(failed(`${entry.name}: the data failed its size or CRC-32 check (corrupt archive)`));
            }
            return controller.close();
          }
          crc = crc32(crc, r.value);
          const at = size;
          size += r.value.length;
          if (size <= skip) continue;
          let part = at < skip ? r.value.subarray(skip - at) : r.value;
          if (sent + part.length >= limit) {
            part = part.subarray(0, limit - sent);
            controller.enqueue(part);
            controller.close();
            return stop();
          }
          sent += part.length;
          controller.enqueue(part);
          return;
        }
      } catch (e) {
        controller.error(e);
      }
    },
    cancel: stop,
  });
}

/**
 * Check `password` on one encrypted entry of `src` before anything is written: one small read of
 * its local header and encryption header. Throws `password_needed` or `password_wrong`.
 */
export async function checkPassword(src, entry, password) {
  const end = Math.min(src.size - 1, entry.offset + LOCAL_FIXED_LEN + 0xffff * 2 + 32);
  const resp = await src.openRange(entry.offset, end);
  const reader = new ByteReader(resp.body, entry.offset);
  try {
    await seekToData(reader, entry);
    await openDecryptor(reader, entry, password);
  } finally {
    reader.cancel();
  }
}

/** The decryptor for `entry` if it is encrypted (reads its encryption header), else null. */
export const decryptorFor = (reader, entry, password) => (needsPassword(entry) ? openDecryptor(reader, entry, password) : null);

/**
 * The entry's uncompressed bytes, chunk by chunk. Reads exactly `csize` compressed bytes at most,
 * so the next entry stays in reach. `onData(n)` hears about every compressed byte consumed.
 * A deflate stream that ends before its last bytes (padding) raises an error with `junk` set;
 * the caller decides, from the size and CRC it saw, whether the file is complete.
 * A stored entry can start `from` bytes into its data (the reader is already there): that is how
 * a file goes on after the connection dropped.
 * `dec` is the entry's decryptor (decryptorFor), its header already read; its trailer is read
 * and checked after the data.
 */
export async function* entryChunks(reader, entry, onData = () => {}, from = 0, dec = null) {
  const dataLen = entry.csize - (dec ? dec.before + dec.after : 0);
  const plain = dec ? (c) => dec.update(c) : (c) => c;
  if (dec) onData(dec.before);
  const done = async () => {
    if (!dec) return;
    await dec.finish();
    onData(dec.after);
  };
  if (realMethod(entry) === METHOD_STORED) {
    let left = dataLen - from;
    while (left > 0) {
      const c = await reader.next(Math.min(left, CHUNK));
      left -= c.length;
      onData(c.length);
      yield plain(c);
    }
    await done();
    return;
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  let pumpError = null;
  const pump = (async () => {
    let left = dataLen;
    try {
      while (left > 0) {
        const c = await reader.next(Math.min(left, CHUNK));
        left -= c.length;
        onData(c.length);
        await writer.write(plain(c));
      }
      await done();
      await writer.close();
    } catch (e) {
      pumpError = e;
      writer.abort(e).catch(() => {});
    }
  })();
  const out = ds.readable.getReader();
  let finished = false;
  try {
    for (;;) {
      let r;
      try {
        r = await out.read();
      } catch (e) {
        await pump;
        // A network problem while feeding the inflater wins over the inflater's own complaint.
        if (pumpError && pumpError.name !== "TypeError") throw pumpError;
        const err = failed(`the compressed data of this entry is corrupt (${e?.message || e})`);
        err.junk = /junk/i.test(String(e?.message || e));
        throw err;
      }
      if (r.done) break;
      yield r.value;
    }
    await pump;
    if (pumpError) throw pumpError;
    finished = true;
  } finally {
    if (!finished) {
      out.cancel().catch(() => {});
      writer.abort().catch(() => {});
    }
  }
}
