// Tests for the browser engine (extension/engine), run under Node against a local Range server
// and the same test zips the helper's tests use:
//
//   python tools/make_test_zips.py all-small --out <data>
//   python tools/make_malicious_zips.py --out <data>/malicious
//   node tools/engine_test.mjs <data>
//
// Node has fetch and DecompressionStream like the browser; only the folder is different (plain
// files here, a folder handle in the extension).
//
// `--only=swap,ifrange,stream,password,inner,top` runs just those groups.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveObjectURL } from "node:buffer";

import { crc32 } from "../extension/engine/crc32.js";
import { downloadsName, downloadsSink } from "../extension/engine/dl-sink.js";
import { decryptorFor, entryChunks, seekToData } from "../extension/engine/entry.js";
import { createEngine } from "../extension/engine/engine.js";
import { Filter } from "../extension/engine/plan.js";
import { ByteReader, Source } from "../extension/engine/source.js";
import { Tree } from "../extension/engine/tree.js";
import { readIndex } from "../extension/engine/zip.js";
import { bytesOf, makeZip, sha256 as sha256Of } from "./test_zips.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.argv[2] || "test-data");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const wanted = (group) => !ONLY.length || ONLY.includes(group);
const PORT = 8190;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(ok, what, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && extra ? `\n      ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** Plain files under `root`, with the same interface as engine/fsa-sink.js. */
function nodeSink(root, folder = null) {
  return {
    label: root,
    renames: [],
    folder,
    async holdsOnly(name) {
      const names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.name !== ".linkunzip-resume.jsonl");
      return names.length === 1 && names[0].isDirectory() && names[0].name.toLowerCase() === name.toLowerCase();
    },
    async mkdir(parts) {
      fs.mkdirSync(path.join(root, ...parts), { recursive: true });
    },
    async create(parts) {
      const final = path.join(root, ...parts);
      fs.mkdirSync(path.dirname(final), { recursive: true });
      const temp = `${final}.crswap`;
      const fd = fs.openSync(temp, "w");
      return {
        async write(chunk) {
          fs.writeSync(fd, chunk);
        },
        async close() {
          fs.closeSync(fd);
          fs.renameSync(temp, final);
        },
        async abort() {
          try {
            fs.closeSync(fd);
          } catch {}
          fs.rmSync(temp, { force: true });
        },
      };
    },
    async stat(parts) {
      try {
        return fs.statSync(path.join(root, ...parts)).size;
      } catch {
        return null;
      }
    },
    async *read(parts) {
      yield* fs.createReadStream(path.join(root, ...parts));
    },
  };
}

/**
 * The Downloads sink with a stand-in for Chrome's downloads: files land under `root`, each save
 * takes `delayMs`, and `answer(filename)` can make Chrome refuse or hold a file.
 */
function fakeDownloads(root, { delayMs = 5, answer = () => null, saved = new Map() } = {}) {
  const stats = { active: 0, max: 0, firstAlone: true, saves: 0, names: [] };
  const sink = downloadsSink({
    sub: "zip",
    label: "Downloads > zip",
    saved,
    save: async ({ url, filename }) => {
      stats.active += 1;
      stats.max = Math.max(stats.max, stats.active);
      if (stats.saves === 0 && stats.active > 1) stats.firstAlone = false;
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        const special = answer(filename);
        if (special) return special;
        const blob = resolveObjectURL(url);
        if (!blob) return { ok: false, code: "failed", error: "blob URL gone" };
        const file = path.join(root, ...filename.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
        stats.names.push(filename);
        return { ok: true };
      } finally {
        stats.active -= 1;
        stats.saves += 1;
      }
    },
  });
  return { sink, stats };
}

/** What Chrome's downloads accepted and refused, measured in Chrome 155 (tools/e2e). */
function checkDownloadsNames() {
  const cases = {
    ".gitignore": "_.gitignore",
    ".github/ci.yml": "_.github/ci.yml",
    "a/.env": "a/_.env",
    "x.lnk": "x.lnk_",
    "x.local": "x.local_",
    "x.scf": "x.scf_",
    "x.URL": "x.URL_",
    "desktop.ini": "_desktop.ini",
    "Thumbs.db": "_Thumbs.db",
    "~$doc.docx": "_$doc.docx",
    "a~1.txt": "a_1.txt",
    "con.txt": "_con.txt",
    "clock$": "_clock$",
    " lead.txt": "_ lead.txt",
    "a\u00adb.txt": "a_b.txt",
    "x.{20d04fe0-3aea-1069-a2d8-08002b30309d}": "x.{20d04fe0-3aea-1069-a2d8-08002b30309d}_",
    // accepted as they are
    "a b/c d.txt": "a b/c d.txt",
    "üñí/ć.txt": "üñí/ć.txt",
    "x..txt": "x..txt",
    "$a.txt": "$a.txt",
    "x.website": "x.website",
    "setup.exe": "setup.exe",
  };
  let bad = [];
  for (const [from, want] of Object.entries(cases)) {
    const got = downloadsName(from.split("/")).parts.join("/");
    if (got !== want) bad.push(`${from} -> ${got} (want ${want})`);
  }
  check(bad.length === 0, `downloads names: ${Object.keys(cases).length} names Chrome refuses or takes`, bad.join("; "));
}

async function checkDownloadsSink() {
  // 30 files through the sink: right bytes, the first one alone, never more than 8 at once.
  const root = tempDir("dl");
  const { sink, stats } = fakeDownloads(root, { delayMs: 15 });
  const files = Array.from({ length: 30 }, (_, i) => ({ parts: ["d", `f${i}.bin`], data: crypto.randomBytes(1000 + i * 37), crc: i, usize: 1000 + i * 37 }));
  await Promise.all(
    files.map(async (f) => {
      const out = await sink.create(f.parts, { crc: f.crc, usize: f.usize });
      await out.write(f.data.subarray(0, 500));
      await out.write(f.data.subarray(500));
      await out.close();
    }),
  );
  const same = files.every((f) => fs.readFileSync(path.join(root, "zip", ...f.parts)).equals(f.data));
  check(same, "downloads sink: every file arrives with the right bytes");
  check(stats.firstAlone && stats.max > 1 && stats.max <= 8, `downloads sink: the first file alone, then up to 8 at once (max ${stats.max})`);
  check(sink.isDone(files[3].parts, { crc: 3, usize: files[3].usize }) && !sink.isDone(files[3].parts, { crc: 99, usize: 1 }), "downloads sink: remembers what it saved, for Resume");

  // Chrome refuses a name: the sink tries a plainer one and reports the rename.
  const r2 = tempDir("dl");
  const { sink: s2 } = fakeDownloads(r2, { answer: (name) => (name.includes("ird") ? { ok: false, code: "bad_name", error: "Invalid filename" } : null) });
  const w = await s2.create(["we!ird#name.txt"], { crc: 1, usize: 2 });
  await w.write(Buffer.from("hi"));
  let threw = null;
  await w.close().catch((e) => (threw = e));
  check(threw?.code === "folder_not_writable", `downloads sink: a name Chrome keeps refusing fails clearly (${threw?.message})`);
  const { sink: s3, stats: st3 } = fakeDownloads(tempDir("dl"), { answer: (name) => (name.includes("#") ? { ok: false, code: "bad_name", error: "Invalid filename" } : null) });
  const w3 = await s3.create(["a#b.txt"], { crc: 1, usize: 2 });
  await w3.write(Buffer.from("hi"));
  await w3.close();
  check(st3.names.includes("zip/a_b.txt") && s3.renames.length === 1, `downloads sink: a refused name gets a plainer one (${st3.names})`);

  // Held back by Chrome: counted, not remembered as saved.
  const { sink: s4 } = fakeDownloads(tempDir("dl"), { answer: (name) => (name.endsWith(".exe") ? { ok: true, held: "uncommon" } : null) });
  const w4 = await s4.create(["tool.exe"], { crc: 5, usize: 2 });
  await w4.write(Buffer.from("MZ"));
  await w4.close();
  check(s4.held.length === 1 && s4.held[0].why === "uncommon" && !s4.isDone(["tool.exe"], { crc: 5, usize: 2 }), "downloads sink: a file Chrome holds back is reported");

  // Chrome set to ask where to save each file.
  const { sink: s5 } = fakeDownloads(tempDir("dl"), { answer: () => ({ ok: false, code: "ask_where", error: "USER_CANCELED" }) });
  const w5 = await s5.create(["a.txt"], { crc: 1, usize: 1 });
  await w5.write(Buffer.from("a"));
  let asked = null;
  await w5.close().catch((e) => (asked = e));
  check(asked?.code === "ask_where", `downloads sink: "ask where to save" stops with its own error (${asked?.code})`);
}

/** A whole extraction into the stand-in Downloads, then Resume skipping what it saved. */
async function checkDownloadsExtract(kind) {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, `${kind}.manifest.json`), "utf8"));
  const root = tempDir(`dl-${kind}`);
  const saved = new Map();
  const extractInto = (request) =>
    new Promise((resolve) => {
      const engine = createEngine({
        post: (m) => final(m) && resolve(m),
        openSink: async () => fakeDownloads(root, { delayMs: 1, saved }).sink,
      });
      engine.handle(request);
    });
  const url = `${BASE}/${kind}.zip`;
  const done = await extractInto({ type: "extract", id: `dl-${kind}:x`, url, target: { key: "downloads", sub: "zip" }, jobs: 4, credentials: "omit" });
  check(done.type === "done" && done.verified_files === manifest.files.length, `downloads: ${kind} extracted (${done.files} files, ${done.renamed} renamed)`, JSON.stringify(done).slice(0, 300));
  let bad = 0;
  for (const f of manifest.files) {
    const p = path.join(root, "zip", ...downloadsName(f.name.split("/")).parts);
    if (!fs.existsSync(p) || sha256(p) !== f.sha256) bad += 1;
  }
  check(bad === 0, `downloads: ${kind} matches the manifest's SHA-256 (${manifest.files.length - bad}/${manifest.files.length})`);
  const again = await extractInto({ type: "extract", id: `dl-${kind}:x`, url, target: { key: "downloads", sub: "zip" }, jobs: 4, resume: true, credentials: "omit" });
  check(again.type === "done" && again.skipped_existing === manifest.files.length && again.files === 0, `downloads: Resume skips the ${again.skipped_existing} files it saved`);
}

