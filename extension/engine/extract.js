// The extraction: one Range request per span of neighbouring files, a few spans at a time, each
// file inflated, checked (size and CRC-32) and written as it arrives. A file only gets its real
// name once it checked out (the sink's close); anything else is thrown away (abort).
//
// When the connection drops, a stored file goes on from the byte where it stopped (a new Range
// request from there); a compressed one starts again, since the inflater can't pick up midway.
//
// Sinks may keep a record of finished files for Resume (`begin`, `finished`, `end`): the folder
// sink writes the helper's .linkunzip-resume.jsonl, the Downloads sink remembers what it saved.

import { crc32 } from "./crc32.js";
import { entryChunks, seekToData } from "./entry.js";
import { Coded, failed, isTransient } from "./errors.js";
import { check, splitSpans } from "./plan.js";
import { ByteReader, RETRY, delayAfter, sleep } from "./source.js";
import { METHOD_STORED } from "./zip.js";

const PROGRESS_MS = 250;
/** A stored file that got this much further since its last drop counts its drops afresh. */
const PROGRESS_RESET = 1 << 20;
/**
 * Finished files whose close() may still be running. Chrome gives a file its name on close (a
 * round trip to the browser, plus its own checks), which costs milliseconds per file: letting the
 * next file start meanwhile is what makes zips with many small files fast.
 */
const MAX_CLOSING = 64;

class Stats {
  constructor(plan, src) {
    this.totalFiles = plan.files.length;
    this.totalCompressed = plan.files.reduce((n, f) => n + f.entry.csize, 0);
    this.totalExtracted = plan.files.reduce((n, f) => n + f.entry.usize, 0);
    this.downloaded = 0;
    this.extracted = 0;
    this.filesDone = 0;
    this.retries = 0;
    this.requests = 0;
    this.indexBytes = src.indexBytes;
    this.indexRequests = src.indexRequests;
    this.skipped = { files: 0, compressed: 0, extracted: 0 };
    this.active = new Set();
    this.started = Date.now();
    this.samples = [];
  }

  /** Bytes per second over the last few seconds. */
  rate() {
    const now = Date.now();
    this.samples.push([now, this.downloaded]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 4000) this.samples.shift();
    const [t0, d0] = this.samples[0];
    return now > t0 ? ((this.downloaded - d0) * 1000) / (now - t0) : 0;
  }

  progress() {
    const rate = this.rate();
    const downloaded = Math.min(this.downloaded, this.totalCompressed);
    const remaining = Math.max(0, this.totalCompressed - downloaded);
    const active = [...this.active];
    return {
      type: "progress",
      downloaded,
      total_compressed: this.totalCompressed,
      extracted: this.extracted,
      total_extracted: this.totalExtracted,
      files_done: this.filesDone,
      total_files: this.totalFiles,
      skipped_files: this.skipped.files,
      skipped_compressed: this.skipped.compressed,
      skipped_extracted: this.skipped.extracted,
      rate: Math.round(rate),
      eta_secs: rate >= 1 ? Math.round(remaining / rate) : null,
      active: active.slice(0, 3),
      active_count: active.length,
      retries: this.retries,
      requests: this.indexRequests + this.requests,
      zip_on_disk: 0,
      free: null,
      elapsed_ms: Date.now() - this.started,
    };
  }
}

/**
 * Is the file at `parts` already there with this entry's size and CRC-32? `journalOnly`: only
 * what the journal of an earlier run lists counts (a fresh start doesn't read files back).
 */
async function alreadyDone(sink, file, signal, journalOnly = false) {
  // A sink that can't read its files back knows itself what it saved.
  if (sink.isDone) return !journalOnly && sink.isDone(file.parts, file.entry);
  // Finished by an earlier run of this same archive (its journal says so) and still there.
  if (sink.journaled?.(file.entry) && (await sink.exists(file.parts))) return true;
  if (journalOnly) return false;
  const size = await sink.stat(file.parts);
  if (size !== file.entry.usize) return false;
  let crc = 0;
  for await (const chunk of sink.read(file.parts)) {
    if (signal.aborted) throw signal.reason;
    crc = crc32(crc, chunk);
  }
  if (crc !== file.entry.crc) return false;
  sink.finished?.(file);
  return true;
}

