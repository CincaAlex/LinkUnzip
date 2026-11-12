// How long a zip with many files takes into a folder (the browser's private file system standing
// in for a folder the user picked) and into Downloads, in real Chrome, from a local server, so
// the network doesn't count. Prints seconds, files a second and ms per file.
//
//   set E2E_MODULES=<a folder where `npm i puppeteer-core` ran>
//   node tools/e2e/bench_folder.mjs <data folder> [zip name, default blender.zip] [--downloads] [--runs=N] [--jobs=N]
//
// A zip name that starts with http:// or https:// is read from that server instead. Progress is
// printed every 5 seconds.
//
// blender.zip: https://download.blender.org/release/Blender4.2/blender-4.2.0-windows-x64.zip,
// saved into the data folder once (5,518 files, 925.6 MB written).

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DATA = path.resolve(args[0] || "test-data");
const ZIP = args[1] || "blender.zip";
const DOWNLOADS = process.argv.includes("--downloads");
const RUNS = Number((process.argv.find((a) => a.startsWith("--runs=")) || "--runs=1").slice(7));
const JOBS = Number((process.argv.find((a) => a.startsWith("--jobs=")) || "--jobs=4").slice(7));
const REMOTE = /^https?:\/\//.test(ZIP);
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8193;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function testCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-bench-"));
  fs.cpSync(path.join(root, "extension"), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

async function main() {
  if (!REMOTE && !fs.existsSync(path.join(DATA, ZIP))) throw new Error(`no ${ZIP} in ${DATA}`);
  const server = spawn("python", [path.join(root, "tools", "range_server.py"), DATA, String(PORT)], { stdio: "ignore" });
  await sleep(1000);
  const dl = fs.mkdtempSync(path.join(os.tmpdir(), "lu-bench-dl-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "lu-bench-profile-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: dl, prompt_for_download: false, directory_upgrade: true } }));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, protocolTimeout: 0, userDataDir: profile, enableExtensions: [testCopy()], args: ["--no-first-run"] });
  try {
    const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 15000 });
    const id = new URL(worker.url()).host;
    const page = await browser.newPage();
    await page.goto(`chrome-extension://${id}/popup.html?window=1`);
    await sleep(800);
    await page.evaluate(async () => {
      const { setFolder } = await import("./folder.js");
      await setFolder("base", await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip", { create: true }));
    });
    const send = (cmd, data = {}) => page.evaluate((m) => chrome.runtime.sendMessage(m), { cmd, ...data });
    const job = (jid) => page.evaluate((j) => chrome.storage.session.get("jobs").then((s) => s.jobs?.[j]), jid);
    const until = async (jid, phases) => {
      let last = Date.now();
      for (;;) {
        const j = await job(jid);
        if (j && phases.includes(j.phase)) return j;
        const p = j?.progress;
        if (p && Date.now() - last > 5000) {
          last = Date.now();
          console.log(`  ${(p.elapsed_ms / 1000).toFixed(0)} s: ${p.files_done}/${p.total_files} files, ${(p.downloaded / 1048576).toFixed(1)} MB downloaded, ${(p.extracted / 1048576).toFixed(1)} MB written, ${(p.rate / 1048576).toFixed(2)} MB/s, ${p.requests} requests, ${p.retries} retries`);
        }
        await sleep(200);
      }
    };
    for (let run = 1; run <= RUNS; run++) {
      const { id: jid } = await send("inspect", { url: REMOTE ? ZIP : `http://127.0.0.1:${PORT}/${ZIP}` });
      const ready = await until(jid, ["ready", "error"]);
      if (ready.phase !== "ready") throw new Error(JSON.stringify(ready.error));
      const sub = `bench-${run}-${Date.now()}`;
      const target = DOWNLOADS ? { key: "downloads", sub } : { key: "base", sub };
      const t0 = Date.now();
      await send("extract", { id: jid, target, output: sub, connections: JOBS });
      const done = await until(jid, ["done", "error"]);
      const s = (Date.now() - t0) / 1000;
      const files = done.result?.files || 0;
      console.log(`${DOWNLOADS ? "Downloads" : "folder"} ${ZIP}: ${done.phase}, ${files} files, ${(done.result?.extracted_bytes / 1048576).toFixed(1)} MB in ${s.toFixed(1)} s = ${(files / s).toFixed(0)} files/s, ${((s * 1000) / Math.max(1, files)).toFixed(1)} ms per file${done.phase === "error" ? ` ${JSON.stringify(done.error)}` : ""}`);
      await send("dismiss", { id: jid });
      if (!DOWNLOADS) await page.evaluate(async (n) => (await (await navigator.storage.getDirectory()).getDirectoryHandle("LinkUnzip")).removeEntry(n, { recursive: true }).catch(() => {}), sub);
    }
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
