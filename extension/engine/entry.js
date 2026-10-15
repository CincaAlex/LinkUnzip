// One entry's data: position on it, then yield its uncompressed bytes as they arrive. Used by the
// extraction and by the file preview. Inflating is the browser's own DecompressionStream.

import { failed } from "./errors.js";
import { LOCAL_FIXED_LEN, LOCAL_SIG, METHOD_STORED } from "./zip.js";

const CHUNK = 1 << 20;

/** Skip to the entry's local header and past it; the local name and extra lengths decide. */
export async function seekToData(reader, entry) {
  await reader.skipTo(entry.offset);
  const header = await reader.readExact(LOCAL_FIXED_LEN);
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (dv.getUint32(0, true) !== LOCAL_SIG) {
    throw failed("expected a local file header (PK\\x03\\x04) but found something else: wrong offset or corrupt archive");
  }
  await reader.skip(dv.getUint16(26, true) + dv.getUint16(28, true));
}

/**
 * The entry's uncompressed bytes, chunk by chunk. Reads exactly `csize` compressed bytes at most,
 * so the next entry stays in reach. `onData(n)` hears about every compressed byte consumed.
 * A deflate stream that ends before its last bytes (padding) raises an error with `junk` set;
 * the caller decides, from the size and CRC it saw, whether the file is complete.
 */
export async function* entryChunks(reader, entry, onData = () => {}) {
  if (entry.method === METHOD_STORED) {
    let left = entry.csize;
    while (left > 0) {
      const c = await reader.next(Math.min(left, CHUNK));
      left -= c.length;
      onData(c.length);
      yield c;
    }
    return;
  }
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  let pumpError = null;
  const pump = (async () => {
    let left = entry.csize;
    try {
      while (left > 0) {
        const c = await reader.next(Math.min(left, CHUNK));
        left -= c.length;
        onData(c.length);
        await writer.write(c);
      }
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