/** The archive's identity as the helper's resume journal writes it (src/resume.rs). */
const identityOf = (src) => ({
  v: 1,
  size: src.size,
  etag: src.etag ? src.etag.trim().replace(/^W\//, "") : null,
  last_modified: src.lastModified || null,
});

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Extract the entries `filter` selects from `index` (read from `src`) into `sink`.
 * `onProgress` gets a progress message about four times a second.
 */
export async function extract({ src, index, filter, sink, jobs = 4, resume = false, signal, onProgress = () => {} }) {
  const checked = check(index, filter);
  const begun = await sink.begin?.({ key: src.identityKey?.() ?? null, identity: identityOf(src), resume });
  // A fresh start into a folder an unfinished run of this same zip left behind carries on too:
  // the files its journal lists are skipped.
  const earlier = !resume && begun?.earlier > 0;
  let summary;
  try {
    summary = await run({ src, checked, sink, jobs, resume: resume || earlier, journalOnly: earlier, signal, onProgress });
  } catch (e) {
    await sink.end?.(false).catch(() => {});
    throw e;
  }
  await sink.end?.(true).catch(() => {});
  return summary;
}

async function run({ src, checked, sink, jobs, resume, journalOnly, signal, onProgress }) {
  const inner = new AbortController();
  const stop = () => inner.abort(signal.reason);
  if (signal.aborted) stop();
  signal.addEventListener("abort", stop, { once: true });

  let files = checked.files;
  const skipped = { files: 0, compressed: 0, extracted: 0 };
  if (resume) {
    const done = await mapLimit(files, 4, (f) => alreadyDone(sink, f, inner.signal, journalOnly).catch(() => false));
    const keep = [];
    files.forEach((f, i) => {
      if (!done[i]) return keep.push(f);
      skipped.files += 1;
      skipped.compressed += f.entry.csize;
      skipped.extracted += f.entry.usize;
    });
    files = keep;
  }
  const spans = splitSpans(files, jobs);
  const stats = new Stats({ files }, src);
  stats.skipped = skipped;
  for (const dir of checked.dirs) await sink.mkdir(dir);

  const timer = setInterval(() => onProgress(stats.progress()), PROGRESS_MS);
  onProgress(stats.progress());
  let firstError = null;

  // A verified file is handed over here; its close() runs while the next file streams in.
  const closing = new Set();
  const finish = async (out, file) => {
    const p = out.close().then(
      () => {
        stats.filesDone += 1;
        sink.finished?.(file);
      },
      (e) => {
        if (!firstError) firstError = e;
        inner.abort(e);
      },
    );
    closing.add(p);
    p.finally(() => closing.delete(p));
    if (closing.size >= MAX_CLOSING) await Promise.race(closing);
  };

  const runSpan = async (span) => {
    let reader = null;
    try {
      for (const file of span.files) {
        stats.active.add(file.entry.name);
        // What survives a dropped connection: the open file and how far it got (stored files).
        const carry = { out: null, crc: 0, written: 0, dataStart: 0, downloaded: 0, extracted: 0 };
        for (let attempt = 1; ; attempt++) {
          const tally = { downloaded: 0, extracted: 0 };
          try {
            if (!reader) {
              stats.requests += 1;
              const from = carry.out ? carry.dataStart + carry.written : file.entry.offset;
              const resp = await src.openRange(from, span.end, inner.signal);
              reader = new ByteReader(resp.body, from);
            }
            await extractEntry(reader, file, sink, stats, tally, inner.signal, finish, carry);
            break;
          } catch (e) {
            reader?.cancel();
            reader = null;
            const again = isTransient(e) && attempt < RETRY.attempts && !inner.signal.aborted;
            if (again && carry.out && file.entry.method === METHOD_STORED) {
              // Keep what arrived; the next request starts where it stopped.
              carry.downloaded += tally.downloaded;
              carry.extracted += tally.extracted;
              if (tally.downloaded >= PROGRESS_RESET) attempt = 0;
            } else {
              stats.downloaded -= tally.downloaded + carry.downloaded;
              stats.extracted -= tally.extracted + carry.extracted;
              Object.assign(carry, { downloaded: 0, extracted: 0 });
              if (carry.out) await carry.out.abort();
              carry.out = null;
            }
            if (again) {
              stats.retries += 1;
              await sleep(delayAfter(Math.max(1, attempt)), inner.signal);
              continue;
            }
            if (e instanceof Coded && !e.detail?.startsWith("extracting")) {
              e.detail = `extracting ${JSON.stringify(file.entry.name)} failed${isTransient(e) ? ` after ${attempt} attempts` : ""}: ${e.detail || e.message}`;
            }
            throw e;
          }
        }
        stats.active.delete(file.entry.name);
      }
    } finally {
      reader?.cancel();
    }
  };

  const queue = [...spans];
  const worker = async () => {
    while (queue.length && !inner.signal.aborted) {
      try {
        await runSpan(queue.shift());
      } catch (e) {
        if (!firstError) firstError = e;
        inner.abort(e);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, jobs), spans.length) }, worker));
    await Promise.all(closing);
  } finally {
    clearInterval(timer);
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("cancelled", "AbortError");
  if (firstError) throw firstError;
  onProgress(stats.progress());

  return {
    files: stats.filesDone,
    dirs: checked.dirs.length,
    extracted_bytes: stats.extracted,
    downloaded_bytes: stats.indexBytes + stats.downloaded,
    index_bytes: stats.indexBytes,
    verified_files: stats.filesDone + skipped.files,
    skipped_existing: skipped.files,
    skipped_bytes: skipped.extracted,
    archive_size: src.size,
    normal_needs: src.size + stats.totalExtracted + skipped.extracted,
    elapsed_ms: Date.now() - stats.started,
    retries: stats.retries,
    requests: stats.indexRequests + stats.requests,
    zip_bytes_on_disk: 0,
    renamed: checked.renames.length + sink.renames.length,
    renamed_sample: [...checked.renames, ...sink.renames].slice(0, 3),
    // Files Chrome's downloads hold back until the user says to keep them (see dl-sink.js).
    held: sink.held?.length || 0,
    held_sample: (sink.held || []).slice(0, 5),
    held_ids: (sink.held || []).slice(0, 1000).map((f) => f.id),
    stream: false,
  };
}

