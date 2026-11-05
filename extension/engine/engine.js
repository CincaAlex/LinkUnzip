// The browser engine: answers the same messages as the native helper (src/host.rs), so the
// popup and the background treat both alike.
//
// Requests: hello, inspect, list, search, measure, extract, cancel, entry, neighbors,
// tick_matches. Replies: hello, index_progress, inspected, listing, search_results, measured,
// started, progress, done, cancelled, entry, neighbors, ticked, error. Every reply carries the
// request's `id`.
//
// The file list's selection comes as its ticks (`select: {marks}`, the nearest mark wins); the
// helper's `{paths, exclude}` still works.
//
// `inspect` and `extract` may name a zip inside the zip (`inner: [path, ...]`, a zip in a zip in
// a zip as a longer list). A stored inner zip is read with Range requests like any other; a
// compressed one only in one pass (`extract` with `stream: true`), as is a server without Range
// support. `extract` takes the zip's `password` when files in it are encrypted.

import { encryptionOf } from "./crypto.js";
import { entryBody } from "./entry.js";
import { Coded, describe } from "./errors.js";
import { extract } from "./extract.js";
import { Filter, listPath, regionEndOf } from "./plan.js";
import { Source, SubSource } from "./source.js";
import { streamExtract } from "./stream.js";
import { heldBackType } from "./dl-sink.js";
import { Tree, heldBack } from "./tree.js";
import { indexFromRaw, isDir, isEncrypted, needsPassword, readIndex, unsupportedReason } from "./zip.js";

export const PROTOCOL = 2;
export const FEATURES = ["list", "search", "measure", "select", "resume", "error_codes", "preview", "marks", "neighbors", "tick_matches", "index_progress", "stream", "password", "inner"];
/** Inspected archives kept for browsing; older ones are read again when asked about. */
const KEEP_INSPECTED = 8;
/** Zips inside zips, at most this deep (which also stops a zip that holds itself). */
const MAX_INNER = 4;
/** index_progress messages, at most this often. */
const INDEX_PROGRESS_MS = 250;

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function report(src, index, tree) {
  let files = 0;
  let dirs = 0;
  let compressed = 0;
  let extracted = 0;
  const unsupported = [];
  const held = new Map();
  const encryption = new Set();
  let encrypted = 0;
  let innerZips = 0;
  for (const e of index.entries) {
    if (isDir(e)) {
      dirs += 1;
      continue;
    }
    files += 1;
    compressed += e.csize;
    extracted += e.usize;
    const why = unsupportedReason(e);
    if (why) unsupported.push({ name: e.name, reason: why });
    else if (needsPassword(e)) {
      encrypted += 1;
      encryption.add(encryptionOf(e));
    }
    if (/\.zip$/i.test(e.name)) innerZips += 1;
    const ext = heldBackType(e.name);
    if (ext) held.set(ext, (held.get(ext) || 0) + 1);
  }
  const largest = index.entries
    .filter((e) => !isDir(e))
    .sort((a, b) => b.usize - a.usize)
    .slice(0, 5)
    .map((e) => ({ name: e.name, size: e.usize }));
  return {
    url: src.url,
    mode: "range",
    archive_size: src.size,
    etag: src.etag,
    last_modified: src.lastModified,
    files,
    dirs,
    entries_total: index.entries.length,
    dirs_total: tree.folderCount,
    index_bytes: src.indexBytes,
    compressed,
    extracted,
    normal_needs: src.size + extracted,
    linkunzip_needs: extracted,
    free: null,
    drive: null,
    normal_fits: null,
    linkunzip_fits: null,
    unsupported: unsupported.length,
    unsupported_sample: unsupported.slice(0, 3),
    encrypted,
    encryption: [...encryption],
    inner_zips: innerZips,
    inner: src.path ? innerPath(src) : [],
    largest,
    extensions: tree.extensions,
    index_cached: Boolean(index.cached),
    ...heldBack(held),
  };
}

/** The chain of inner zip paths a SubSource stands for, outermost first. */
function innerPath(src) {
  const chain = [];
  for (let s = src; s?.path; s = s.outer) chain.unshift(s.path);
  return chain;
}

/** The inner zip's entry: by its path as the file list shows it. */
function findEntry(index, path) {
  return index.entries.find((e) => !isDir(e) && listPath(e.name) === path) || null;
}

/**
 * A compressed (or encrypted) zip inside the zip as a body to read once from its first byte, the
 * way streamExtract wants it. Its CRC-32 is checked at the end like any file's.
 */
function entryStream(src, index, entry, password, signal) {
  const body = entryBody(src, entry, regionEndOf(index)(entry.offset), password, { signal });
  return { body, length: entry.usize, etag: src.etag, lastModified: src.lastModified, contentType: "application/zip" };
}

