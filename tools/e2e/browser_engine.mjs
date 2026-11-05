// End-to-end test of the browser engine in real Chrome: the extension (a test copy with host
// access granted up front, since a test can't click Chrome's permission prompt), its offscreen
// engine, a local Range server, and the browser's private file system standing in for the folder
// the user would pick. Saving into Downloads goes through Chrome's real downloads, into a test
// profile whose Downloads folder is a temporary one. Files are checked against the generator's
// SHA-256 manifest.
//
//   python tools/make_test_zips.py all-small --out <data>
//   set E2E_MODULES=<a folder where `npm i puppeteer-core` ran>
//   node tools/e2e/browser_engine.mjs <data> [--headful] [--features]
//
// --features: only the streamed preview (needs ffmpeg on PATH for its videos), passwords, zips
// inside zips and one-pass extraction.

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadsName } from "../../extension/engine/dl-sink.js";
import { bytesOf, makeZip, sha256 } from "../test_zips.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");

const DATA = path.resolve(process.argv[2] || "test-data");
const HEADFUL = process.argv.includes("--headful");
// --only=small,many: just those archives (and skip the rest of the checks).
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const FEATURES_ONLY = process.argv.includes("--features");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8191;
const BASE = `http://127.0.0.1:${PORT}`;
// The same files, sent at about 3 MB/s (so a video can't arrive whole before it is seeked) ...
const SLOW = `http://127.0.0.1:${PORT + 1}`;
// ... and by a server without Range support (like GitHub's Download ZIP).
const NORANGE = `http://127.0.0.1:${PORT + 2}`;
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(ok, what, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && extra ? `\n      ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** A copy of extension/ with host access granted at install (the store build asks at runtime). */
function testCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-ext-"));
  fs.cpSync(path.join(root, "extension"), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

/** A zip with things to preview: text, CSV, PNG, SVG, PDF, HTML, an unknown binary. */
function previewZip(dest) {
  const py = `
import zipfile, zlib, struct, sys
def png(w, h):
    rows = b''.join(b'\\x00' + b''.join(bytes([(x*4)%256, (y*4)%256, 160]) for x in range(w)) for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
pdf = b'%PDF-1.1\\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\\nBT /F1 24 Tf 40 70 Td (LinkUnzip PDF) Tj ET\\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\\ntrailer<</Root 1 0 R>>\\n%%EOF'
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('docs/readme.md', '# Hello\\n\\nThis is **markdown** shown as text.\\n')
    z.writestr('docs/big.log', ''.join('line %06d some log text here\\n' % i for i in range(200000)))
    z.writestr('data/table.csv', 'name,size,"note, with comma"\\n' + ''.join('row%d,%d,"q ""%d"""\\n' % (i, i * 3, i) for i in range(5000)))
    z.writestr('img/pic.png', png(64, 48))
    z.writestr('img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="16" fill="#18181b"/><script>window.top.pwned=1</script></svg>')
    z.writestr('doc.pdf', pdf)
    z.writestr('page.html', '<html><body><script>window.top.pwned=1</script><h1>hi</h1></body></html>')
    z.writestr('blob.bin', bytes(range(256)) * 64)
`;
  const r = spawnSyncPy(py, dest);
  if (r) throw new Error(r);
}

/** File names Chrome's downloads refuse as they are, and a big file (Chrome pages it to disk). */
function namesZip(dest) {
  const py = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for n in ['.gitignore', '.github/workflows/ci.yml', 'shortcut.lnk', 'desktop.ini', 'notes~1.txt', 'ok.txt', 'data.csv', 'plugin.dll', 'Makefile']:
        z.writestr(n, 'content of ' + n)
`;
  const r = spawnSyncPy(py, dest);
  if (r) throw new Error(r);
}

function bigZip(dest, mb) {
  if (fs.existsSync(dest)) return;
  const py = `
import zipfile, sys, os, hashlib, json
h = hashlib.sha256()
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_STORED) as z:
    with z.open('big/big.bin', 'w', force_zip64=True) as f:
        for i in range(${mb}):
            block = os.urandom(1 << 20)
            h.update(block)
            f.write(block)
json.dump({'sha256': h.hexdigest()}, open(sys.argv[1] + '.json', 'w'))
`;
  const r = spawnSyncPy(py, dest);
  if (r) throw new Error(r);
}

/** A Chrome profile whose downloads go into `dir` (and, with `ask`, ask where to save each one). */
function profileWithDownloads(dir, ask = false) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lu-profile-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: dir, prompt_for_download: ask, directory_upgrade: true } }));
  return profile;
}

function fileSha(file) {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function walk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name), base) : [path.relative(base, path.join(dir, d.name)).replaceAll("\\", "/")]));
}

/**
 * media.zip: a 60 s video stored (seekable from the zip), a short one deflated, one encrypted
 * (AES, password "media-pw"), a PDF, and two zips inside it, one stored and one deflated. Null
 * when there is no ffmpeg to make the videos.
 */
