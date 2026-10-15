// Tests for the browser engine (extension/engine), run under Node against a local Range server
// and the same test zips the helper's tests use:
//
//   python tools/make_test_zips.py all-small --out <data>
//   python tools/make_malicious_zips.py --out <data>/malicious
//   node tools/engine_test.mjs <data>
//
// Node has fetch and DecompressionStream like the browser; only the folder is different (plain
// files here, a folder handle in the extension).

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveObjectURL } from "node:buffer";

import { downloadsName, downloadsSink } from "../extension/engine/dl-sink.js";
import { createEngine } from "../extension/engine/engine.js";

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
function run(request, until, target = null) {
  return new Promise((resolve) => {
    const replies = [];
    const engine = createEngine({
      post: (m) => {
        replies.push(m);
        if (until(m)) resolve({ replies, last: m, engine });
      },
      openSink: async (t) => nodeSink(t),
    });
    engine.handle({ ...request, target: target ?? request.target });
  });
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

async function main() {
  const server = spawn("python", [path.join(here, "range_server.py"), DATA, String(PORT)], { stdio: ["ignore", "ignore", "ignore"] });
  await new Promise((r) => setTimeout(r, 1200));
  try {
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