/**
 * `post(message)` sends a reply; `openSink(target, job)` turns an extract request's `target` into
 * a sink (fsa-sink.js or dl-sink.js), with a `label` for messages. `job` is the job's id.
 * `indexCache` ({get, put}, store.js) keeps indexes read before, so they aren't downloaded again.
 */
export function createEngine({ post, openSink, version = "0", indexCache = null }) {
  const inspected = new Map(); // id -> { src, index, tree }
  const running = new Map(); // id -> AbortController

  const reply = (type, id, body = {}) => post({ ...body, type, id });
  const fail = (id, e, url) => {
    const d = describe(e);
    post({ type: "error", id, ...d, host: url ? hostOf(url) : undefined });
  };

  function keep(id, value) {
    inspected.delete(id);
    inspected.set(id, value);
    while (inspected.size > KEEP_INSPECTED) inspected.delete(inspected.keys().next().value);
  }

  function withTree(id, answer) {
    const known = inspected.get(id);
    if (!known) return fail(id, new Coded("unknown_job", `no inspected archive with id ${JSON.stringify(id)}`));
    try {
      answer(known);
    } catch (e) {
      fail(id, e);
    }
  }

  /** The index of `src`: from the cache when this exact version was read before, else fetched. */
  async function loadIndex(src, onProgress) {
    const key = src.identityKey();
    if (key && indexCache) {
      const raw = await indexCache.get(key).catch(() => null);
      if (raw) {
        try {
          return { ...indexFromRaw(raw), cached: true };
        } catch {
          // A damaged entry: read the index again.
        }
      }
    }
    const index = await readIndex(src, { onProgress });
    if (key && indexCache) indexCache.put(key, index.raw, { url: src.url, size: src.size }).catch(() => {});
    return index;
  }

  /**
   * The zip a request is about: the link's, or the zip inside it that `inner` names. `{src,
   * index}`, or `{compressed: {src, index, entry}}` for an inner zip that can only be read in one
   * pass (compressed or encrypted inside the outer one).
   */
  async function resolve(m, signal, onProgress) {
    const inner = m.inner || [];
    if (inner.length > MAX_INNER) throw new Coded("bad_request", `zips inside zips are opened ${MAX_INNER} levels deep at most`);
    let src = await Source.probe(m.url, { credentials: m.credentials, signal });
    for (let i = 0; i < inner.length; i++) {
      const index = await loadIndex(src);
      const entry = findEntry(index, inner[i]);
      if (!entry) throw new Coded("bad_request", `there is no file ${JSON.stringify(inner[i])} in the zip`);
      if (entry.method !== 0 || isEncrypted(entry)) {
        if (i < inner.length - 1) {
          throw new Coded("unsupported_entries", `${inner[i]} is compressed inside its zip, so the zips inside it can't be opened one by one.`);
        }
        return { compressed: { src, index, entry } };
      }
      src = await SubSource.open(src, entry, inner[i], regionEndOf(index)(entry.offset));
    }
    return { src, index: await loadIndex(src, onProgress) };
  }

  const compressedInner = (entry) =>
    new Coded(
      "inner_compressed",
      `${listPath(entry.name).split("/").pop()} is ${isEncrypted(entry) ? "encrypted" : "compressed"} inside the zip, so it can only be read from start to end: no file list, but LinkUnzip can extract all of it in one pass.`,
      { detail: `${entry.name}: method ${entry.method}, flags ${entry.flags}` },
    );

  async function inspect(m) {
    const { id, url } = m;
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      let last = 0;
      const r = await resolve(m, ctl.signal, (received, total) => {
        const now = Date.now();
        if (received && received < total && now - last < INDEX_PROGRESS_MS) return;
        last = now;
        reply("index_progress", id, { received, total });
      });
      if (r.compressed) throw compressedInner(r.compressed.entry);
      const { src, index } = r;
      const tree = new Tree(index.entries);
      keep(id, { src, index, tree, inner: (m.inner || []).join("\n") });
      reply("inspected", id, { report: report(src, index, tree) });
    } catch (e) {
      fail(id, e, url);
    } finally {
      running.delete(id);
    }
  }

  /** The link's zip and its index for an extraction, reusing the one read for the Cost Analysis. */
  async function sourceForExtract(m, signal) {
    if (m.inner?.length) {
      const r = await resolve(m, signal);
      if (r.compressed) throw compressedInner(r.compressed.entry);
      return r;
    }
    const src = await Source.probe(m.url, { credentials: m.credentials, signal });
    // The index read for the Cost Analysis is still good if the file didn't change since.
    const known = inspected.get(String(m.id).split(":")[0]);
    const same = known && !known.inner && known.src.url === m.url && known.src.size === src.size && known.src.etag === src.etag && known.src.lastModified === src.lastModified;
    if (!same) return { src, index: await loadIndex(src) };
    // Still part of what this job downloaded, just earlier.
    src.indexBytes += known.src.indexBytes;
    src.indexRequests += known.src.indexRequests;
    return { src, index: known.index };
  }

  /** One pass from the first byte: a server without Range support, or a compressed inner zip. */
  async function runStream(m, sink, filter, signal, onProgress) {
    let open;
    if (m.inner?.length) {
      const r = await resolve(m, signal);
      if (!r.compressed) {
        // Stored inside: Range requests work after all.
        return extract({ src: r.src, index: r.index, filter, sink, jobs: m.jobs || 4, resume: Boolean(m.resume), password: m.password ?? null, signal, onProgress });
      }
      const { src, index, entry } = r.compressed;
      open = () => entryStream(src, index, entry, m.password ?? null, signal);
    }
    return streamExtract({ url: m.url, credentials: m.credentials, open, sink, filter, resume: Boolean(m.resume), password: m.password ?? null, signal, onProgress });
  }

  async function runExtract(m) {
    const ctl = new AbortController();
    running.set(m.id, ctl);
    let sink = null;
    let last = null;
    try {
      sink = await openSink(m.target, String(m.id).split(":")[0]);
      reply("started", m.id, { output: sink.label });
      const filter = new Filter(m.include || [], m.select);
      const onProgress = (p) => {
        last = p;
        post({ ...p, id: m.id });
      };
      let summary;
      if (m.stream) summary = await runStream(m, sink, filter, ctl.signal, onProgress);
      else {
        const { src, index } = await sourceForExtract(m, ctl.signal);
        summary = await extract({
          src,
          index,
          filter,
          sink,
          jobs: m.jobs || 4,
          resume: Boolean(m.resume),
          password: m.password ?? null,
          signal: ctl.signal,
          onProgress,
        });
      }
      reply("done", m.id, { ...summary, output: sink.label });
    } catch (e) {
      if (ctl.signal.aborted && ctl.signal.reason === "cancel") {
        reply("cancelled", m.id, { output: sink?.label, files_done: last?.files_done || 0, extracted_bytes: last?.extracted || 0 });
      } else {
        fail(m.id, e, m.url);
      }
    } finally {
      running.delete(m.id);
    }
  }

  return {
    get busy() {
      return running.size > 0;
    },

    handle(m) {
      switch (m?.type) {
        case "hello":
          return post({ type: "hello", version, protocol: PROTOCOL, features: FEATURES, os: "browser", engine: "browser", downloads_dir: "" });
        case "inspect":
          return inspect(m);
        case "extract":
          return runExtract(m);
        case "cancel":
          running.get(m.id)?.abort("cancel");
          return;
        case "list":
          return withTree(m.id, ({ tree }) => {
            const page = tree.list(m.dir || "", m.offset || 0, m.limit || 500);
            if (!page) throw new Coded("bad_request", `there is no folder ${JSON.stringify(m.dir)} in the archive`);
            reply("listing", m.id, page);
          });
        case "search":
          return withTree(m.id, ({ tree }) => {
            const r = tree.find(m.query || "", m.limit || 200);
            reply("search_results", m.id, { query: m.query, ...r });
          });
        case "measure":
          return withTree(m.id, ({ tree }) => {
            reply("measured", m.id, tree.measure(new Filter([], m.select)));
          });
        case "entry":
          // What the viewer needs to read one file itself: where it is and how it's stored.
          return withTree(m.id, ({ src, index, tree }) => {
            const e = tree.entryAt(m.path);
            if (!e) throw new Coded("bad_request", `there is no file ${JSON.stringify(m.path)} in the archive`);
            const end = regionEndOf(index)(e.offset);
            reply("entry", m.id, { path: m.path, source: src.toJSON(), entry: { ...e, regionEnd: end }, unsupported: unsupportedReason(e), encrypted: needsPassword(e) });
          });
        case "neighbors":
          // The viewer's Previous / Next: the files around this one in its folder.
          return withTree(m.id, ({ tree }) => {
            const n = tree.neighbors(m.path);
            if (!n) throw new Coded("bad_request", `there is no file ${JSON.stringify(m.path)} in the archive`);
            reply("neighbors", m.id, { path: m.path, ...n });
          });
        case "tick_matches":
          // "Select all results": every file the search finds, ticked (or not) on top of the
          // marks, said with as few marks as possible.
          return withTree(m.id, ({ tree }) => {
            reply("ticked", m.id, { query: m.query, ...tree.tickMatches(m.marks, m.query || "", m.ticked !== false) });
          });
        default:
          return fail(m?.id, new Coded("bad_request", `unknown request ${JSON.stringify(m?.type)}`));
      }
    },
  };
}
