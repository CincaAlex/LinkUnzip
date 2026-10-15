// The browser engine: answers the same messages as the native helper (src/host.rs), so the
// popup and the background treat both alike.
//
// Requests: hello, inspect, list, search, measure, extract, cancel, entry.
// Replies: hello, inspected, listing, search_results, measured, started, progress, done,
// cancelled, entry, error. Every reply carries the request's `id`.

import { Coded, describe } from "./errors.js";
import { extract } from "./extract.js";
import { Filter } from "./plan.js";
import { Source } from "./source.js";
import { heldBackType } from "./dl-sink.js";
import { Tree, heldBack } from "./tree.js";
import { isDir, readIndex, unsupportedReason } from "./zip.js";

export const PROTOCOL = 2;
export const FEATURES = ["list", "search", "measure", "select", "resume", "error_codes", "preview"];
/** Inspected archives kept for browsing; older ones are read again when asked about. */
const KEEP_INSPECTED = 8;

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
    largest,
    ...heldBack(held),
  };
}

/**
 * `post(message)` sends a reply; `openSink(target, job)` turns an extract request's `target` into
 * a sink (fsa-sink.js or dl-sink.js), with a `label` for messages. `job` is the job's id.
 */
export function createEngine({ post, openSink, version = "0" }) {
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

  async function inspect({ id, url, credentials }) {
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      const src = await Source.probe(url, { credentials, signal: ctl.signal });
      const index = await readIndex(src);
      const tree = new Tree(index.entries);
      keep(id, { src, index, tree });
      reply("inspected", id, { report: report(src, index, tree) });
    } catch (e) {
      fail(id, e, url);
    } finally {
      running.delete(id);
    }
  }

  async function runExtract(m) {
    const ctl = new AbortController();
    running.set(m.id, ctl);
    let sink = null;
    let last = null;
    try {
      sink = await openSink(m.target, String(m.id).split(":")[0]);
      reply("started", m.id, { output: sink.label });
      const src = await Source.probe(m.url, { credentials: m.credentials, signal: ctl.signal });
      // The index read for the Cost Analysis is still good if the file didn't change since.
      const known = inspected.get(String(m.id).split(":")[0]);
      const same = known && known.src.url === m.url && known.src.size === src.size && known.src.etag === src.etag && known.src.lastModified === src.lastModified;
      const index = same ? known.index : await readIndex(src);
      if (same) {
        // Still part of what this job downloaded, just earlier.
        src.indexBytes += known.src.indexBytes;
        src.indexRequests += known.src.indexRequests;
      }
      const filter = new Filter(m.include || [], m.select);
      const summary = await extract({
        src,
        index,
        filter,
        sink,
        jobs: m.jobs || 4,
        resume: Boolean(m.resume),
        signal: ctl.signal,
        onProgress: (p) => {
          last = p;
          post({ ...p, id: m.id });
        },
      });
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
            let end = index.centralDirOffset;
            for (const o of index.entries) if (o.offset > e.offset && o.offset < end) end = o.offset;
            reply("entry", m.id, { path: m.path, source: src.toJSON(), entry: { ...e, regionEnd: end }, unsupported: unsupportedReason(e) });
          });
        default:
          return fail(m?.id, new Coded("bad_request", `unknown request ${JSON.stringify(m?.type)}`));
      }
    },
  };
}
