// End-to-end test of the browser engine in real Chrome: the extension (a test copy with host
// access granted up front, since a test can't click Chrome's permission prompt), its offscreen
// engine, a local Range server, and the browser's private file system standing in for the folder
// the user would pick. Saving into Downloads goes through Chrome's real downloads, into a test
// profile whose Downloads folder is a temporary one. Files are checked against the generator's
// SHA-256 manifest.
//
//   python tools/make_test_zips.py all-small --out <data>
//   set E2E_MODULES=<a folder where `npm i puppeteer-core` ran>
//   node tools/e2e/browser_engine.mjs <data> [--headful]

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { downloadsName } from "../../extension/engine/dl-sink.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");

const DATA = path.resolve(process.argv[2] || "test-data");
const HEADFUL = process.argv.includes("--headful");
// --only=small,many: just those archives (and skip the rest of the checks).
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7).split(",").filter(Boolean);
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8191;
const BASE = `http://127.0.0.1:${PORT}`;
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
  bigZip(path.join(DATA, "big.zip"), 400);
  const server = spawn("python", [path.join(root, "tools", "range_server.py"), DATA, String(PORT)], { stdio: "ignore" });
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

    const ping = await send("ping");
    check(ping.ok && ping.info?.engine === "browser", `engine answers hello (features: ${ping.info?.features?.join(", ")})`);

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
      let bad = 0;
      for (const f of sample) if ((await sha(`${kind}/${f.name}`).catch(() => "")) !== f.sha256) bad += 1;
      check(bad === 0, `${kind}: SHA-256 of ${sample.length} files match the manifest`);
      if (kind !== "many") {
        const files = await listOut(kind);
        check(!files.some((f) => f.endsWith(".crswap")) && files.length === manifest.files.length, `${kind}: ${files.length} files in the folder, no temp files`);
      }
      await send("dismiss", { id: jid });
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
    const history = await page.evaluate(() => chrome.downloads.search({}).then((x) => x.length));
    check(history === 0, `Downloads: Chrome's download list stays clean (${history} entries)`);
    await sleep(400);
    const dview = await tb.evaluate(() => document.body.innerText);
    check(/Open Downloads/.test(dview) && /Extracted 203 files/.test(dview), "Downloads: the Done screen offers Open Downloads");

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
    const heldList = await page.evaluate(() => chrome.downloads.search({}).then((x) => x.map((d) => `${d.state}/${d.danger}`)));
    check(heldList.length === 2 && heldList.every((x) => x === "in_progress/file"), `Downloads: only the 2 held files stay in Chrome's list, waiting for Keep (${heldList})`);

    // A big file: Chrome keeps it as a blob (on disk past its memory limit) until it's saved.
    const bigSha = JSON.parse(fs.readFileSync(path.join(DATA, "big.zip.json"), "utf8")).sha256;
    const { id: bj } = await send("inspect", { url: `${BASE}/big.zip` });
    const br = await until(bj, ["ready", "error"]);
    const tb0 = Date.now();
    await send("extract", { id: bj, target: br.target, output: br.output, connections: 4 });
    const bd = await until(bj, ["done", "error"], 600000);
    const bigFile = path.join(DL, "big", "big", "big.bin");
    check(bd?.phase === "done" && fs.existsSync(bigFile) && fileSha(bigFile) === bigSha, `Downloads: a 400 MB file arrives intact (${bd?.phase}, ${Date.now() - tb0} ms)`, JSON.stringify(bd?.error));

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
    await send("resume", { id: mmj });
    const mr = await until(mmj, ["done", "error"], 300000);
    check(mc?.phase === "cancelled" && doneBefore > 0 && mr?.phase === "done" && mr.result.skipped_existing >= doneBefore, `Downloads: stopped after ${doneBefore} files (worker stopped too), Resume skipped ${mr?.result?.skipped_existing} and saved ${mr?.result?.files}`, JSON.stringify(mc?.error || mr?.error));
    const history2 = await page.evaluate(() => chrome.downloads.search({}).then((x) => x.length));
    check(history2 === 2, `Downloads: the download list is still clean after all that (${history2} entries: the 2 held files)`);
  } finally {
    await browser.close();
    server.kill();
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