/**
 * One file: positioned on its local header (or, carrying on after a drop, on the next byte of its
 * data), streamed, checked and handed to `finish`. On failure the file stays open in `carry`; the
 * caller decides whether it goes on or is thrown away.
 */
async function extractEntry(reader, file, sink, stats, tally, signal, finish, carry) {
  const entry = file.entry;
  if (!carry.out) {
    await seekToData(reader, entry);
    carry.dataStart = reader.pos;
    carry.out = await sink.create(file.parts, entry);
    carry.crc = 0;
    carry.written = 0;
  }
  const out = carry.out;
  const onData = (n) => {
    stats.downloaded += n;
    tally.downloaded += n;
  };
  try {
    for await (const chunk of entryChunks(reader, entry, onData, carry.written)) {
      if (signal.aborted) throw signal.reason;
      if (carry.written + chunk.length > entry.usize) {
        throw failed(`the data expands beyond the ${entry.usize} bytes declared for this entry (zip bomb or corrupt archive)`);
      }
      await out.write(chunk);
      carry.written += chunk.length;
      carry.crc = crc32(carry.crc, chunk);
      stats.extracted += chunk.length;
      tally.extracted += chunk.length;
    }
  } catch (e) {
    // Padding after a complete deflate stream: fine when everything else checks out.
    if (!(e.junk && carry.written === entry.usize && carry.crc === entry.crc)) throw e;
  }
  if (carry.written !== entry.usize) {
    throw failed(`size mismatch: the entry says ${entry.usize} bytes, the data gave ${carry.written}`);
  }
  if (carry.crc !== entry.crc) {
    throw failed(`CRC-32 mismatch (expected ${entry.crc.toString(16).padStart(8, "0")}, got ${carry.crc.toString(16).padStart(8, "0")}): the data is corrupt`);
  }
  // Checked: from here on the file only needs its name (close), which may finish later.
  carry.out = null;
  await finish(out, file);
}
