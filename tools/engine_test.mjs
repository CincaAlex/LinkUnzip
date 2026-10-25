// Tests for the browser engine (extension/engine), run under Node against a local Range server
// and the same test zips the helper's tests use:
//
//   python tools/make_test_zips.py all-small --out <data>
//   python tools/make_malicious_zips.py --out <data>/malicious
//   node tools/engine_test.mjs <data>
//
// Node has fetch and DecompressionStream like the browser; only the folder is different (plain
// files here, a folder handle in the extension).

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveObjectURL } from "node:buffer";

import { downloadsName, downloadsSink } from "../extension/engine/dl-sink.js";
import { createEngine } from "../extension/engine/engine.js";
import { Filter } from "../extension/engine/plan.js";
import { Source } from "../extension/engine/source.js";
import { Tree } from "../extension/engine/tree.js";
import { readIndex } from "../extension/engine/zip.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(process.argv[2] || "test-data");
const PORT = 8190;
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

function check(ok, what, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && extra ? `\n      ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** Plain files under `root`, with the same interface as engine/fsa-sink.js. */
function nodeSink(root) {
  return {
    label: root,
    renames: [],
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
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main();