/** Send one request to a fresh engine and collect replies until `until` says stop. */
function run(request, until, target = null, { indexCache = null } = {}) {
  return new Promise((resolve) => {
    const replies = [];
    const engine = createEngine({
      post: (m) => {
        replies.push(m);
        if (until(m)) resolve({ replies, last: m, engine });
      },
      openSink: async (t) => nodeSink(t),
      indexCache,
    });
    engine.handle({ ...request, target: target ?? request.target });
  });
}

/** A store.js stand-in kept in memory: the record of what a run into Downloads saved. */
function memoryRunStore() {
  const runs = new Map();
  return {
    runs,
    async openRun(run) {
      const rows = runs.get(run) || new Map();
      return {
        async load() {
          return [...rows];
        },
        add(p, sig) {
          rows.set(p, sig);
          runs.set(run, rows);
        },
        async flush() {},
        async clear() {
          rows.clear();
          runs.delete(run);
        },
      };
    },
  };
}

/** Deterministic random numbers, so a failing case can be found again. */
function seeded(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

/** The file list's engine questions straight on the tree: totals, select all results, Prev / Next, search. */
async function checkTree(kind) {
  const src = await Source.probe(`${BASE}/${kind}.zip`, { credentials: "omit" });
  const index = await readIndex(src);
  const tree = new Tree(index.entries);
  const files = [...tree.fileIndex.keys()];
  const folders = tree.folders.map((f) => f.path);
  const rand = seeded(7);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const same = (a, b) => ["files", "extracted", "compressed", "unsupported", "held_back"].every((k) => a[k] === b[k]);

  // Totals from whole folders agree with a walk over every entry ("*" forces the walk).
  let bad = 0;
  let fastMs = 0;
  let slowMs = 0;
  for (let t = 0; t < 60; t++) {
    const marks = {};
    const n = 1 + Math.floor(rand() * 6);
    for (let k = 0; k < n; k++) marks[rand() < 0.5 ? pick(folders) : pick(files)] = rand() < 0.5;
    let t0 = performance.now();
    const fast = tree.measure(new Filter([], { marks }));
    fastMs += performance.now() - t0;
    t0 = performance.now();
    const slow = tree.measure(new Filter(["*"], { marks }));
    slowMs += performance.now() - t0;
    if (!same(fast, slow)) bad += 1;
  }
  check(bad === 0, `${kind}: totals of 60 random tick mixes match a full walk (${(fastMs / 60).toFixed(2)} ms vs ${(slowMs / 60).toFixed(2)} ms each)`);

  // Select all results: every match ticked, said with few marks, and back again.
  const ext = tree.extensions[0]?.ext;
  const query = `*.${ext}`;
  const matches = tree.find(query, 0).total;
  const on = tree.tickMatches({ "": false }, query, true);
  const onTotals = tree.measure(new Filter([], { marks: on.marks }));
  const off = tree.tickMatches(on.marks, query, false);
  const offTotals = tree.measure(new Filter([], { marks: off.marks }));
  check(
    on.matched === matches && onTotals.files === matches && offTotals.files === 0 && Object.keys(on.marks).length <= matches + 1,
    `${kind}: Select all ${matches} results for ${query} ticks exactly those (${Object.keys(on.marks).length} marks), Select none unticks them`,
  );
  const everyFile = tree.find("", 0).total;
  check(tree.find("*", 0).total === everyFile && tree.find(query.toUpperCase(), 0).total === matches, `${kind}: search takes patterns, case-insensitive (${everyFile} files)`);

  // Prev / Next: the neighbours in the folder's own order.
  const folder = tree.folders.find((f) => f.files.length >= 3);
  const mid = tree.fileItem(folder.files[1]).path;
  const n = tree.neighbors(mid);
  check(n.prev === tree.fileItem(folder.files[0]).path && n.next === tree.fileItem(folder.files[2]).path && n.position === 2, `${kind}: Previous / Next around ${mid}`);
  const t0 = performance.now();
  for (const p of files.slice(0, 2000)) tree.entryAt(p);
  check(tree.entryAt(files[files.length - 1]) !== null, `${kind}: 2,000 file lookups for the preview in ${(performance.now() - t0).toFixed(1)} ms`);
}

/** The nearest tick wins, also deep inside an unticked folder of a ticked zip. */
async function checkNearestTick() {
  const src = await Source.probe(`${BASE}/small.zip`, { credentials: "omit" });
  const tree = new Tree((await readIndex(src)).entries);
  const top = tree.folders[0].folders.map((f) => tree.folders[f]).find((f) => f.files_count >= 3);
  const inner = [...tree.fileIndex.keys()].find((p) => p.startsWith(top.path));
  const marks = { [top.path]: false, [inner]: true };
  const out = tempDir("marks");
  const r = await run({ type: "extract", id: "mk:x", url: `${BASE}/small.zip`, select: { marks }, credentials: "omit" }, final, out);
  const written = listFiles(out);
  const others = written.filter((f) => !f.startsWith(top.path));
  check(
    r.last.type === "done" && written.includes(inner) && written.filter((f) => f.startsWith(top.path)).length === 1 && others.length === tree.folders[0].files_count - top.files_count,
    `nearest tick wins: ${top.path} unticked, one file in it ticked, everything else kept (${written.length} files)`,
    JSON.stringify(r.last).slice(0, 300),
  );
}

/** The index cache: a second look at the same zip downloads no index, and says so. */
async function checkIndexCache() {
  const store = new Map();
  const indexCache = { get: async (k) => store.get(k) ?? null, put: async (k, raw) => store.set(k, raw) };
  const first = await run({ type: "inspect", id: "ic", url: `${BASE}/many.zip`, credentials: "omit" }, final, null, { indexCache });
  const progress = first.replies.filter((m) => m.type === "index_progress");
  check(progress.length >= 1 && progress[0].total > 0 && progress.every((m) => m.received <= m.total), `index progress: ${progress.length} updates while reading a ${(progress[0]?.total / 1048576).toFixed(1)} MB index`);
  const second = await run({ type: "inspect", id: "ic2", url: `${BASE}/many.zip`, credentials: "omit" }, final, null, { indexCache });
  const a = first.last.report;
  const b = second.last.report;
  check(!a.index_cached && b.index_cached && b.files === a.files && b.index_bytes < 10_000, `index cache: the second look is cached (${a.index_bytes} then ${b.index_bytes} index bytes)`);
  const out = tempDir("cached");
  const ex = await run({ type: "extract", id: "ic3:x", url: `${BASE}/small.zip`, credentials: "omit" }, final, out, { indexCache });
  check(ex.last.type === "done" && store.size === 2, "index cache: an extraction fills it too");
}

/** Resume into Downloads after the engine's page closed: the record in the store still knows. */
async function checkDownloadsResumeAfterClose() {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, "many.manifest.json"), "utf8"));
  const wanted = manifest.files.filter((f) => /^many\/d00[0-2]\//.test(f.name)).length;
  const root = tempDir("dl-close");
  const store = memoryRunStore();
  const url = `${BASE}/many.zip`;
  const select = { marks: { "": false, "many/d000/": true, "many/d001/": true, "many/d002/": true } };
  const request = { type: "extract", id: "dc:x", url, select, target: { key: "downloads", sub: "zip" }, jobs: 2, credentials: "omit" };
  // A fresh `saved` map each time: that's what a newly opened engine page starts with.
  const engineWith = (onPost) => createEngine({ post: onPost, openSink: async () => downloadsSink({ sub: "zip", label: "Downloads > zip", saved: new Map(), store, save: saveInto(root) }) });
  const stopped = await new Promise((resolve) => {
    let sent = false;
    const e = engineWith((m) => {
      if (m.type === "progress" && m.files_done > 300 && !sent) {
        sent = true;
        e.handle({ type: "cancel", id: "dc:x" });
      }
      if (final(m)) resolve(m);
    });
    e.handle(request);
  });
  const recorded = [...store.runs.values()][0]?.size || 0;
  const resumed = await new Promise((resolve) => {
    const e = engineWith((m) => final(m) && resolve(m));
    e.handle({ ...request, resume: true });
  });
  check(
    stopped.type === "cancelled" && recorded >= stopped.files_done && resumed.type === "done" && resumed.skipped_existing >= stopped.files_done && resumed.files + resumed.skipped_existing === wanted,
    `Downloads: stopped after ${stopped.files_done} files, a new engine page resumed and skipped ${resumed.skipped_existing} (record kept ${recorded})`,
    JSON.stringify(resumed).slice(0, 300),
  );
  check(store.runs.size === 0, "Downloads: the record goes once the extraction finished");
}

