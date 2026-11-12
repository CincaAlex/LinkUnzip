// Measure the browser engine on real servers, in real Chrome (a test copy of the extension with
// host access granted up front; files go into the browser's private file system, which a
// throwaway profile deletes afterwards).
//
//   set E2E_MODULES=<a folder where `npm i puppeteer-core` ran>
//   node tools/e2e/real_hosts.mjs [blender] [coco] [github] [hf] [--headful]
//
// blender: Blender 4.2 for Windows, every file (5,518 files, about 925 MB written).
// coco:    one photo out of COCO train2017 (18 GB zip, 118,287 files).
// github:  a GitHub release asset (redirects to release-assets.githubusercontent.com), every file.
// hf:      one photo out of a Hugging Face dataset zip (redirects to its CDN with a signed URL).
//
// Before the extraction each host's If-Range answer is printed, from Node: its validators, the
// probe's check (If-Range on or off) and what a wrong If-Range gets (it must be 200).

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Source } from "../../extension/engine/source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => `${(n / 1048576).toFixed(1)} MB`;

const CASES = {
  blender: { url: "https://download.blender.org/release/Blender4.2/blender-4.2.0-windows-x64.zip", select: null },
  coco: { url: "http://images.cocodataset.org/zips/train2017.zip", select: { paths: ["train2017/000000000009.jpg"], exclude: [] } },
  github: { url: "https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-pc-windows-msvc.zip", select: null },
  hf: { url: "https://huggingface.co/datasets/nlphuji/flickr30k/resolve/main/flickr30k-images.zip", select: { marks: { "": false, "flickr30k-images/1000092795.jpg": true } } },
};
const wanted = process.argv.slice(2).filter((a) => CASES[a]);

/** What the host does with If-Range: validators, the probe's check, and a wrong one. */
async function ifRangeReport(name, url) {
  const src = await Source.probe(url, { credentials: "omit" });
  const resp = await fetch(url, { headers: { Range: "bytes=0-0", "If-Range": src.etag ? '"linkunzip-wrong"' : "Thu, 01 Jan 1970 00:00:00 GMT" } });
  resp.body?.cancel().catch(() => {});
  // 200: the host honours If-Range. 206: it ignores it, which is harmless (the ETag or
  // Last-Modified check after every answer still catches a changed file) but adds nothing.
  const how = resp.status === 200 ? "honoured" : resp.status === 206 ? "ignored (the check after each answer still catches a change)" : `answered ${resp.status}`;
  const ok = resp.status === 200 || (resp.status === 206 && (src.etag || src.lastModified));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ETag ${src.etag || "none"}, Last-Modified ${src.lastModified || "none"}; If-Range ${src.ifRange ? `sent (${src.ifRange})` : "off"}, ${how}`);
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-real-"));
  fs.cpSync(path.join(root, "extension"), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: !process.argv.includes("--headful"), pipe: true, enableExtensions: [dir], args: ["--no-first-run"] });
  try {
    const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/popup.html?window=1`);
    await page.evaluate(async () => {
      const { setFolder } = await import("./folder.js");
      const opfs = await navigator.storage.getDirectory();
      await setFolder("base", await opfs.getDirectoryHandle("LinkUnzip", { create: true }));
      // Into that folder, not Downloads (Chrome's downloads save about 8 files a second).
      const { loadSettings } = await import("./settings.js");
      await chrome.storage.local.set({ settings: { ...(await loadSettings()), saveTo: "folder" } });
      await chrome.runtime.sendMessage({ cmd: "baseFolderChanged" });
    });
    const send = (cmd, data = {}) => page.evaluate((m) => chrome.runtime.sendMessage(m), { cmd, ...data });
    const job = (j) => page.evaluate((x) => chrome.storage.session.get("jobs").then((s) => s.jobs?.[x]), j);
    const until = async (j, phases, ms) => {
      const end = Date.now() + ms;
      let last = 0;
      for (;;) {
        const s = await job(j);
        if (s && phases.includes(s.phase)) return s;
        if (s?.progress && Date.now() - last > 5000) {
          last = Date.now();
          console.log(`      ${s.progress.files_done}/${s.progress.total_files} files, ${MB(s.progress.downloaded)} of ${MB(s.progress.total_compressed)}, ${MB(s.progress.rate)}/s`);
        }
        if (Date.now() > end) return s;
        await sleep(250);
      }
    };
    for (const name of wanted.length ? wanted : Object.keys(CASES)) {
      const c = CASES[name];
      await ifRangeReport(name, c.url).catch((e) => console.log(`FAIL  ${name}: If-Range check: ${e.message}`));
      const t0 = Date.now();
      const { id: j } = await send("inspect", { url: c.url });
      const ready = await until(j, ["ready", "error"], 120000);
      const tIndex = Date.now() - t0;
      if (ready?.phase !== "ready") {
        console.log(`FAIL  ${name}: ${JSON.stringify(ready?.error)}`);
        continue;
      }
      const r = ready.report;
      console.log(`${name}: index of ${r.files.toLocaleString()} files read in ${(tIndex / 1000).toFixed(1)} s, index ${MB(r.index_bytes)}, zip ${MB(r.archive_size)}`);
      const t1 = Date.now();
      await send("extract", { id: j, target: ready.target, output: ready.output, select: c.select, connections: 4 });
      const done = await until(j, ["done", "error", "cancelled"], 1800000);
      const s = (Date.now() - t1) / 1000;
      if (done?.phase !== "done") {
        console.log(`FAIL  ${name}: ${done?.phase} ${JSON.stringify(done?.error)}`);
        continue;
      }
      const d = done.result;
      console.log(
        `PASS  ${name}: ${d.files.toLocaleString()} files, ${MB(d.extracted_bytes)} written, ${MB(d.downloaded_bytes)} downloaded in ${d.requests} requests (index ${MB(d.index_bytes)}), ${d.verified_files.toLocaleString()} verified, zip on disk ${d.zip_bytes_on_disk} B, ${s.toFixed(1)} s (engine says ${(d.elapsed_ms / 1000).toFixed(1)} s)`,
      );
      await send("dismiss", { id: j });
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