function mediaZip(dest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-media-"));
  const video = (name, secs, rate) => {
    const out = path.join(dir, name);
    // Noise on top of the test pattern, so the video really is as big as its bit rate says.
    const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=duration=${secs}:size=640x360:rate=30`, "-vf", "noise=alls=40:allf=t", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", rate, "-minrate", rate, "-maxrate", rate, "-bufsize", rate, "-movflags", "+faststart", out]);
    return r.status === 0 ? fs.readFileSync(out) : null;
  };
  const long = video("long.mp4", 40, "8M");
  const short = video("short.mp4", 8, "1M");
  if (!long || !short) return null;
  const pdf = Buffer.from("%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 70 Td (LinkUnzip PDF) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  const innerFiles = { "notes/a.txt": Buffer.from("inside the inner zip\n".repeat(200)), "bin/b.bin": bytesOf(41, 300_000), "c.csv": Buffer.from("x,y\n1,2\n".repeat(500)) };
  const inner = makeZip(Object.entries(innerFiles).map(([name, data]) => ({ name, data })));
  fs.writeFileSync(dest, makeZip([
    { name: "video/stored.mp4", data: long, method: 0 },
    { name: "video/deflated.mp4", data: short, method: 8 },
    { name: "video/locked.mp4", data: short, method: 0, encryption: "aes", password: "media-pw" },
    { name: "doc/manual.pdf", data: pdf, method: 0 },
    { name: "data.zip", data: inner, method: 0 },
    { name: "packed.zip", data: inner, method: 8 },
  ]));
  return { videoSize: long.length, innerFiles };
}

/** "7.4 MB" (the viewer's numbers) in bytes. */
function bytesIn(text) {
  const m = /([\d.,]+)\s*(B|KB|MB|GB)\b/.exec(text || "");
  if (!m) return NaN;
  return Number(m[1].replace(/,/g, "")) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2]];
}

let media = null;

/** The job's next run after `since` reaching one of `phases` (not what an earlier run left). */
async function untilRun(until, jid, since, phases, ms) {
  const end = Date.now() + (ms || 120000);
  for (;;) {
    const j = await until(jid, phases, 1000);
    if (j && j.startedAt >= since && phases.includes(j.phase)) return j;
    if (Date.now() > end) return j;
  }
}

/** Video, audio and PDF previews streamed by the worker; zips inside zips in Chrome. */
async function checkMedia({ page, viewer, id, send, until, sha }) {
  const { id: mj } = await send("inspect", { url: `${SLOW}/media.zip` });
  const ready = await until(mj, ["ready", "error"]);
  check(ready?.phase === "ready" && ready.report.encrypted === 1 && ready.report.inner_zips === 2, `media.zip: index read (${ready?.report?.encrypted} encrypted, ${ready?.report?.inner_zips} zips inside)`, JSON.stringify(ready?.error || ready?.report).slice(0, 300));
  if (ready?.phase !== "ready") return;
  const open = async (p) => {
    await viewer.goto(`chrome-extension://${id}/viewer.html?job=${encodeURIComponent(mj)}&path=${encodeURIComponent(p)}`);
    await sleep(500);
  };
  const stats = () => viewer.evaluate(() => document.getElementById("stats").textContent);
  const playable = () =>
    viewer
      .waitForFunction(() => {
        const v = document.querySelector("#view video");
        return v && v.readyState >= 2 && v.duration > 0;
      }, { timeout: 30000 })
      .then(() => true, () => false);

  // A 40 s stored video: plays, and a seek to 80% downloads only around that point.
  await open("video/stored.mp4");
  const plays = await playable();
  const seek = await viewer.evaluate(async () => {
    const v = document.querySelector("#view video");
    v.muted = true;
    await v.play().catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    v.currentTime = v.duration * 0.8;
    await new Promise((r) => {
      v.onseeked = r;
      setTimeout(r, 20000);
    });
    await new Promise((r) => setTimeout(r, 1500));
    return { duration: v.duration, time: v.currentTime, ready: v.readyState, src: v.src };
  });
  await sleep(1200);
  const s1 = await stats();
  const got = bytesIn(s1);
  check(
    plays && seek.src.includes("/preview/") && Math.abs(seek.time - seek.duration * 0.8) < 3 && seek.ready >= 2 && got < media.videoSize * 0.6,
    `preview: a 40 s stored video streams and seeks to ${seek.time.toFixed(1)} s, ${(got / 1048576).toFixed(1)} of ${(media.videoSize / 1048576).toFixed(1)} MB downloaded ("${s1}")`,
    JSON.stringify(seek),
  );

  // A deflated one: plays from its start.
  await open("video/deflated.mp4");
  const deflated = await playable();
  await sleep(1200);
  check(deflated && /plays from its start/.test(await stats()), `preview: a deflated video plays ("${await stats()}")`);

  // A PDF: Chrome's viewer reads it from the worker's address.
  await open("doc/manual.pdf");
  const pdfSrc = await viewer.evaluate(() => document.querySelector("#view iframe.pdf")?.src || "");
  check(pdfSrc.includes("/preview/"), "preview: a PDF goes to Chrome's viewer through the worker, not a blob");

  // An encrypted video: the viewer asks for the password; a wrong one is said so.
  await open("video/locked.mp4");
  await viewer.waitForSelector("#view input[type=password]", { timeout: 10000 }).catch(() => {});
  const asked = await viewer.evaluate(() => document.getElementById("view").innerText);
  await viewer.type("#view input[type=password]", "nope");
  await viewer.keyboard.press("Enter");
  await viewer.waitForFunction(() => /doesn't fit/.test(document.getElementById("view").innerText), { timeout: 10000 }).catch(() => {});
  const wrong = await viewer.evaluate(() => document.getElementById("view").innerText);
  await viewer.type("#view input[type=password]", "media-pw");
  await viewer.keyboard.press("Enter");
  const unlocked = await playable();
  check(/password-protected/.test(asked) && /doesn't fit/.test(wrong) && unlocked, "preview: an encrypted video asks for the password, refuses a wrong one, plays with the right one");

  // Zips inside the zip: Open in the popup's file list, then extract it.
  await page.reload();
  await page.waitForSelector(".fl-open", { timeout: 8000 }).catch(() => {});
  const opens = await page.evaluate(() => document.querySelectorAll(".fl-open").length);
  check(opens === 2, `inner: the file list offers Open on the 2 zips inside (${opens})`);
  const child = await send("openInner", { id: mj, path: "data.zip" });
  const cr = await until(child.id, ["ready", "error"]);
  check(cr?.phase === "ready" && cr.report.files === 3 && cr.report.inner.join() === "data.zip" && cr.parentId === mj, `inner: data.zip opens as its own job (${cr?.report?.files} files, "${cr?.output}")`, JSON.stringify(cr?.error));
  await page.reload();
  await sleep(600);
  const header = await page.evaluate(() => document.getElementById("job-line").innerText);
  check(/media\.zip › data\.zip/.test(header), `inner: the popup shows "${header.split("\n").join(" ")}" with the way back`);
  await send("extract", { id: child.id, target: cr.target, output: cr.output, connections: 2 });
  const cd = await until(child.id, ["done", "error"], 60000);
  let bad = 0;
  for (const [name, data] of Object.entries(media.innerFiles)) if ((await sha(`data/${name}`).catch(() => "")) !== sha256(data)) bad += 1;
  check(cd?.phase === "done" && bad === 0, `inner: data.zip extracted through the outer zip (${cd?.result?.files} files, ${cd?.result?.requests} requests)`, JSON.stringify(cd?.error));
  const child2 = await send("openInner", { id: mj, path: "packed.zip" });
  const c2 = await until(child2.id, ["ready", "error"]);
  check(c2?.error?.code === "inner_compressed", `inner: a deflated inner zip says it needs one pass (${c2?.error?.code})`);
  let t0 = Date.now();
  await send("extract", { id: child2.id, target: c2.target, output: c2.output, stream: true, connections: 1 });
  const p2 = await untilRun(until, child2.id, t0, ["done", "error"], 60000);
  bad = 0;
  for (const [name, data] of Object.entries(media.innerFiles)) if ((await sha(`packed/${name}`).catch(() => "")) !== sha256(data)) bad += 1;
  check(p2?.phase === "done" && p2.result.stream && bad === 0, "inner: the deflated one extracts in one pass", JSON.stringify(p2?.error));
}

/** Password zips and a server without Range support, through the extension. */
async function checkPasswordsAndStream({ page, send, until, sha }) {
  const files = { "secret/plan.txt": Buffer.from("the plan\n".repeat(1000)), "secret/photo.bin": bytesOf(51, 200_000) };
  fs.writeFileSync(path.join(DATA, "locked.zip"), makeZip(Object.entries(files).map(([name, data]) => ({ name, data, encryption: "aes", password: "zip-pw" }))));
  const { id: lj } = await send("inspect", { url: `${BASE}/locked.zip` });
  const lr = await until(lj, ["ready", "error"]);
  await page.reload();
  await page.waitForSelector(".password-row", { timeout: 8000 }).catch(() => {});
  const field = await page.evaluate(() => document.querySelector(".password-row label")?.textContent || "");
  check(lr?.report?.encrypted === 2 && /password-protected/.test(field), `password: the popup asks for it before Start ("${field}")`);
  let t0 = Date.now();
  await send("extract", { id: lj, target: lr.target, output: lr.output, connections: 2 });
  const none = await untilRun(until, lj, t0, ["done", "error"], 30000);
  t0 = Date.now();
  await send("extract", { id: lj, target: lr.target, output: lr.output, connections: 2, password: "Wr0ng-pw!" });
  const wrong = await untilRun(until, lj, t0, ["done", "error"], 30000);
  await page.reload();
  await sleep(600);
  const card = await page.evaluate(() => document.body.innerText);
  check(none?.error?.code === "password_needed" && wrong?.error?.code === "password_wrong" && /doesn't fit/.test(card), `password: none and a wrong one are refused before anything is written (${none?.error?.code}, ${wrong?.error?.code})`);
  const stored = await page.evaluate(() => chrome.storage.session.get(null).then((s) => JSON.stringify(s)));
  check(!stored.includes("Wr0ng-pw!") && !stored.includes("zip-pw"), "password: never written to chrome.storage");
  t0 = Date.now();
  await send("extract", { id: lj, target: lr.target, output: lr.output, connections: 2, password: "zip-pw" });
  const right = await untilRun(until, lj, t0, ["done", "error"], 30000);
  let bad = 0;
  for (const [name, data] of Object.entries(files)) if ((await sha(`locked/${name}`).catch(() => "")) !== sha256(data)) bad += 1;
  check(right?.phase === "done" && bad === 0, "password: the right one extracts both files", JSON.stringify(right?.error));

  // GitHub's kind of server: no Range, so one pass.
  const smallManifest = JSON.parse(fs.readFileSync(path.join(DATA, "small.manifest.json"), "utf8"));
  const { id: nj } = await send("inspect", { url: `${NORANGE}/small.zip` });
  const nr = await until(nj, ["ready", "error"]);
  await page.reload();
  await sleep(600);
  const offer = await page.evaluate(() => document.body.innerText);
  check(nr?.error?.code === "no_range" && /Extract everything \(one pass\)/.test(offer), `stream: a server without Range offers one pass (${nr?.error?.code})`);
  t0 = Date.now();
  await send("extract", { id: nj, target: { key: "base", sub: "small-stream" }, output: "LinkUnzip > small-stream", stream: true, connections: 1 });
  const nd = await untilRun(until, nj, t0, ["done", "error"], 120000);
  bad = 0;
  for (const f of smallManifest.files) if ((await sha(`small-stream/${f.name}`).catch(() => "")) !== f.sha256) bad += 1;
  check(nd?.phase === "done" && nd.result.stream && bad === 0 && nd.result.listing_differs === 0, `stream: all ${smallManifest.files.length} files in one pass, SHA-256 right (${nd?.result?.requests} request)`, JSON.stringify(nd?.error));
}

function spawnSyncPy(code, arg) {
  const file = path.join(os.tmpdir(), "lu-preview-zip.py");
  fs.writeFileSync(file, code);
  const { spawnSync } = require("node:child_process");
  const r = spawnSync("python", [file, arg], { encoding: "utf8" });
  return r.status === 0 ? null : r.stderr;
}

async function main() {
  previewZip(path.join(DATA, "preview.zip"));
  namesZip(path.join(DATA, "names.zip"));
  if (!FEATURES_ONLY) bigZip(path.join(DATA, "big.zip"), 400);
  media = mediaZip(path.join(DATA, "media.zip"));
  if (!media) console.log("SKIP  preview: no ffmpeg to make test videos with");
  const server = spawn("python", [path.join(root, "tools", "range_server.py"), DATA, String(PORT)], { stdio: "ignore" });
  const slow = spawn("python", [path.join(root, "tools", "range_server.py"), DATA, String(PORT + 1)], { stdio: "ignore", env: { ...process.env, MBPS: "3" } });
  const norange = spawn("python", ["-m", "http.server", String(PORT + 2), "--bind", "127.0.0.1", "--directory", DATA], { stdio: "ignore" });
  await sleep(1200);
  const ext = testCopy();
  const DL = fs.mkdtempSync(path.join(os.tmpdir(), "lu-downloads-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: !HEADFUL,
    pipe: true,
    protocolTimeout: 0,
    userDataDir: profileWithDownloads(DL),
    enableExtensions: [ext],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/popup.html?window=1`);
    await sleep(800);

    // The folder: a folder in the browser's private file system, saved where the popup would save
    // it, and chosen in Settings (Downloads is the default; it gets its own checks further down).
    await page.evaluate(async () => {
      const { setFolder } = await import("./folder.js");
      const opfs = await navigator.storage.getDirectory();
      const out = await opfs.getDirectoryHandle("LinkUnzip", { create: true });
      await setFolder("base", out);
    });
    const setSaveTo = (saveTo) =>
      page.evaluate(async (where) => {
        const { loadSettings } = await import("./settings.js");
        await chrome.storage.local.set({ settings: { ...(await loadSettings()), saveTo: where } });
        await chrome.runtime.sendMessage({ cmd: "baseFolderChanged" });
      }, saveTo);
    await setSaveTo("folder");

    const send = (cmd, data = {}) => page.evaluate((m) => chrome.runtime.sendMessage(m), { cmd, ...data });
    const job = (jid) => page.evaluate((j) => chrome.storage.session.get("jobs").then((s) => s.jobs?.[j]), jid);
    async function until(jid, phases, ms = 120000) {
      const end = Date.now() + ms;
      for (;;) {
        const j = await job(jid);
        if (j && phases.includes(j.phase)) return j;
        if (Date.now() > end) return j;
        await sleep(150);
      }
    }
    const sha = (rel) =>
      page.evaluate(async (p) => {
        let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip");
        const parts = p.split("/");
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
        const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }, rel);
    const listOut = (sub) =>
      page.evaluate(async (s) => {
        const out = [];
        const walk = async (dir, prefix) => {
          for await (const [name, h] of dir.entries()) {
            if (h.kind === "directory") await walk(h, `${prefix}${name}/`);
            else out.push(`${prefix}${name}`);
          }
        };
        const base = await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip");
        await walk(await base.getDirectoryHandle(s), "");
        return out;
      }, sub);

    // Chrome's download list: the files it holds back (in progress, waiting for Keep), the one
    // entry each job keeps for "Open folder", and anything else (which shouldn't be there).
    async function downloadList() {
      const items = await page.evaluate(() => chrome.downloads.search({}));
      const jobsNow = await page.evaluate(() => chrome.storage.session.get("jobs").then((s) => Object.values(s.jobs || {})));
      const keeperIds = new Set(jobsNow.map((j) => j.keeper?.id).filter((x) => x != null));
      const held = items.filter((d) => d.state === "in_progress").length;
      const keepers = items.filter((d) => keeperIds.has(d.id) && d.state === "complete").length;
      return { items, held, keepers, others: items.length - held - keepers };
    }

    const ping = await send("ping");
    check(ping.ok && ping.info?.engine === "browser", `engine answers hello (features: ${ping.info?.features?.join(", ")})`);
    if (FEATURES_ONLY) {
      const viewer = await browser.newPage();
      if (media) await checkMedia({ page, viewer, id, send, until, sha });
      await checkPasswordsAndStream({ page, send, until, sha });
      return;
    }

    for (const kind of ONLY.length ? ONLY : ["small", "streamed", "many"]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(DATA, `${kind}.manifest.json`), "utf8"));
      const { id: jid } = await send("inspect", { url: `${BASE}/${kind}.zip` });
      const ready = await until(jid, ["ready", "error"]);
      check(ready?.phase === "ready" && ready.report.files === manifest.files.length, `${kind}: index read in Chrome, ${ready?.report?.files} files`, JSON.stringify(ready?.error));
      if (ready?.phase !== "ready") continue;
      check(ready.output === `LinkUnzip > ${kind}`, `${kind}: goes into ${ready.output}`);
      const t0 = Date.now();
      await send("extract", { id: jid, target: ready.target, output: ready.output, connections: 4 });
      const done = await until(jid, ["done", "error"], 600000);
      const ms = Date.now() - t0;
      check(done?.phase === "done", `${kind}: extracted in Chrome in ${ms} ms`, JSON.stringify(done?.error));
      if (done?.phase !== "done") continue;
      const r = done.result;
      check(r.verified_files === manifest.files.length, `${kind}: ${r.verified_files} files verified, ${r.requests} requests, ${(r.downloaded_bytes / 1048576).toFixed(1)} MB downloaded`);
      const sample = kind === "many" ? manifest.files.filter((_, i) => i % 700 === 0) : manifest.files;
      // many.zip holds many/...: that folder's contents go straight into LinkUnzip > many.
      const at = (name) => (kind === "many" ? name.replace(/^many\//, "") : name);
      let bad = 0;
      for (const f of sample) if ((await sha(`${kind}/${at(f.name)}`).catch(() => "")) !== f.sha256) bad += 1;
      check(bad === 0, `${kind}: SHA-256 of ${sample.length} files match the manifest${kind === "many" ? " (in many/, not many/many/)" : ""}`);
      if (kind !== "many") {
        const files = await listOut(kind);
        check(!files.some((f) => f.endsWith(".crswap")) && files.length === manifest.files.length, `${kind}: ${files.length} files in the folder, no temp files`);
      }
      await send("dismiss", { id: jid });
    }

    // The same zip again: its index comes from the cache (IndexedDB), nothing more downloaded.
    if (!ONLY.length) {
      const { id: cj2 } = await send("inspect", { url: `${BASE}/small.zip` });
      const cached = await until(cj2, ["ready", "error"]);
      check(cached?.report?.index_cached === true && cached.report.index_bytes < 10_000, `index cache: small.zip opened again from the cache (${cached?.report?.index_bytes} index bytes)`);
      await send("dismiss", { id: cj2 });
    }


    // Preview.
    const { id: pj } = await send("inspect", { url: `${BASE}/preview.zip` });
    const pr = await until(pj, ["ready", "error"]);
    check(pr?.phase === "ready", "preview.zip: index read");
    const viewer = await browser.newPage();
    const open = async (p) => {
      await viewer.goto(`chrome-extension://${id}/viewer.html?job=${encodeURIComponent(pj)}&path=${encodeURIComponent(p)}`);
      await viewer.waitForFunction(() => !document.querySelector("#view .spinner"), { timeout: 20000 }).catch(() => {});
      await sleep(300);
      return viewer.evaluate(() => ({
        text: document.getElementById("view").innerText.slice(0, 300),
        stats: document.getElementById("stats").textContent,
        img: document.querySelector("#view img")?.naturalWidth || 0,
        iframe: Boolean(document.querySelector("#view iframe.pdf")),
        rows: document.querySelectorAll("#view table.csv tbody tr").length,
        lines: document.querySelectorAll("#view pre .ln").length,
        pwned: Boolean(window.pwned),
      }));
    };
    const md = await open("docs/readme.md");
    check(md.text.includes("# Hello"), `text: markdown shown as text (${md.stats})`);
    const log = await open("docs/big.log");
    check(log.lines > 1000 && log.lines < 200000 && /First/.test(log.stats), `big text: first part only (${log.lines} lines; ${log.stats})`);
    const csv = await open("data/table.csv");
    check(csv.rows === 1000 && csv.text.includes("note, with comma"), `csv: table with ${csv.rows} rows, quoted commas kept (${csv.stats})`);
    const png = await open("img/pic.png");
    check(png.img === 64, `png: image shown (${png.img} px wide; ${png.stats})`);
    const svg = await open("img/logo.svg");
    check(svg.img > 0 && !svg.pwned, "svg: shown as an image, its script never runs");
    const pdf = await open("doc.pdf");
    check(pdf.iframe, `pdf: Chrome's viewer (${pdf.stats})`);
    const html = await open("page.html");
    check(html.text.includes("<script>") && !html.pwned, "html: shown as source, not run");
    const bin = await open("blob.bin");
    check(/No preview|isn't text/.test(bin.text), `binary: details instead of a preview (${bin.text.split("\n")[0]})`);
    await viewer.goto(`chrome-extension://${id}/viewer.html?job=${encodeURIComponent(pj)}&path=${encodeURIComponent("img/pic.png")}`);
    await sleep(800);
    const nav = await viewer.evaluate(() => [document.getElementById("prev").disabled, document.getElementById("next").disabled]);
    await viewer.keyboard.press("ArrowLeft");
    await sleep(800);
    const after = await viewer.evaluate(() => document.getElementById("name").textContent);
    check(after === "logo.svg" || after === "pic.png", `previous/next walk the folder (now ${after}, buttons ${nav})`);

    // ---------------------------------------------------------------- streamed preview, inner zips
    if (media) await checkMedia({ page, viewer, id, send, until, sha });
    await checkPasswordsAndStream({ page, send, until, sha });

    // Site access: a job on a site without permission asks for it (the test copy has every site,
    // so check the background's answer with the permission removed for a moment is not possible;
    // the popup's error view for it is covered by the stub views).

    // The popup renders a ready job with the folder row and the preview eyes (preview.zip has
    // files at the top, small.zip only folders).
    const { id: uj } = await send("inspect", { url: `${BASE}/preview.zip` });
    await until(uj, ["ready", "error"]);
    await page.reload();
    await page.waitForSelector(".fl-peek", { timeout: 8000 }).catch(() => {});
    const ui = await page.evaluate(() => ({
      folder: document.querySelector(".folder-name")?.textContent,
      eyes: document.querySelectorAll(".fl-peek").length,
      chip: document.getElementById("host-chip").textContent,
      button: document.getElementById("extract-btn")?.textContent,
    }));
    check(ui.folder === "LinkUnzip > preview" && ui.chip.includes("In browser"), `popup: folder row "${ui.folder}", chip "${ui.chip}"`);
    check(ui.eyes > 0, `popup: preview buttons in the file list (${ui.eyes})`);
    check(/Start Extraction/.test(ui.button || ""), `popup: "${ui.button}"`);
    await page.screenshot({ path: path.join(os.tmpdir(), "lu-popup-ready.png") }).catch(() => {});
    await viewer.goto(`chrome-extension://${id}/viewer.html?job=${encodeURIComponent(pj)}&path=${encodeURIComponent("data/table.csv")}`);
    await sleep(1200);
    await viewer.screenshot({ path: path.join(os.tmpdir(), "lu-viewer-csv.png") }).catch(() => {});
    console.log(`      screenshots in ${os.tmpdir()}\\lu-popup-ready.png, lu-viewer-csv.png`);

    // Cancel part way.
    const { id: cj } = await send("inspect", { url: `${BASE}/many.zip` });
    const cr = await until(cj, ["ready", "error"]);
    await send("extract", { id: cj, target: { key: "base", sub: "cancel-test" }, output: "x", connections: 1 });
    await until(cj, ["extracting"]);
    await sleep(1500);
    await send("cancel", { id: cj });
    const cancelled = await until(cj, ["cancelled", "error", "done"], 30000);
    check(cancelled?.phase === "cancelled", `cancel: ${cancelled?.phase} after ${cancelled?.result?.files_done} files`);
    const leftovers = (await listOut("cancel-test")).filter((f) => f.endsWith(".crswap"));
    check(leftovers.length === 0, "cancel: no temp files left");
    void cr;

    // The resume journal (the helper's .linkunzip-resume.jsonl): after a stop it lists what was
    // finished, Resume skips those without reading them back, and it goes once the job is done.
    const { id: rj } = await send("inspect", { url: `${BASE}/many.zip` });
    await until(rj, ["ready", "error"]);
    const subset = { marks: { "": false, "many/d000/": true, "many/d001/": true, "many/d002/": true } };
    await send("extract", { id: rj, target: { key: "base", sub: "journal-test" }, output: "x", select: subset, connections: 1 });
    for (let i = 0; i < 200 && ((await job(rj))?.progress?.files_done || 0) < 300; i++) await sleep(100);
    await send("cancel", { id: rj });
    const rstop = await until(rj, ["cancelled", "error", "done"], 30000);
    const journalText = await page.evaluate(async () => {
      const base = await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip");
      const dir = await base.getDirectoryHandle("journal-test");
      try {
        return await (await (await dir.getFileHandle(".linkunzip-resume.jsonl")).getFile()).text();
      } catch {
        return "";
      }
    });
    const jlines = journalText.split("\n").filter(Boolean);
    const identity = jlines.length ? JSON.parse(jlines[0]) : {};
    const stoppedAt = rstop?.result?.files_done || 0;
    check(rstop?.phase === "cancelled" && identity.v === 1 && identity.size > 0 && jlines.length - 1 >= stoppedAt, `journal: stopped after ${stoppedAt} files, the journal lists ${jlines.length - 1} (identity size ${identity.size})`);
    const tr = Date.now();
    await send("resume", { id: rj });
    const rdone = await until(rj, ["done", "error"], 300000);
    const leftJournal = (await listOut("journal-test")).includes(".linkunzip-resume.jsonl");
    check(rdone?.phase === "done" && rdone.result.skipped_existing >= stoppedAt && rdone.result.verified_files === 2100 && !leftJournal, `journal: Resume skipped ${rdone?.result?.skipped_existing} without reading them back, wrote ${rdone?.result?.files} (${Date.now() - tr} ms); journal gone: ${!leftJournal}`, JSON.stringify(rdone?.error));

    // The stopped job closed, the zip opened again, Start (not Resume) into the same folder: the
    // journal left there still lets it skip what was finished.
    const { id: fj } = await send("inspect", { url: `${BASE}/many.zip` });
    await until(fj, ["ready", "error"]);
    await send("extract", { id: fj, target: { key: "base", sub: "journal-fresh" }, output: "x", select: subset, connections: 1 });
    for (let i = 0; i < 200 && ((await job(fj))?.progress?.files_done || 0) < 300; i++) await sleep(100);
    await send("cancel", { id: fj });
    const fstop = await until(fj, ["cancelled", "error", "done"], 30000);
    await send("dismiss", { id: fj });
    const { id: fj2 } = await send("inspect", { url: `${BASE}/many.zip` });
    await until(fj2, ["ready", "error"]);
    await send("extract", { id: fj2, target: { key: "base", sub: "journal-fresh" }, output: "x", select: subset, connections: 1 });
    const fdone = await until(fj2, ["done", "error"], 300000);
    const fstopped = fstop?.result?.files_done || 0;
    check(
      fstop?.phase === "cancelled" && fdone?.phase === "done" && fdone.result.skipped_existing >= fstopped && fdone.result.verified_files === 2100 && !(await listOut("journal-fresh")).includes(".linkunzip-resume.jsonl"),
      `journal: after closing the stopped job, a fresh Start into the same folder skipped ${fdone?.result?.skipped_existing} of the ${fstopped} finished files`,
      JSON.stringify(fdone?.error),
    );

    // Extract in the toolbar popup (here: popup.html without ?window=1) hands over to the
    // LinkUnzip window: with a folder Chrome needs nothing for, it starts there by itself.
    const { id: hj } = await send("inspect", { url: `${BASE}/small.zip` });
    await until(hj, ["ready", "error"]);
    const toolbar = await browser.newPage();
    await toolbar.goto(`chrome-extension://${id}/popup.html`);
    await toolbar.waitForSelector("#extract-btn", { timeout: 10000 });
    const winTarget = browser.waitForTarget((t) => t.url().includes("popup.html?window=1&start=1"), { timeout: 10000 }).catch(() => null);
    await toolbar.click("#extract-btn");
    const win = await winTarget;
    const handed = await until(hj, ["done", "error"], 60000);
    check(Boolean(win) && handed?.phase === "done" && handed.result.verified_files === 203, `Extract in the toolbar popup opens the LinkUnzip window and starts there (${win ? "window opened" : "no window"}, ${handed?.phase})`);
    const winPage = win ? await win.page() : null;
    await sleep(500);
    const winText = winPage ? await winPage.evaluate(() => document.body.innerText) : "";
    check(/Extracted 203 files/.test(winText), "the window shows the Done screen");

    // "A folder I choose" without a folder (it was removed): jobs go to Downloads meanwhile.
    await page.evaluate(async () => (await import("./folder.js")).removeFolder("base"));
    await send("baseFolderChanged");
    const { id: nj } = await send("inspect", { url: `${BASE}/streamed.zip` });
    const noFolder = await until(nj, ["ready", "error"]);
    check(noFolder?.output === "Downloads > streamed", `without a chosen folder a job goes to Downloads ("${noFolder?.output}")`);
    // Put the folder back for the checks below.
    await page.evaluate(async () => {
      const { setFolder } = await import("./folder.js");
      await setFolder("base", await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip", { create: true }));
    });
    await send("baseFolderChanged");

    // Chrome stops the background worker when nothing happens for a while; the offscreen page
    // outlives it. Afterwards LinkUnzip must still work (idle), and a running job must carry on.
    const cdp = await page.createCDPSession();
    await cdp.send("ServiceWorker.enable");
    const swRunning = () => browser.targets().some((t) => t.type() === "service_worker" && t.url().includes(id));
    async function stopWorker() {
      await cdp.send("ServiceWorker.stopAllWorkers").catch(() => {});
      for (let i = 0; i < 40 && swRunning(); i++) await sleep(250);
      return !swRunning();
    }
    const stoppedIdle = await stopWorker();
    check(stoppedIdle, "the background worker can be stopped (as Chrome does when idle)");
    await sleep(1500); // the offscreen page notices the lost connection and, being idle, stays quiet
    const ping2 = await send("ping");
    check(ping2?.ok && ping2.info?.engine === "browser", `after an idle stop the engine answers again (${JSON.stringify(ping2?.error || "")})`);
    const relisted = await send("list", { id: uj, dir: "", offset: 0, limit: 50 });
    check(relisted?.ok && relisted.listing.total > 0, "the file list of a zip opened before the stop still works (index read again)");
    const { id: aj } = await send("inspect", { url: `${BASE}/small.zip` });
    const again = await until(aj, ["ready", "error"]);
    check(again?.phase === "ready", `a new zip after the stop reads fine (${again?.phase} ${JSON.stringify(again?.error || "")})`);

    const { id: mj } = await send("inspect", { url: `${BASE}/many.zip` });
    await until(mj, ["ready", "error"]);
    await send("extract", { id: mj, target: { key: "base", sub: "sw-stop" }, output: "x", select: { paths: ["many/d000/", "many/d001/", "many/d002/"], exclude: [] }, connections: 1 });
    await until(mj, ["extracting"]);
    await sleep(2000);
    const before = (await job(mj))?.progress?.files_done || 0;
    const stoppedBusy = await stopWorker();
    await sleep(3000);
    const finished = await until(mj, ["done", "error", "cancelled"], 300000);
    check(stoppedBusy && finished?.phase === "done", `a job running while the worker is stopped finishes (${finished?.phase}, ${before} files before the stop, ${finished?.result?.files} at the end ${JSON.stringify(finished?.error || "")})`);

    // ---------------------------------------------------------------- Downloads (the default)
    await setSaveTo("downloads");
    const smallManifest = JSON.parse(fs.readFileSync(path.join(DATA, "small.manifest.json"), "utf8"));
    const { id: dj } = await send("inspect", { url: `${BASE}/small.zip` });
    const dready = await until(dj, ["ready", "error"]);
    check(dready?.output === "Downloads > small" && dready.target?.key === "downloads", `Downloads is the default: "${dready?.output}"`);
    // It needs nothing from Chrome first, so the toolbar popup starts it itself: no window.
    const tb = await browser.newPage();
    await tb.goto(`chrome-extension://${id}/popup.html`);
    await tb.waitForSelector("#extract-btn", { timeout: 10000 });
    const folderText = await tb.evaluate(() => document.querySelector(".folder-name")?.textContent);
    // (The window from the folder checks above is still open: count, don't wait for one.)
    const windows = () => browser.targets().filter((t) => t.url().includes("popup.html?window=1")).length;
    const windowsBefore = windows();
    const td = Date.now();
    await tb.click("#extract-btn");
    const ddone = await until(dj, ["done", "error"], 180000);
    const dms = Date.now() - td;
    const noWindow = windows() === windowsBefore;
    check(noWindow && ddone?.phase === "done" && ddone.result.verified_files === smallManifest.files.length, `Downloads: Extract in the toolbar popup starts right there (field "${folderText}", ${ddone?.phase}, ${ddone?.result?.verified_files} verified, ${dms} ms, ${(dms / smallManifest.files.length).toFixed(0)} ms per file)`, JSON.stringify(ddone?.error));
    let dbad = 0;
    for (const f of smallManifest.files) {
      const p = path.join(DL, "small", ...downloadsName(f.name.split("/")).parts);
      if (!fs.existsSync(p) || fileSha(p) !== f.sha256) dbad += 1;
    }
    check(dbad === 0, `Downloads: all ${smallManifest.files.length} files in <Downloads>/small match the manifest's SHA-256`);
    const temps = walk(DL).filter((f) => /\.crdownload$|\.tmp$/i.test(f) || /^Unconfirmed/.test(path.basename(f)));
    check(temps.length === 0, `Downloads: no half-saved files left (${temps.length})`);
    // Chrome's download list keeps one entry per job: its least nested file, for "Open folder".
    const keeperOf = await downloadList();
    const kept = (await job(dj))?.keeper;
    const keptItem = keeperOf.items.find((d) => d.id === kept?.id);
    const shallowest = Math.min(...smallManifest.files.map((f) => f.name.split("/").length));
    const keptRel = keptItem ? path.relative(path.join(DL, "small"), keptItem.filename).split(path.sep) : [];
    check(
      keeperOf.items.length === 1 && keptItem?.exists && keptRel.length === shallowest && kept.depth === shallowest,
      `Downloads: Chrome's download list keeps just one entry, ${keptRel.join("/")} (depth ${kept?.depth}, the least nested), for Open folder`,
      JSON.stringify({ kept, items: keeperOf.items.map((d) => d.filename) }),
    );
    await sleep(400);
    const dview = await tb.evaluate(() => document.body.innerText);
    check(/Open folder/.test(dview) && /Extracted 203 files/.test(dview), "Downloads: the Done screen offers Open folder");

    // Names Chrome's downloads refuse get a _ and are reported; extensions stay as they are; .dll
    // and .ini files are held back by Chrome until the user keeps them (said before and after).
    const { id: nmj } = await send("inspect", { url: `${BASE}/names.zip` });
    const nmr = await until(nmj, ["ready", "error"]);
    check(nmr?.report?.held_back === 2 && nmr.report.held_back_types.join() === "ini,dll", `Downloads: the index says 2 files will be held back (${nmr?.report?.held_back_types})`);
    await tb.reload();
    await tb.waitForSelector("#extract-btn", { timeout: 10000 });
    await sleep(400);
    const heldNote = await tb.evaluate(() => document.querySelector(".slow-note:not([hidden])")?.textContent || "");
    check(/hold back \.ini and \.dll files/.test(heldNote) && /2 here/.test(heldNote), `Downloads: the popup says so before starting ("${heldNote.slice(0, 80)}...")`);
    await send("extract", { id: nmj, target: nmr.target, output: nmr.output, connections: 2 });
    const nmd = await until(nmj, ["done", "error"], 60000);
    const nmFiles = walk(path.join(DL, "names")).filter((f) => !/crdownload$/.test(f)).sort();
    const wantNames = ["Makefile", "_.github/workflows/ci.yml", "_.gitignore", "data.csv", "notes_1.txt", "ok.txt", "shortcut.lnk_"];
    check(nmd?.phase === "done" && nmd.result.renamed === 5 && JSON.stringify(nmFiles) === JSON.stringify(wantNames), `Downloads: names Chrome refuses get a _, extensions stay (${nmd?.result?.renamed} renamed: ${nmFiles.join(", ")})`, JSON.stringify(nmd?.error || nmd?.result?.renamed_sample));
    check(nmd?.result?.held === 2 && nmd.result.held_ids?.length === 2, `Downloads: Chrome held back ${nmd?.result?.held} (${(nmd?.result?.held_sample || []).map((f) => `${f.name}: ${f.why}`).join(", ")})`);
    await sleep(400);
    const heldView = await tb.evaluate(() => document.body.innerText);
    check(/Chrome held back 2 files/.test(heldView) && /Keep them/.test(heldView), "Downloads: the Done screen lists them with Keep them");
    const heldList = await downloadList();
    check(heldList.held === 2 && heldList.others === 0, `Downloads: besides each job's one entry, only the 2 held files stay in Chrome's list, waiting for Keep (${heldList.items.map((d) => `${d.state}/${d.danger}`)})`);

    // A big file: Chrome keeps it as a blob (on disk past its memory limit) until it's saved.
    const bigSha = JSON.parse(fs.readFileSync(path.join(DATA, "big.zip.json"), "utf8")).sha256;
    const { id: bj } = await send("inspect", { url: `${BASE}/big.zip` });
    const br = await until(bj, ["ready", "error"]);
    const tb0 = Date.now();
    await send("extract", { id: bj, target: br.target, output: br.output, connections: 4 });
    const bd = await until(bj, ["done", "error"], 600000);
    // big.zip holds big/big.bin: Downloads/big/big.bin, not Downloads/big/big/big.bin.
    const bigFile = path.join(DL, "big", "big.bin");
    check(bd?.phase === "done" && fs.existsSync(bigFile) && fileSha(bigFile) === bigSha, `Downloads: a 400 MB file arrives intact in Downloads/big (${bd?.phase}, ${Date.now() - tb0} ms)`, JSON.stringify(bd?.error));

    // Many files: the popup says it will be slow and offers a folder.
    const { id: mmj } = await send("inspect", { url: `${BASE}/many.zip` });
    await until(mmj, ["ready", "error"]);
    await tb.reload();
    await tb.waitForSelector("#extract-btn", { timeout: 10000 });
    await sleep(500);
    const slowNote = await tb.evaluate(() => {
      const n = document.querySelector(".slow-note");
      return n && !n.hidden ? n.textContent : "";
    });
    check(/70,000 files/.test(slowNote) && /Choose a folder/.test(slowNote), `Downloads: many files get the speed note ("${slowNote.slice(0, 90)}...")`);
    // Settings: "A folder I choose" moves the waiting job to the folder, "Downloads" back.
    await tb.click("#settings-btn");
    await tb.click('#set-save input[value="folder"]');
    await sleep(600);
    const moved = (await job(mmj))?.output;
    const baseShown = await tb.evaluate(() => !document.getElementById("set-base-field").hidden && document.getElementById("set-base").textContent);
    await tb.click('#set-save input[value="downloads"]');
    await sleep(600);
    const back = (await job(mmj))?.output;
    check(moved === "LinkUnzip > many" && baseShown === "LinkUnzip" && back === "Downloads > many", `Settings: Downloads / A folder I choose moves the waiting job (${moved}, then ${back})`);

    // Stop part way, then Resume: what was saved is skipped. The worker is stopped in between too.
    await send("extract", { id: mmj, target: { key: "downloads", sub: "many-resume" }, output: "Downloads > many-resume", select: { paths: ["many/d000/", "many/d001/"], exclude: [] }, connections: 2 });
    await until(mmj, ["extracting"]);
    await sleep(2500);
    await stopWorker();
    await sleep(2500);
    await send("cancel", { id: mmj });
    const mc = await until(mmj, ["cancelled", "error", "done"], 60000);
    const doneBefore = mc?.result?.files_done || 0;
    // The engine's page closes when idle, and with it what it remembered saving: Resume still
    // knows from the record in IndexedDB.
    await sleep(1500); // the record is written in batches
    const swNow = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().includes(id), { timeout: 15000 });
    await (await swNow.worker()).evaluate(() => chrome.offscreen.closeDocument().catch(() => {}));
    await sleep(500);
    await send("resume", { id: mmj });
    const mr = await until(mmj, ["done", "error"], 300000);
    check(mc?.phase === "cancelled" && doneBefore > 0 && mr?.phase === "done" && mr.result.skipped_existing >= doneBefore, `Downloads: stopped after ${doneBefore} files (worker stopped, engine page closed), Resume skipped ${mr?.result?.skipped_existing} and saved ${mr?.result?.files}`, JSON.stringify(mc?.error || mr?.error));
    const history2 = await downloadList();
    check(history2.held === 2 && history2.others === 0, `Downloads: the download list is still clean after all that (the 2 held files and ${history2.keepers} job entries for Open folder)`);

    // Catch .zip downloads: Chrome's own download is paused, not cancelled (a link may only work
    // once), and goes once LinkUnzip extracted the files. big.zip, so it is still running when
    // LinkUnzip catches it.
    const setCatch = (on) =>
      page.evaluate(async (v) => {
        const { loadSettings } = await import("./settings.js");
        await chrome.storage.local.set({ settings: { ...(await loadSettings()), catchDownloads: v } });
      }, on);
    await setCatch(true);
    const tab = await browser.newPage();
    await tab.goto(`${BASE}/big.zip`).catch(() => {}); // a download, not a page
    let caught = null;
    for (let i = 0; i < 80 && !caught; i++) {
      await sleep(250);
      const s = await page.evaluate(() => chrome.storage.session.get(["jobs", "current"]));
      const j = s.jobs?.[s.current];
      if (j?.caught?.downloadId != null && j.url.endsWith("/big.zip")) caught = j;
    }
    const downloadOf = (i) => page.evaluate((x) => chrome.downloads.search({ id: x }).then((r) => r[0] || null), i);
    const paused = caught ? await downloadOf(caught.caught.downloadId) : null;
    check(Boolean(caught) && paused?.state === "in_progress" && paused.paused === true, `Catch .zip downloads: Chrome's download is paused, not cancelled (${paused?.state}, paused: ${paused?.paused})`);
    if (caught) {
      const cr2 = await until(caught.id, ["ready", "error"]);
      await send("extract", { id: caught.id, target: cr2.target, output: cr2.output, connections: 4 });
      const cd2 = await until(caught.id, ["done", "error"], 600000);
      await sleep(800);
      const after = await downloadOf(caught.caught.downloadId);
      check(cd2?.phase === "done" && !after, `Catch .zip downloads: once extracted, the paused download is gone (${cd2?.phase}, ${after ? after.state : "erased"})`, JSON.stringify(cd2?.error));
    }
    await tab.close().catch(() => {});
    await setCatch(false);
  } finally {
    await browser.close();
    server.kill();
    slow.kill();
    norange.kill();
  }
  if (FEATURES_ONLY) {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  }

  // Chrome set to "Ask where to save each file": LinkUnzip stops after the first file and says why.
  const DL2 = fs.mkdtempSync(path.join(os.tmpdir(), "lu-downloads-ask-"));
  const server2 = spawn("python", [path.join(root, "tools", "range_server.py"), DATA, String(PORT)], { stdio: "ignore" });
  await sleep(1200);
  const asking = await puppeteer.launch({ executablePath: CHROME, headless: !HEADFUL, pipe: true, protocolTimeout: 0, userDataDir: profileWithDownloads(DL2, true), enableExtensions: [ext], args: ["--no-first-run"] });
  try {
    const worker = await asking.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
    const xid = new URL(worker.url()).host;
    const p2 = await asking.newPage();
    await p2.goto(`chrome-extension://${xid}/popup.html?window=1`);
    await sleep(800);
    const send2 = (cmd, data = {}) => p2.evaluate((m) => chrome.runtime.sendMessage(m), { cmd, ...data });
    const job2 = async (jid, phases) => {
      for (let i = 0; i < 400; i++) {
        const j = await p2.evaluate((x) => chrome.storage.session.get("jobs").then((s) => s.jobs?.[x]), jid);
        if (j && phases.includes(j.phase)) return j;
        await sleep(150);
      }
      return null;
    };
    const { id: aj2 } = await send2("inspect", { url: `${BASE}/small.zip` });
    const ar = await job2(aj2, ["ready", "error"]);
    await send2("extract", { id: aj2, target: ar.target, output: ar.output, connections: 4 });
    const ae = await job2(aj2, ["error", "done"]);
    await p2.reload();
    await sleep(800);
    const atext = await p2.evaluate(() => document.body.innerText);
    check(ae?.phase === "error" && ae.error.code === "ask_where" && /asks where to save/.test(atext) && /download settings/.test(atext), `"Ask where to save each file" on: stops with its own explanation (${ae?.phase} ${ae?.error?.code})`);
  } finally {
    await asking.close();
    server2.kill();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