/** The Downloads stand-in without the timing bookkeeping. */
function saveInto(root) {
  return async ({ url, filename }) => {
    const blob = resolveObjectURL(url);
    const file = path.join(root, ...filename.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    return { ok: true };
  };
}

/**
 * A big stored file through a connection that keeps dropping halfway (range_server.py with
 * DROP_EVERY=1 cuts every response over 2 MB in half): it goes on from where it stopped each
 * time, which starting again from byte 0 never could.
 */
async function checkStoredContinues() {
  const dir = tempDir("drop");
  const zip = path.join(dir, "bigstored.zip");
  const made = spawnSync("python", ["-c", `
import os, zipfile, sys, hashlib
data = os.urandom(9 * 1024 * 1024)
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr(zipfile.ZipInfo("big/stored.bin"), data, compress_type=zipfile.ZIP_STORED)
    z.writestr("small.txt", b"after the big one\\n" * 100, compress_type=zipfile.ZIP_DEFLATED)
print(hashlib.sha256(data).hexdigest())
`, zip], { encoding: "utf8" });
  const want = made.stdout.trim();
  const port = PORT + 1;
  const server = spawn("python", [path.join(here, "range_server.py"), dir, String(port)], { stdio: "ignore", env: { ...process.env, DROP_EVERY: "1" } });
  try {
    for (let i = 0; i < 150; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD" });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const out = tempDir("drop-out");
    const r = await run({ type: "extract", id: "dr:x", url: `http://127.0.0.1:${port}/bigstored.zip`, jobs: 1, credentials: "omit" }, final, out);
    const got = fs.existsSync(path.join(out, "big", "stored.bin")) ? sha256(path.join(out, "big", "stored.bin")) : "";
    check(r.last.type === "done" && r.last.retries >= 2 && got === want && listFiles(out).includes("small.txt"), `a stored file carries on after ${r.last.retries} dropped connections (${r.last.requests} requests, SHA-256 ${got === want ? "matches" : "differs"})`, JSON.stringify(r.last).slice(0, 300));
  } finally {
    server.kill();
  }
}

// ------------------------------------------------------------------------------------------
// A server for what range_server.py can't play
// ------------------------------------------------------------------------------------------

/**
 * Files with several versions (`put(name, ...versions)`, `swap(name)` serves the next one), the
 * validators of a chosen kind (`etag`, `weak`, `lm`, `none`), a server that answers 200 to every
 * If-Range (`honourIfRange: false`), one without Range support that sends no length (GitHub's
 * zips: `range: false`), and a connection cut at a given byte (`cut(at, times)`).
 * `onRequest(req)` runs before each answer (a test swaps the file there).
 */
async function testServer({ range = true, validators = "etag", honourIfRange = true, sameValidators = false } = {}) {
  const files = new Map();
  const st = { requests: [], cutAt: null, cuts: 0, onRequest: null };
  const meta = (f) => {
    const v = sameValidators ? 0 : f.at;
    const lm = new Date(Date.UTC(2025, 0, 1 + v)).toUTCString();
    if (validators === "etag") return { etag: `"v${v}"`, lastModified: lm };
    if (validators === "weak") return { etag: `W/"v${v}"`, lastModified: null };
    if (validators === "lm") return { etag: null, lastModified: lm };
    return { etag: null, lastModified: null };
  };
  const server = http.createServer((req, res) => {
    const f = files.get(decodeURIComponent(req.url.slice(1)));
    if (!f) {
      res.writeHead(404);
      return res.end();
    }
    st.onRequest?.(req);
    st.requests.push({ range: req.headers.range || null, ifRange: req.headers["if-range"] || null });
    const data = f.versions[f.at];
    const m = meta(f);
    const headers = { "Content-Type": f.type || "application/zip" };
    if (m.etag) headers.ETag = m.etag;
    if (m.lastModified) headers["Last-Modified"] = m.lastModified;
    let start = 0;
    let end = data.length - 1;
    let status = 200;
    const r = range ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "") : null;
    if (r) {
      start = Number(r[1]);
      end = r[2] ? Math.min(Number(r[2]), data.length - 1) : data.length - 1;
      status = 206;
      const named = req.headers["if-range"];
      if (named && !(honourIfRange && (named === m.etag || named === m.lastModified))) {
        start = 0;
        end = data.length - 1;
        status = 200;
      }
    }
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
    if (range) headers["Content-Length"] = String(end - start + 1);
    res.writeHead(status, headers);
    const body = data.subarray(start, end + 1);
    if (st.cuts > 0 && st.cutAt != null && start < st.cutAt && end >= st.cutAt) {
      st.cuts -= 1;
      res.write(body.subarray(0, st.cutAt - start), () => setTimeout(() => res.destroy(), 30));
      return;
    }
    // GitHub's zips come in pieces, with no length.
    if (!range) {
      for (let at = 0; at < body.length; at += 1 << 16) res.write(body.subarray(at, at + (1 << 16)));
      return res.end();
    }
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    st,
    url: (name) => `${base}/${encodeURIComponent(name)}`,
    put(name, ...versions) {
      files.set(name, { versions: versions.map((v) => Buffer.from(v)), at: 0 });
    },
    type(name, type) {
      files.get(name).type = type;
    },
    swap(name) {
      const f = files.get(name);
      f.at = Math.min(f.at + 1, f.versions.length - 1);
    },
    cut(at, times = 1) {
      st.cutAt = at;
      st.cuts = times;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Every file under `out` with its SHA-256, by path. */
function shasIn(out) {
  return new Map(listFiles(out).map((f) => [f, sha256(path.join(out, f))]));
}

/** The files `want` ({path: data}) are all in `out`, byte for byte, and nothing else. */
function sameFiles(out, want) {
  const got = shasIn(out);
  const names = Object.keys(want);
  return got.size === names.length && names.every((n) => got.get(n) === sha256Of(want[n]));
}

// ------------------------------------------------------------------------------------------
// If-Range
// ------------------------------------------------------------------------------------------

async function checkIfRange() {
  const src = await Source.probe(`${BASE}/small.zip`, { credentials: "omit" });
  check(src.ifRange && src.ifRange === src.etag.trim(), `If-Range: range_server.py honours it, so every range request names ETag ${src.ifRange}`);

  const files = { "a.txt": bytesOf(5, 300_000), "b.bin": bytesOf(6, 200_000) };
  const zip = makeZip(Object.entries(files).map(([name, data]) => ({ name, data, method: name.endsWith(".bin") ? 0 : 8 })));
  const cases = [
    { validators: "etag", honourIfRange: true, want: '"v0"', what: "a strong ETag" },
    { validators: "lm", honourIfRange: true, want: new Date(Date.UTC(2025, 0, 1)).toUTCString(), what: "Last-Modified only" },
    { validators: "weak", honourIfRange: true, want: null, what: "a weak ETag (never sent: the server would always send the whole file)" },
    { validators: "etag", honourIfRange: false, want: null, what: "a server that answers 200 to every If-Range (turned off after the probe's check)" },
    { validators: "none", honourIfRange: true, want: null, what: "no validators" },
  ];
  for (const c of cases) {
    const s = await testServer(c);
    s.put("z.zip", zip);
    try {
      const probed = await Source.probe(s.url("z.zip"), { credentials: "omit" });
      const out = tempDir("ifr");
      const r = await run({ type: "extract", id: "ifr:x", url: s.url("z.zip"), jobs: 1, credentials: "omit" }, final, out);
      const data = s.st.requests.filter((q) => q.range && q.range !== "bytes=0-0");
      const sent = data.every((q) => q.ifRange === c.want);
      check(probed.ifRange === c.want && r.last.type === "done" && sameFiles(out, files) && sent, `If-Range with ${c.what}: ${c.want ? `sends ${c.want}` : "not sent"}, the extraction is right`, JSON.stringify({ probed: probed.ifRange, last: r.last.type, msg: r.last.message, data: data.slice(0, 3) }));
    } finally {
      await s.close();
    }
  }
}

// ------------------------------------------------------------------------------------------
// The archive swapped for another version of the same length
// ------------------------------------------------------------------------------------------

/** Two versions of one zip: same names, same sizes, same length; two.bin and three.bin differ. */
function swapPair() {
  const size = 1_500_000;
  const v = (two, three) => [
    { name: "one.bin", data: bytesOf(1, size), method: 0 },
    { name: "two.bin", data: bytesOf(two, size), method: 0 },
    { name: "three.bin", data: bytesOf(three, size), method: 0 },
  ];
  const a = v(2, 3);
  const b = v(22, 33);
  return { a: makeZip(a), b: makeZip(b), filesA: Object.fromEntries(a.map((f) => [f.name, f.data])) };
}

async function checkSwap() {
  const { a, b, filesA } = swapPair();
  check(a.length === b.length, `archive swap: both versions are ${a.length} bytes`);
  // two.bin's data starts after one.bin's local header (30 + 7 bytes) and data.
  const insideTwo = 30 + 7 + 1_500_000 + 30 + 7 + 700_000;
  const cases = [
    { validators: "etag", at: "data", want: /changed on the server since/, what: "strong ETag, swapped after the index read" },
    { validators: "etag", at: "retry", want: /changed on the server since/, what: "strong ETag, swapped across a retried stored file" },
    { validators: "etag", honourIfRange: false, at: "data", want: /ETag changed/, what: "strong ETag, server ignores If-Range" },
    { validators: "lm", at: "data", want: /changed on the server since/, what: "Last-Modified only" },
    { validators: "weak", at: "data", want: /ETag changed/, what: "weak ETag" },
    { validators: "none", at: "data", want: /CRC-32 mismatch/, what: "no validators at all" },
    { validators: "none", at: "retry", want: /CRC-32 mismatch/, what: "no validators, swapped across a retried stored file" },
    { validators: "etag", sameValidators: true, at: "data", want: /CRC-32 mismatch/, what: "validators that don't change with the content" },
  ];
  for (const c of cases) {
    const s = await testServer(c);
    s.put("z.zip", a, b);
    let dataRequests = 0;
    s.st.onRequest = (req) => {
      const r = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      // Not the probe (one byte) or the index read (the end of the file).
      if (!r || Number(r[2]) - Number(r[1]) < 1000 || Number(r[1]) >= a.length - 70_000) return;
      dataRequests += 1;
      if (dataRequests === (c.at === "retry" ? 2 : 1)) s.swap("z.zip");
    };
    if (c.at === "retry") s.cut(insideTwo);
    try {
      const out = tempDir("swap");
      const r = await run({ type: "extract", id: "sw:x", url: s.url("z.zip"), jobs: 1, credentials: "omit" }, final, out);
      const text = `${r.last.message} ${r.last.detail}`;
      // Whatever got its name is version A's file, byte for byte.
      const got = shasIn(out);
      const clean = [...got].every(([name, sha]) => sha === sha256Of(filesA[name]));
      check(r.last.type === "error" && c.want.test(text) && clean, `archive swap, ${c.what}: stops (${text.split("\n")[0].slice(0, 100)}); ${got.size} file(s) kept, all from the first version`, JSON.stringify(r.last).slice(0, 400));
    } finally {
      await s.close();
    }
  }

  // Resume after a swap: what was saved from the old version isn't skipped for the new one.
  const s = await testServer();
  s.put("z.zip", a, b);
  try {
    const before = await Source.probe(s.url("z.zip"), { credentials: "omit" });
    const store = memoryRunStore();
    // What an unfinished run of version A saved into Downloads.
    const recordA = async () => {
      const old = await store.openRun(`${before.identityKey()}\nzip`);
      for (const [name, data] of Object.entries(filesA)) old.add(name, `${crc32(0, data)}:${data.length}`);
    };
    const resumeNow = () =>
      new Promise((resolve) => {
        const root = tempDir("swap-dl");
        const e = createEngine({ post: (m) => final(m) && resolve(m), openSink: async () => downloadsSink({ sub: "zip", label: "Downloads > zip", saved: new Map(), store, save: saveInto(root) }) });
        e.handle({ type: "extract", id: "swr:x", url: s.url("z.zip"), target: { key: "downloads", sub: "zip" }, resume: true, jobs: 1, credentials: "omit" });
      });
    await recordA();
    const same = await resumeNow();
    await recordA();
    s.swap("z.zip");
    const resumed = await resumeNow();
    check(
      same.type === "done" && same.skipped_existing === 3 && resumed.type === "done" && resumed.skipped_existing === 0 && resumed.files === 3,
      `archive swap: Resume skips what version A saved (${same.skipped_existing}), but nothing once the file changed (${resumed.files} written, ${resumed.skipped_existing} skipped)`,
      JSON.stringify(resumed).slice(0, 300),
    );

    // The index cache: a new version is a new key.
    const cache = new Map();
    const indexCache = { get: async (k) => cache.get(k) ?? null, put: async (k, raw) => cache.set(k, raw) };
    s.put("z.zip", a, b);
    const first = await run({ type: "inspect", id: "swc", url: s.url("z.zip"), credentials: "omit" }, final, null, { indexCache });
    s.swap("z.zip");
    const second = await run({ type: "inspect", id: "swc2", url: s.url("z.zip"), credentials: "omit" }, final, null, { indexCache });
    check(first.last.type === "inspected" && second.last.type === "inspected" && !second.last.report.index_cached && cache.size === 2, "archive swap: the index cache keeps the two versions apart");
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------------------------------
// Stream mode: servers without Range support
// ------------------------------------------------------------------------------------------

async function streamInto(url, out, extra = {}) {
  return run({ type: "extract", id: `st${Math.random().toString(36).slice(2, 6)}:x`, url, stream: true, credentials: "omit", ...extra }, final, out);
}

async function checkStream() {
  const s = await testServer({ range: false, validators: "none" });
  try {
    for (const kind of ["small", "streamed"]) {
      s.put(`${kind}.zip`, fs.readFileSync(path.join(DATA, `${kind}.zip`)));
      const manifest = JSON.parse(fs.readFileSync(path.join(DATA, `${kind}.manifest.json`), "utf8"));
      const out = tempDir(`stream-${kind}`);
      const r = await streamInto(s.url(`${kind}.zip`), out);
      const bad = manifest.files.filter((f) => !fs.existsSync(path.join(out, ...f.name.split("/"))) || sha256(path.join(out, ...f.name.split("/"))) !== f.sha256);
      check(
        r.last.type === "done" && r.last.stream && bad.length === 0 && r.last.requests === 1 && r.last.listing_checked && r.last.listing_differs === 0,
        `stream: ${kind}.zip in one pass, no Range (${r.last.files} files, every SHA-256 right, the central directory agrees)`,
        JSON.stringify(r.last).slice(0, 400),
      );
      if (kind === "small") {
        const ins = await run({ type: "inspect", id: "nr", url: s.url("small.zip"), credentials: "omit" }, final);
        check(ins.last.code === "no_range", `stream: the same server answers no_range to inspect (${ins.last.code})`);
      }
    }

    // Data descriptors of every kind, and stored data that holds the descriptor's signature.
    const tricky = Buffer.concat([bytesOf(9, 100_000), Buffer.from("PK\x07\x08"), bytesOf(10, 100_000), Buffer.from("PK\x07\x08\x00\x00\x00\x00\x10\x00\x00\x00\x10\x00\x00\x00")]);
    const files = { "desc/stored.bin": tricky, "desc/deflate.txt": Buffer.from("streamed text\n".repeat(50_000)), "plain/a.csv": Buffer.from("a,b\n1,2\n".repeat(1000)), "plain/stored.bin": bytesOf(11, 70_000), "empty.txt": Buffer.alloc(0) };
    const zip = makeZip([
      { name: "desc/stored.bin", data: tricky, method: 0, descriptor: true },
      { name: "desc/deflate.txt", data: files["desc/deflate.txt"], descriptor: true },
      { name: "plain/a.csv", data: files["plain/a.csv"] },
      { name: "plain/stored.bin", data: files["plain/stored.bin"], method: 0 },
      { name: "empty.txt", data: files["empty.txt"], method: 0, descriptor: true },
    ]);
    s.put("tricky.zip", zip);
    let out = tempDir("stream-tricky");
    let r = await streamInto(s.url("tricky.zip"), out);
    check(r.last.type === "done" && sameFiles(out, files), "stream: stored and deflate entries with data descriptors, stored data holding the descriptor's signature", JSON.stringify(r.last).slice(0, 300));

    // Only some files.
    out = tempDir("stream-some");
    r = await streamInto(s.url("tricky.zip"), out, { include: ["*.csv"] });
    check(r.last.type === "done" && sameFiles(out, { "plain/a.csv": files["plain/a.csv"] }), "stream: a pattern writes only the matching files");

    // A dropped connection: the download starts again and skips what was finished.
    s.cut(Math.floor(zip.length * 0.6));
    out = tempDir("stream-drop");
    r = await streamInto(s.url("tricky.zip"), out);
    check(r.last.type === "done" && r.last.retries === 1 && r.last.requests === 2 && sameFiles(out, files), `stream: a dropped connection starts again from the first byte (${r.last.requests} requests), finished files skipped`, JSON.stringify(r.last).slice(0, 300));

    // Into Downloads.
    const root = tempDir("stream-dl");
    const dl = await new Promise((resolve) => {
      const e = createEngine({ post: (m) => final(m) && resolve(m), openSink: async () => fakeDownloads(root, { delayMs: 1 }).sink });
      e.handle({ type: "extract", id: "sdl:x", url: s.url("tricky.zip"), stream: true, target: { key: "downloads", sub: "zip" }, credentials: "omit" });
    });
    check(dl.type === "done" && sameFiles(path.join(root, "zip"), files), "stream: into Downloads too");

    // A central directory that lists another size than the local header.
    s.put("liar.zip", makeZip([{ name: "a.txt", data: Buffer.from("hello"), listedSize: 999 }, { name: "b.txt", data: Buffer.from("world") }]));
    r = await streamInto(s.url("liar.zip"), tempDir("stream-liar"));
    check(r.last.type === "done" && r.last.listing_differs === 1 && r.last.listing_differs_sample[0] === "a.txt", "stream: a file the central directory lists differently is reported");

    // Unsafe names stop it.
    s.put("slip.zip", makeZip([{ name: "ok.txt", data: Buffer.from("ok") }, { name: "../evil.txt", data: Buffer.from("evil") }]));
    out = tempDir("stream-slip");
    r = await streamInto(s.url("slip.zip"), out);
    check(r.last.type === "error" && /path traversal/.test(r.last.message) && !fs.existsSync(path.join(out, "..", "evil.txt")), `stream: "../evil.txt" is refused (${r.last.message.slice(0, 80)})`);

    // A web page instead of the zip.
    s.put("page.zip", Buffer.from("<!doctype html><title>Sign in</title>"));
    s.type("page.zip", "text/html");
    r = await streamInto(s.url("page.zip"), tempDir("stream-html"));
    check(r.last.code === "html_page", `stream: a web page answers html_page (${r.last.code})`);
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------------------------------
// Password-protected zips
// ------------------------------------------------------------------------------------------

async function checkPasswords() {
  const pw = "correct horse ünicode";
  const files = {
    "zc/stored.bin": bytesOf(21, 200_000),
    "zc/deflate.txt": Buffer.from("ZipCrypto deflate\n".repeat(20_000)),
    "zc/descriptor.txt": Buffer.from("ZipCrypto with a data descriptor\n".repeat(5_000)),
    "aes/128-ae1.txt": Buffer.from("AES-128, AE-1\n".repeat(10_000)),
    "aes/192-ae2-stored.bin": bytesOf(22, 150_001),
    "aes/256-ae2.txt": Buffer.from("AES-256, AE-2\n".repeat(30_000)),
    "aes/descriptor.txt": Buffer.from("AES with a data descriptor\n".repeat(30_000)),
    "plain.txt": Buffer.from("not encrypted"),
  };
  const zip = makeZip([
    { name: "zc/stored.bin", data: files["zc/stored.bin"], method: 0, encryption: "zipcrypto", password: pw },
    { name: "zc/deflate.txt", data: files["zc/deflate.txt"], encryption: "zipcrypto", password: pw },
    { name: "zc/descriptor.txt", data: files["zc/descriptor.txt"], encryption: "zipcrypto", password: pw, descriptor: true },
    { name: "aes/128-ae1.txt", data: files["aes/128-ae1.txt"], encryption: "aes", strength: 1, ae: 1, password: pw },
    { name: "aes/192-ae2-stored.bin", data: files["aes/192-ae2-stored.bin"], method: 0, encryption: "aes", strength: 2, ae: 2, password: pw },
    { name: "aes/256-ae2.txt", data: files["aes/256-ae2.txt"], encryption: "aes", strength: 3, ae: 2, password: pw },
    { name: "aes/descriptor.txt", data: files["aes/descriptor.txt"], encryption: "aes", strength: 1, ae: 1, password: pw, descriptor: true },
    { name: "plain.txt", data: files["plain.txt"] },
  ]);
  const s = await testServer();
  s.put("locked.zip", zip);
  try {
    const url = s.url("locked.zip");
    const ins = await run({ type: "inspect", id: "pw", url, credentials: "omit" }, final);
    const rep = ins.last.report;
    check(rep?.encrypted === 7 && rep.unsupported === 0 && rep.encryption.includes("aes") && rep.encryption.includes("zipcrypto"), `password: inspect counts 7 encrypted files, ZipCrypto and AES, none unsupported`, JSON.stringify(rep).slice(0, 300));

    let out = tempDir("pw-none");
    let r = await run({ type: "extract", id: "pw1:x", url, credentials: "omit" }, final, out);
    check(r.last.code === "password_needed" && listFiles(out).length === 0, `password: none given answers password_needed, nothing written (${r.last.code})`);
    out = tempDir("pw-wrong");
    r = await run({ type: "extract", id: "pw2:x", url, password: "wrong", credentials: "omit" }, final, out);
    check(r.last.code === "password_wrong" && listFiles(out).length === 0, `password: a wrong one answers password_wrong, nothing written (${r.last.code})`);
    out = tempDir("pw-right");
    r = await run({ type: "extract", id: "pw3:x", url, password: pw, credentials: "omit" }, final, out);
    check(r.last.type === "done" && sameFiles(out, files) && r.last.verified_files === 8, "password: ZipCrypto and AES-128/192/256 (AE-1, AE-2, stored, deflate, data descriptors) all extract right", JSON.stringify(r.last).slice(0, 300));
    out = tempDir("pw-stream");
    r = await run({ type: "extract", id: "pw4:x", url, password: pw, stream: true, credentials: "omit" }, final, out);
    check(r.last.type === "done" && r.last.stream && sameFiles(out, files), "password: the same zip in one pass (data descriptors: decrypted ahead of the inflater)", JSON.stringify(r.last).slice(0, 300));

    // Two passwords in one zip: the files the password doesn't open are left out and listed.
    s.put("mixed.zip", makeZip([
      { name: "a.txt", data: Buffer.from("first"), encryption: "aes", password: "one" },
      { name: "b.txt", data: Buffer.from("second"), encryption: "aes", password: "two" },
      { name: "c.txt", data: Buffer.from("third"), encryption: "zipcrypto", password: "one" },
    ]));
    out = tempDir("pw-mixed");
    r = await run({ type: "extract", id: "pw5:x", url: s.url("mixed.zip"), password: "one", credentials: "omit" }, final, out);
    check(r.last.type === "done" && r.last.other_password === 1 && r.last.other_password_sample[0] === "b.txt" && sameFiles(out, { "a.txt": "first", "c.txt": "third" }), "password: a file with another password is left out and reported", JSON.stringify(r.last).slice(0, 300));

    // A damaged authentication code: the file never gets its name.
    s.put("tampered.zip", makeZip([{ name: "t.txt", data: Buffer.from("tampered".repeat(100)), encryption: "aes", password: pw, corruptMac: true }]));
    out = tempDir("pw-mac");
    r = await run({ type: "extract", id: "pw6:x", url: s.url("tampered.zip"), password: pw, credentials: "omit" }, final, out);
    check(r.last.type === "error" && /authentication/.test(r.last.message) && listFiles(out).length === 0, `password: a damaged AES authentication code fails the file (${String(r.last.message).slice(0, 70)})`);

    // The viewer's way: one file read with its own decryptor.
    const entry = await new Promise((resolve) => {
      const e = createEngine({ post: (m) => (m.type === "inspected" ? e.handle({ type: "entry", id: "pwv", path: "aes/256-ae2.txt" }) : m.type === "entry" && resolve(m)), openSink: async () => null });
      e.handle({ type: "inspect", id: "pwv", url, credentials: "omit" });
    });
    const bytes = await readEntry(entry, pw);
    check(entry.encrypted && Buffer.from(bytes).equals(files["aes/256-ae2.txt"]), "password: the preview's read of one AES file");

    // Zips made by Windows' own tar (libarchive): ZipCrypto, AES-128, AES-256.
    const tar = "C:\\Windows\\System32\\tar.exe";
    if (process.platform === "win32" && fs.existsSync(tar)) {
      const dir = tempDir("tar-src");
      const made = { "a.txt": Buffer.from(`made by libarchive ${"x".repeat(5000)}\n`), "b.bin": bytesOf(31, 300_000) };
      for (const [n, d] of Object.entries(made)) fs.writeFileSync(path.join(dir, n), d);
      for (const kind of ["zipcrypt", "aes128", "aes256"]) {
        const z = path.join(dir, `${kind}.zip`);
        const t = spawnSync(tar, ["-a", "-cf", z, "--options", `zip:encryption=${kind}`, "--passphrase", "secret", "a.txt", "b.bin"], { cwd: dir });
        if (t.status !== 0) {
          console.log(`SKIP  password: Windows tar can't write ${kind} here`);
          continue;
        }
        s.put(`${kind}.zip`, fs.readFileSync(z));
        out = tempDir(`tar-${kind}`);
        r = await run({ type: "extract", id: `tar${kind}:x`, url: s.url(`${kind}.zip`), password: "secret", credentials: "omit" }, final, out);
        check(r.last.type === "done" && sameFiles(out, made), `password: a ${kind} zip made by Windows' tar extracts right`, JSON.stringify(r.last).slice(0, 300));
        out = tempDir(`tar-${kind}-stream`);
        r = await run({ type: "extract", id: `tars${kind}:x`, url: s.url(`${kind}.zip`), password: "secret", stream: true, credentials: "omit" }, final, out);
        check(r.last.type === "done" && sameFiles(out, made), `password: the same ${kind} zip in one pass`, JSON.stringify(r.last).slice(0, 300));
      }
    } else console.log("SKIP  password: no Windows tar to make zips with");
  } finally {
    await s.close();
  }
}

/** One entry's bytes the way viewer.js reads them (its own range request and decryptor). */
async function readEntry(info, password) {
  const src = Source.from(info.source);
  const e = info.entry;
  const resp = await src.openRange(e.offset, e.regionEnd - 1);
  const reader = new ByteReader(resp.body, e.offset);
  await seekToData(reader, e);
  const parts = [];
  for await (const c of entryChunks(reader, e, () => {}, 0, await decryptorFor(reader, e, password))) parts.push(Buffer.from(c));
  reader.cancel();
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------
// Zips inside zips
// ------------------------------------------------------------------------------------------

async function checkInner() {
  const small = fs.readFileSync(path.join(DATA, "small.zip"));
  const streamed = fs.readFileSync(path.join(DATA, "streamed.zip"));
  const smallManifest = JSON.parse(fs.readFileSync(path.join(DATA, "small.manifest.json"), "utf8"));
  const streamedManifest = JSON.parse(fs.readFileSync(path.join(DATA, "streamed.manifest.json"), "utf8"));
  const deep = makeZip([{ name: "deep.txt", data: Buffer.from("three levels down") }]);
  const l2 = makeZip([{ name: "l3.zip", data: deep, method: 0 }]);
  const l1 = makeZip([{ name: "l2.zip", data: l2, method: 0 }]);
  // An inner zip whose central directory claims to start past its own end.
  const broken = Buffer.from(makeZip([{ name: "x.txt", data: Buffer.from("x") }]));
  broken.writeUInt32LE(broken.length + 5000, broken.length - 6);
  let chain = makeZip([{ name: "end.txt", data: Buffer.from("end") }]);
  for (let i = 5; i >= 1; i--) chain = makeZip([{ name: `c${i}.zip`, data: chain, method: 0 }]);
  const outer = makeZip([
    { name: "readme.txt", data: Buffer.from("the outer zip") },
    { name: "data/small.zip", data: small, method: 0 },
    { name: "data/packed.zip", data: streamed, method: 8 },
    { name: "nest/l1.zip", data: l1, method: 0 },
    { name: "bad/broken.zip", data: broken, method: 0 },
    { name: "chain.zip", data: chain, method: 0 },
  ]);
  const s = await testServer();
  s.put("outer.zip", outer);
  const url = s.url("outer.zip");
  const verify = (out, manifest) => manifest.files.every((f) => fs.existsSync(path.join(out, ...f.name.split("/"))) && sha256(path.join(out, ...f.name.split("/"))) === f.sha256);
  try {
    const ins = await run({ type: "inspect", id: "in1", url, inner: ["data/small.zip"], credentials: "omit" }, final);
    const rep = ins.last.report;
    check(rep?.files === smallManifest.files.length && rep.inner.join() === "data/small.zip" && rep.archive_size === small.length, `inner: data/small.zip read with Range requests (${rep?.files} files, ${rep?.index_bytes} index bytes)`, JSON.stringify(ins.last).slice(0, 300));
    let out = tempDir("inner-small");
    let r = await run({ type: "extract", id: "in1:x", url, inner: ["data/small.zip"], jobs: 4, credentials: "omit" }, final, out);
    check(r.last.type === "done" && verify(out, smallManifest), `inner: data/small.zip extracts right (${r.last.files} files in ${r.last.requests} requests)`, JSON.stringify(r.last).slice(0, 300));

    // Only the ticked files, and a preview read through the outer zip.
    const entry = await new Promise((resolve) => {
      const e = createEngine({ post: (m) => (m.type === "inspected" ? e.handle({ type: "entry", id: "inv", path: smallManifest.files[3].name }) : m.type === "entry" && resolve(m)), openSink: async () => null });
      e.handle({ type: "inspect", id: "inv", url, inner: ["data/small.zip"], credentials: "omit" });
    });
    const bytes = await readEntry(entry);
    check(entry.source.outer && sha256Of(bytes) === smallManifest.files[3].sha256, `inner: the preview reads ${smallManifest.files[3].name} through the outer zip`);

    const packed = await run({ type: "inspect", id: "in2", url, inner: ["data/packed.zip"], credentials: "omit" }, final);
    check(packed.last.code === "inner_compressed", `inner: a compressed inner zip can't be listed (${packed.last.code})`);
    out = tempDir("inner-packed");
    r = await run({ type: "extract", id: "in2:x", url, inner: ["data/packed.zip"], stream: true, credentials: "omit" }, final, out);
    check(r.last.type === "done" && verify(out, streamedManifest), `inner: a compressed inner zip extracts in one pass (${r.last.files} files)`, JSON.stringify(r.last).slice(0, 300));

    const three = ["nest/l1.zip", "l2.zip", "l3.zip"];
    out = tempDir("inner-deep");
    r = await run({ type: "extract", id: "in3:x", url, inner: three, credentials: "omit" }, final, out);
    check(r.last.type === "done" && sameFiles(out, { "deep.txt": "three levels down" }), "inner: three levels down");
    const tooDeep = await run({ type: "inspect", id: "in4", url, inner: ["chain.zip", "c1.zip", "c2.zip", "c3.zip", "c4.zip"], credentials: "omit" }, final);
    check(tooDeep.last.code === "bad_request", `inner: five levels are refused (${tooDeep.last.message})`);
    const bad = await run({ type: "inspect", id: "in5", url, inner: ["bad/broken.zip"], credentials: "omit" }, final);
    check(bad.last.type === "error" && /outside/.test(bad.last.message), `inner: a broken inner zip fails cleanly (${bad.last.message})`);
    const none = await run({ type: "inspect", id: "in6", url, inner: ["nope.zip"], credentials: "omit" }, final);
    check(none.last.code === "bad_request", "inner: a path that isn't in the zip answers bad_request");

    // The index cache keeps the inner zip's index apart from the outer one's.
    const cache = new Map();
    const indexCache = { get: async (k) => cache.get(k) ?? null, put: async (k, raw) => cache.set(k, raw) };
    await run({ type: "inspect", id: "in7", url, inner: ["data/small.zip"], credentials: "omit" }, final, null, { indexCache });
    const again = await run({ type: "inspect", id: "in8", url, inner: ["data/small.zip"], credentials: "omit" }, final, null, { indexCache });
    check(cache.size === 2 && again.last.report.index_cached && again.last.report.files === smallManifest.files.length, "inner: the index cache keeps the outer and the inner index");
  } finally {
    await s.close();
  }
}

// ------------------------------------------------------------------------------------------
// The zip's own top folder
// ------------------------------------------------------------------------------------------

function runInto(sink, request) {
  return new Promise((resolve) => {
    const e = createEngine({ post: (m) => final(m) && resolve(m), openSink: async () => sink });
    e.handle({ id: `t${Math.random().toString(36).slice(2, 6)}:x`, type: "extract", credentials: "omit", ...request });
  });
}

async function checkTopFolder() {
  const data = { "a.txt": Buffer.from("top level\n"), "src/b.js": bytesOf(41, 150_000), "src/deep/c.bin": bytesOf(42, 90_000) };
  const inTop = (top) => [
    { name: `${top}/`, data: Buffer.alloc(0), method: 0 },
    { name: `${top}/a.txt`, data: data["a.txt"] },
    { name: `${top}/src/`, data: Buffer.alloc(0), method: 0 },
    { name: `${top}/src/b.js`, data: data["src/b.js"] },
    { name: `${top}/src/deep/c.bin`, data: data["src/deep/c.bin"], method: 0 },
  ];
  const under = (prefix, files) => Object.fromEntries(Object.entries(files).map(([n, d]) => [`${prefix}${n}`, d]));
  const s = await testServer();
  const g = await testServer({ range: false, validators: "none" });
  try {
    s.put("proj-main.zip", makeZip(inTop("proj-main")));
    s.put("Upper.zip", makeZip(inTop("upper")));
    s.put("loose.zip", makeZip([...inTop("loose"), { name: "NOTICE", data: Buffer.from("outside") }]));
    s.put("journal.zip", makeZip([{ name: "jr/.linkunzip-resume.jsonl", data: Buffer.from("not ours") }, { name: "jr/x.txt", data: Buffer.from("x") }]));

    // Downloads: Downloads/proj-main/a.txt, not Downloads/proj-main/proj-main/a.txt.
    let root = tempDir("top-dl");
    let r = await runInto(downloadsSink({ sub: "proj-main", label: "Downloads > proj-main", saved: new Map(), save: saveInto(root) }), { url: s.url("proj-main.zip") });
    check(r.type === "done" && sameFiles(root, under("proj-main/", data)), "top folder: proj-main.zip's proj-main/ goes straight into Downloads/proj-main", `${r.type} ${listFiles(root)}`);

    // A folder chosen in Settings, and the name in another case.
    root = tempDir("top-folder");
    r = await runInto(nodeSink(root, "Upper"), { url: s.url("Upper.zip") });
    check(r.type === "done" && sameFiles(root, data), "top folder: upper/ inside Upper.zip goes straight into the chosen folder's Upper", `${r.type} ${listFiles(root)}`);

    // Only some files: same place as when everything is extracted.
    root = tempDir("top-some");
    r = await runInto(nodeSink(root, "proj-main"), { url: s.url("proj-main.zip"), select: { paths: ["proj-main/src/deep/"], exclude: [] } });
    check(r.type === "done" && sameFiles(root, { "src/deep/c.bin": data["src/deep/c.bin"] }), "top folder: a selection lands where it would in a full extraction", listFiles(root).join(" "));

    // Kept when the names differ, or when a file sits outside the folder.
    root = tempDir("top-other");
    r = await runInto(nodeSink(root, "something-else"), { url: s.url("proj-main.zip") });
    check(r.type === "done" && sameFiles(root, under("proj-main/", data)), "top folder: kept when the zip goes into a folder of another name");
    root = tempDir("top-loose");
    r = await runInto(nodeSink(root, "loose"), { url: s.url("loose.zip") });
    check(r.type === "done" && sameFiles(root, { ...under("loose/", data), NOTICE: Buffer.from("outside") }), "top folder: kept when a file sits outside it");

    // A file named like the journal, which now lands at the top, gets a _.
    root = tempDir("top-journal");
    r = await runInto(nodeSink(root, "jr"), { url: s.url("journal.zip") });
    check(
      r.type === "done" && sameFiles(root, { "_.linkunzip-resume.jsonl": Buffer.from("not ours"), "x.txt": Buffer.from("x") }) && r.renamed === 1,
      "top folder: jr/.linkunzip-resume.jsonl is saved as _.linkunzip-resume.jsonl and reported",
      `${JSON.stringify(r).slice(0, 300)} ${listFiles(root)}`,
    );

    // Resume of an extraction an earlier version started (with the folder): it carries on there.
    root = tempDir("top-resume-dl");
    const saved = new Map([[`proj-main/a.txt`, `${crc32(0, data["a.txt"])}:${data["a.txt"].length}`]]);
    fs.mkdirSync(path.join(root, "proj-main", "proj-main"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj-main", "proj-main", "a.txt"), data["a.txt"]);
    r = await runInto(downloadsSink({ sub: "proj-main", label: "Downloads > proj-main", saved, save: saveInto(root) }), { url: s.url("proj-main.zip"), resume: true });
    check(r.type === "done" && r.skipped_existing === 1 && sameFiles(root, under("proj-main/proj-main/", data)), "top folder: Downloads Resume of an earlier version's run keeps its layout", `${JSON.stringify(r).slice(0, 200)} ${listFiles(root)}`);
    root = tempDir("top-resume-folder");
    fs.mkdirSync(path.join(root, "proj-main"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj-main", "a.txt"), data["a.txt"]);
    r = await runInto(nodeSink(root, "proj-main"), { url: s.url("proj-main.zip"), resume: true });
    check(r.type === "done" && r.skipped_existing === 1 && sameFiles(root, under("proj-main/", data)), "top folder: folder Resume of an earlier version's run keeps its layout", `${JSON.stringify(r).slice(0, 200)} ${listFiles(root)}`);
    // And one of this version, stopped halfway: the files already there are found.
    root = tempDir("top-resume-new");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "b.js"), data["src/b.js"]);
    r = await runInto(nodeSink(root, "proj-main"), { url: s.url("proj-main.zip"), resume: true });
    check(r.type === "done" && r.skipped_existing === 1 && sameFiles(root, data), "top folder: Resume of this version's run finds its files without the folder", `${JSON.stringify(r).slice(0, 200)} ${listFiles(root)}`);

    // One pass (GitHub's Download ZIP is always like this): decided on the first entry.
    g.put("proj-main.zip", makeZip(inTop("proj-main")));
    g.put("late.zip", makeZip([...inTop("late"), { name: "late.txt", data: Buffer.from("after") }]));
    root = tempDir("top-stream");
    r = await runInto(nodeSink(root, "proj-main"), { url: g.url("proj-main.zip"), stream: true });
    check(r.type === "done" && r.stream && sameFiles(root, data) && r.listing_differs === 0, "top folder: one pass, proj-main/ goes straight into proj-main", `${JSON.stringify(r).slice(0, 300)} ${listFiles(root)}`);
    root = tempDir("top-stream-late");
    r = await runInto(nodeSink(root, "late"), { url: g.url("late.zip"), stream: true });
    check(r.type === "done" && sameFiles(root, { ...data, "late.txt": Buffer.from("after") }), "top folder: one pass, a file outside it that comes later keeps its own path", listFiles(root).join(" "));
    root = tempDir("top-stream-old");
    fs.mkdirSync(path.join(root, "proj-main"), { recursive: true });
    fs.writeFileSync(path.join(root, "proj-main", "a.txt"), data["a.txt"]);
    r = await runInto(nodeSink(root, "proj-main"), { url: g.url("proj-main.zip"), stream: true, resume: true });
    check(r.type === "done" && sameFiles(root, under("proj-main/", data)), "top folder: one-pass Resume of an earlier version's run keeps its layout", listFiles(root).join(" "));
  } finally {
    await s.close();
    await g.close();
  }
}

const final = (m) => ["inspected", "done", "error", "cancelled"].includes(m.type);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function listFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).replaceAll("\\", "/"));
  }
  return out;
}

function tempDir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `lu-${name}-`));
  return d;
}

async function verifyKind(kind, connections = 4) {
  const manifest = JSON.parse(fs.readFileSync(path.join(DATA, `${kind}.manifest.json`), "utf8"));
  const url = `${BASE}/${kind}.zip`;
  const ins = await run({ type: "inspect", id: kind, url, credentials: "omit" }, final);
  check(ins.last.type === "inspected", `${kind}: index read`, JSON.stringify(ins.last).slice(0, 300));
  if (ins.last.type !== "inspected") return;
  const r = ins.last.report;
  check(r.files === manifest.files.length, `${kind}: ${r.files} files listed (manifest ${manifest.files.length})`);
  check(r.archive_size === manifest.archive_size, `${kind}: archive size`);
  const out = tempDir(kind);
  const t0 = Date.now();
  const ex = await run({ type: "extract", id: `${kind}:x`, url, jobs: connections, credentials: "omit" }, final, out);
  const ms = Date.now() - t0;
  check(ex.last.type === "done", `${kind}: extracted in ${ms} ms`, JSON.stringify(ex.last).slice(0, 400));
  if (ex.last.type !== "done") return;
  let bad = 0;
  for (const f of manifest.files) {
    const p = path.join(out, ...f.name.split("/"));
    if (!fs.existsSync(p) || sha256(p) !== f.sha256) bad += 1;
  }
  check(bad === 0, `${kind}: every file matches the manifest's SHA-256 (${manifest.files.length - bad}/${manifest.files.length})`);
  check(!listFiles(out).some((f) => f.endsWith(".crswap")), `${kind}: no temp files left`);
  check(ex.last.verified_files === manifest.files.length, `${kind}: done says all files verified`);
  console.log(`      downloaded ${ex.last.downloaded_bytes} in ${ex.last.requests} requests, index ${ex.last.index_bytes}`);
  return out;
}

/** Wait until the Range server answers (Python can take a few seconds to start on a CI runner). */
async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${BASE}/`, { method: "HEAD" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`the Range server on port ${PORT} did not start`);
}

async function main() {
  const server = spawn("python", [path.join(here, "range_server.py"), DATA, String(PORT)], { stdio: ["ignore", "ignore", "ignore"] });
  try {
    await waitForServer();
    // If-Range, the archive changing on the server, servers without Range support, passwords,
    // zips inside zips.
    if (wanted("ifrange")) await checkIfRange();
    if (wanted("swap")) await checkSwap();
    if (wanted("stream")) await checkStream();
    if (wanted("password")) await checkPasswords();
    if (wanted("inner")) await checkInner();
    if (wanted("top")) await checkTopFolder();
    if (!wanted("rest")) return;

    // Ordinary archives: small (stored + deflate + unicode), streamed (data descriptors), many files.
    const smallOut = await verifyKind("small");
    await verifyKind("streamed", 2);
    await verifyKind("many", 8);

    // Saving through Chrome's downloads (a stand-in here; the real thing in tools/e2e).
    checkDownloadsNames();
    await checkDownloadsSink();
    await checkDownloadsExtract("small");
    await checkDownloadsExtract("many");

    // Browsing: the engine that read the index answers list, search, measure and entry.
    const replies = [];
    await new Promise((resolve) => {
      const e = createEngine({
        post: (m) => {
          replies.push(m);
          if (m.type === "inspected") {
            e.handle({ type: "list", id: "b", dir: "", offset: 0, limit: 500 });
            e.handle({ type: "search", id: "b", query: "README", limit: 50 });
            e.handle({ type: "measure", id: "b", select: { paths: ["stored/"], exclude: [] } });
            e.handle({ type: "list", id: "nope", dir: "" });
            e.handle({ type: "entry", id: "b", path: "stored/README_stored.txt" });
            setTimeout(resolve, 50);
          }
        },
        openSink: async (t) => nodeSink(t),
      });
      e.handle({ type: "inspect", id: "b", url: `${BASE}/small.zip`, credentials: "omit" });
    });
    const listing = replies.find((m) => m.type === "listing");
    check(listing && listing.total > 0 && listing.items[0].dir === true, `list: top folder has ${listing?.total} items, folders first`);
    const search = replies.find((m) => m.type === "search_results");
    check(search && search.total >= 1 && search.items.every((i) => /readme/i.test(i.path)), `search: ${search?.total} results for README`);
    const measured = replies.find((m) => m.type === "measured");
    check(measured && measured.files >= 1, `measure: stored/ has ${measured?.files} files`);
    check(replies.some((m) => m.type === "error" && m.code === "unknown_job"), "list on an unknown id answers unknown_job");
    const entry = replies.find((m) => m.type === "entry");
    check(entry && entry.entry.regionEnd > entry.entry.offset && entry.source.size > 0, "entry: offset, region end and source for the viewer");

    // The file list's questions, the index cache, Resume after the page closed, dropped connections.
    await checkTree("small");
    await checkTree("many");
    await checkNearestTick();
    await checkIndexCache();
    await checkDownloadsResumeAfterClose();
    await checkStoredContinues();

    // Only some files.
    const someOut = tempDir("some");
    const some = await run({ type: "extract", id: "s:x", url: `${BASE}/small.zip`, select: { paths: ["stored/"], exclude: [] }, credentials: "omit" }, final, someOut);
    const someFiles = listFiles(someOut);
    check(some.last.type === "done" && someFiles.length > 0 && someFiles.every((f) => f.startsWith("stored/")), `select: only stored/ written (${someFiles.length} files)`);
    const globOut = tempDir("glob");
    const glob = await run({ type: "extract", id: "g:x", url: `${BASE}/small.zip`, include: ["*.CSV"], credentials: "omit" }, final, globOut);
    const globFiles = listFiles(globOut);
    check(glob.last.type === "done" && globFiles.length > 0 && globFiles.every((f) => /\.csv$/i.test(f)), `pattern *.CSV: ${globFiles.length} csv files, case-insensitive, any folder`);

    // Resume: delete two files, corrupt one, run again with resume.
    if (smallOut) {
      const files = listFiles(smallOut);
      fs.rmSync(path.join(smallOut, files[0]));
      fs.rmSync(path.join(smallOut, files[1]));
      fs.writeFileSync(path.join(smallOut, files[2]), "changed");
      const re = await run({ type: "extract", id: "r:x", url: `${BASE}/small.zip`, resume: true, credentials: "omit" }, final, smallOut);
      check(re.last.type === "done" && re.last.files === 3 && re.last.skipped_existing === files.length - 3, `resume: wrote 3, skipped ${re.last.skipped_existing}`, JSON.stringify(re.last).slice(0, 300));
    }

    // Cancel.
    const cancelOut = tempDir("cancel");
    const cancelled = await new Promise((resolve) => {
      let sent = false;
      const e = createEngine({
        post: (m) => {
          if (m.type === "progress" && !sent) {
            sent = true;
            e.handle({ type: "cancel", id: "c:x" });
          }
          if (final(m)) resolve(m);
        },
        openSink: async () => nodeSink(cancelOut),
      });
      e.handle({ type: "extract", id: "c:x", url: `${BASE}/many.zip`, jobs: 1, credentials: "omit" });
    });
    check(cancelled.type === "cancelled", `cancel: answered ${cancelled.type}`);
    check(!listFiles(cancelOut).some((f) => f.endsWith(".crswap")), "cancel: no half-written files left");

    // Errors.
    const missing = await run({ type: "inspect", id: "m", url: `${BASE}/nothing-here.zip`, credentials: "omit" }, final);
    check(missing.last.code === "not_found", `404 answers not_found (${missing.last.code})`);
    const notZip = await run({ type: "inspect", id: "n", url: `${BASE}/small.manifest.json`, credentials: "omit" }, final);
    check(notZip.last.code === "not_zip", `a JSON file answers not_zip (${notZip.last.code})`);
    const down = await run({ type: "inspect", id: "d", url: "http://127.0.0.1:1/x.zip", credentials: "omit" }, final);
    check(down.last.code === "network", `nothing listening answers network (${down.last.code})`);

    // Hostile and odd archives (tools/make_malicious_zips.py writes what each must do).
    const expect = JSON.parse(fs.readFileSync(path.join(DATA, "malicious", "malicious.manifest.json"), "utf8"));
    for (const [name, want] of Object.entries(expect)) {
      const out = tempDir("mal");
      const url = `${BASE}/malicious/${name}`;
      const r = await run({ type: "extract", id: `${name}:x`, url, credentials: "omit" }, final, out);
      const written = listFiles(out);
      if (want.expect === "rejected") {
        check(r.last.type === "error" && written.length === 0, `${name}: refused before writing (${r.last.code}: ${String(r.last.detail || r.last.message).split("\n")[0].slice(0, 90)})`);
        const reason = String(r.last.detail || "") + String(r.last.message || "");
        const words = { traversal: "..", absolute: "absolute", drive: "drive", "same file": "same file", "stored sizes differ": "differ", "overlaps the next entry": "overlaps", "share the same data": "same data", encrypted: "encrypted", "compression method 12": "method 12" };
        check(reason.includes(words[want.reason] || want.reason), `${name}: says why (${want.reason})`);
        if (want.excluded_ok) {
          const okOut = tempDir("ok");
          const ok = await run({ type: "extract", id: `${name}:ok`, url, include: [want.excluded_ok], credentials: "omit" }, final, okOut);
          check(ok.last.type === "done" && listFiles(okOut).includes(want.excluded_ok), `${name}: ${want.excluded_ok} alone extracts fine`);
        }
      } else if (want.expect === "sanitised") {
        check(r.last.type === "done", `${name}: extracted with renames (${r.last.renamed} renamed)`);
        for (const [, to] of Object.entries(want.renamed)) check(written.includes(to), `${name}: ${to} written`);
      } else if (want.expect === "fatal") {
        check(r.last.type === "error", `${name}: fails (${String(r.last.detail || r.last.message).slice(0, 110)})`);
        if (want.bad_entry) {
          check(!written.includes(want.bad_entry), `${name}: ${want.bad_entry} never gets its name`);
        }
        check(!written.some((f) => f.endsWith(".crswap")), `${name}: no temp file left`);
        if (name === "bomb.zip") check(!written.some((f) => f.startsWith("bomb.bin")), "bomb.zip: nothing past the declared size is kept");
      }
    }
  } finally {
    server.kill();
  }
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  },
  (e) => {
    console.log(`\nthe tests stopped: ${e?.stack || e}`);
    process.exit(1);
  },
);
