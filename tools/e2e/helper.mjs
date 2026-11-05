// End-to-end test of Settings > Extract with the Windows helper: real Chrome, the popup, and a
// real helper (`linkunzip.exe` in host mode). Chrome finds native hosts in the registry, where
// the helper installed on this PC is registered; so that the test can run the helper it just
// built, without touching that registration, it gives the extension's worker a stand-in for
// chrome.runtime.connectNative that talks to the helper through a small local bridge, with the
// same framing Chrome uses. The helper's Downloads folder is a temporary one (USERPROFILE).
//
//   cargo build                  (the helper to test; HELPER_EXE overrides its path)
//   set E2E_MODULES=<a folder where `npm i puppeteer-core` ran>
//   set E2E_DATA=<data>          (make_test_zips.py all-small; default %LOCALAPPDATA%\linkunzip-test\engine-data)
//   node tools/e2e/helper.mjs
//
// With OLD_HELPER_EXE (for example the installed one) it also checks that a helper too old for
// this is not used, and says why.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bytesOf, makeZip } from "../test_zips.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");

const LOCAL = process.env.LOCALAPPDATA || os.tmpdir();
const DATA = process.env.E2E_DATA || path.join(LOCAL, "linkunzip-test", "engine-data");
const WORK = path.join(LOCAL, "linkunzip-e2e");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HELPER = process.env.HELPER_EXE || path.join(process.env.CARGO_TARGET_DIR || path.join(root, "target"), "debug", "linkunzip.exe");
const OLD_HELPER = process.env.OLD_HELPER_EXE || null;
const EXT_ID = "mgmhodmhlmedihmpiofacdffdekaehhk";
const ZIPS = 8096;
const BRIDGE = 8097;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && extra ? `\n      ${extra}` : ""}`);
  if (!ok) failures += 1;
}

function testCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lu-helper-ext-"));
  fs.cpSync(path.join(root, "extension"), dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

function profileWithDownloads(dir) {
  const profile = fs.mkdtempSync(path.join(WORK, "profile-"));
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Preferences"), JSON.stringify({ download: { default_directory: dir, prompt_for_download: false, directory_upgrade: true } }));
  return profile;
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(p, base) : [path.relative(base, p).replaceAll("\\", "/")];
  });
}

/** The test zips, served with Range support. */
function zipServer(files) {
  const server = http.createServer((req, res) => {
    const data = files.get(decodeURIComponent(req.url.slice(1)));
    if (!data) {
      res.writeHead(404);
      return res.end();
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    const headers = { "Content-Type": "application/zip", "Accept-Ranges": "bytes", ETag: '"t1"', "Content-Length": String(end - start + 1) };
    if (m) headers["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
    res.writeHead(m ? 206 : 200, headers);
    res.end(req.method === "HEAD" ? undefined : data.subarray(start, end + 1));
  });
  return new Promise((resolve) => server.listen(ZIPS, "127.0.0.1", () => resolve(server)));
}

/**
 * The bridge: POST /open starts the helper (`exe`) as Chrome would and answers a session id;
 * POST /send writes one message to it; GET /recv streams its messages, one JSON per line, and
 * ends when it exits; POST /kill ends it (Chrome's port then disconnects).
 */
function bridge(home) {
  const sessions = new Map();
  const state = { exe: HELPER, opened: 0, sent: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const s = sessions.get(url.searchParams.get("s"));
    if (req.method === "POST" && url.pathname === "/open") {
      const id = String(++state.opened);
      const child = spawn(state.exe, [`chrome-extension://${EXT_ID}/`], { env: { ...process.env, USERPROFILE: home, HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
      const session = { child, out: [], wake: null, ended: false };
      let buf = Buffer.alloc(0);
      child.stdout.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
          const n = buf.readUInt32LE(0);
          session.out.push(buf.subarray(4, 4 + n).toString("utf8"));
          buf = buf.subarray(4 + n);
        }
        session.wake?.();
      });
      child.on("exit", () => {
        session.ended = true;
        session.wake?.();
      });
      sessions.set(id, session);
      return res.end(id);
    }
    if (!s) {
      res.writeHead(404);
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/send") {
      let body = "";
      for await (const c of req) body += c;
      state.sent.push(JSON.parse(body));
      const bytes = Buffer.from(body, "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(bytes.length);
      s.child.stdin.write(Buffer.concat([len, bytes]));
      return res.end("ok");
    }
    if (req.method === "POST" && url.pathname === "/kill") {
      s.child.kill();
      return res.end("ok");
    }
    if (url.pathname === "/recv") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      for (;;) {
        while (s.out.length) res.write(`${s.out.shift()}\n`);
        if (s.ended) return res.end();
        await new Promise((r) => (s.wake = r));
      }
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(BRIDGE, "127.0.0.1", () => resolve({ server, state, sessions })));
}

/** In the extension's worker: chrome.runtime.connectNative through the bridge at `base`. */
function useBridge(base) {
  chrome.runtime.connectNative = () => {
    const onMessage = [];
    const onDisconnect = [];
    let chain = fetch(`${base}/open`, { method: "POST" }).then((r) => r.text());
    const port = {
      onMessage: { addListener: (f) => onMessage.push(f) },
      onDisconnect: { addListener: (f) => onDisconnect.push(f) },
      postMessage(m) {
        chain = chain.then(async (sid) => {
          await fetch(`${base}/send?s=${sid}`, { method: "POST", body: JSON.stringify(m) });
          return sid;
        });
      },
      disconnect() {
        chain.then((sid) => fetch(`${base}/kill?s=${sid}`, { method: "POST" }));
      },
    };
    chain.then(async (sid) => {
      const reader = (await fetch(`${base}/recv?s=${sid}`)).body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line) for (const f of onMessage) f(JSON.parse(line));
        }
      }
      for (const f of onDisconnect) f();
    });
    return port;
  };
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);

async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  if (!fs.existsSync(HELPER)) throw new Error(`no helper at ${HELPER} (cargo build, or set HELPER_EXE)`);
  const top = { "readme.txt": Buffer.from("read me\n"), "data/a.csv": Buffer.from("a,b\n1,2\n".repeat(500)), "skip/b.bin": bytesOf(7, 200_000) };
  const files = new Map([
    ["helper-top.zip", makeZip([{ name: "helper-top/", data: Buffer.alloc(0), method: 0 }, ...Object.entries(top).map(([n, d]) => ({ name: `helper-top/${n}`, data: d }))])],
    ["locked.zip", fs.readFileSync(path.join(DATA, "locked.zip"))],
    ["plain.zip", makeZip([{ name: "one.txt", data: Buffer.from("one") }])],
  ]);
  const zips = await zipServer(files);
  const home = fs.mkdtempSync(path.join(WORK, "helper-home-"));
  fs.mkdirSync(path.join(home, "Downloads"));
  const b = await bridge(home);
  const chromeDownloads = fs.mkdtempSync(path.join(WORK, "dl-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    userDataDir: profileWithDownloads(chromeDownloads),
    enableExtensions: [testCopy()],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${EXT_ID}/`), { timeout: 20000 });
    const sw = await target.worker();
    // Right after the install, the worker's extension APIs may not be there yet.
    for (let i = 0; i < 50 && !(await sw.evaluate(() => typeof chrome !== "undefined" && Boolean(chrome.runtime?.id)).catch(() => false)); i++) await sleep(100);
    await sw.evaluate(useBridge, `http://127.0.0.1:${BRIDGE}`);
    const session = () => sw.evaluate(() => chrome.storage.session.get(["jobs", "current", "hostInfo"]));
    const setSettings = (extra) => sw.evaluate(async (x) => {
      const { settings = {} } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, ...x } });
    }, extra);
    const waitHelper = async (want) => {
      for (let i = 0; i < 100; i++) {
        const info = (await session()).hostInfo;
        if (want(info)) return info;
        await sleep(100);
      }
      return (await session()).hostInfo;
    };
    const openPopup = async () => {
      const page = await browser.newPage();
      page.on("pageerror", (e) => console.log(`      popup error: ${e.message}`));
      await page.setViewport({ width: 400, height: 700 });
      await page.goto(`chrome-extension://${EXT_ID}/popup.html`);
      await page.waitForSelector('#host-chip[data-state="ok"]', { timeout: 20000 });
      return page;
    };
    const inspect = async (page, name) => {
      // The popup opens on the last job: close it first, as "Extract another" would.
      const { current } = await session();
      if (current) {
        await page.evaluate((id) => chrome.runtime.sendMessage({ cmd: "dismiss", id }), current);
        await page.reload();
        await page.waitForSelector("input[type=url]", { timeout: 10000 });
      }
      await page.type("input[type=url]", `http://127.0.0.1:${ZIPS}/${name}`);
      await page.keyboard.press("Enter");
      await page.waitForSelector("#extract-btn", { timeout: 30000 });
      await sleep(300);
    };
    const note = (page) => text(page, ".engine-note");

    // ---- Off (the default): the helper is installed but not used ----------------------------
    let popup = await openPopup();
    const hello = await waitHelper((h) => h?.features);
    check(hello?.features?.includes("marks") && hello.features.includes("drop_top"), `the built helper answers hello with marks and drop_top (${hello?.version}: ${hello?.features})`);
    await popup.click("#settings-btn");
    await sleep(200);
    const row = await popup.evaluate(() => ({ shown: !document.getElementById("set-helper-row").hidden, on: document.getElementById("set-helper").checked, note: document.getElementById("set-helper-note").textContent }));
    check(row.shown && !row.on && /saves straight into/.test(row.note), `Settings: "Extract with the Windows helper" is offered, off by default ("${row.note.slice(0, 70)}...")`);
    await popup.click("#settings-done");
    await inspect(popup, "plain.zip");
    check((await text(popup, ".folder-name")) === "Downloads > plain" && (await note(popup)) === null, "off: a zip goes to Chrome's Downloads, extracted in the browser, nothing more said");
    await popup.close();

    // ---- On: the helper extracts, with the file list's ticks and the top folder left out ----
    await setSettings({ useHelper: true });
    popup = await openPopup();
    await inspect(popup, "helper-top.zip");
    const want = path.join(home, "Downloads", "helper-top");
    const shown = await text(popup, ".folder-name");
    check(shown === want && (await note(popup)) === "Extracted by the Windows helper.", `on: the popup says the helper extracts it, into ${shown}`, `${shown} / ${await note(popup)}`);
    // Untick helper-top/skip/ in the file list.
    await popup.evaluate(() => [...document.querySelectorAll("button.fl-name.dir")].find((x) => x.textContent === "helper-top/").click());
    await popup.waitForFunction(() => [...document.querySelectorAll(".fl-row .fl-name")].some((e) => e.textContent === "skip/"), { timeout: 10000 });
    await popup.evaluate(() => [...document.querySelectorAll(".fl-row")].find((r) => r.querySelector(".fl-name").textContent === "skip/").querySelector("input").click());
    await sleep(500);
    await popup.click("#extract-btn");
    let job = null;
    for (let i = 0; i < 300; i++) {
      const s = await session();
      job = s.jobs?.[s.current];
      if (job?.phase === "done" || job?.phase === "error") break;
      await sleep(100);
    }
    const sent = b.state.sent.find((m) => m.type === "extract");
    check(job?.phase === "done" && job.via === "helper", `the helper extracted it (${job?.phase}, via ${job?.via})`, JSON.stringify(job?.error));
    check(sent?.drop_top === true && sent.select?.marks?.["helper-top/skip/"] === false && !("headers" in sent) && sent.output === want, `what went to the helper: the link, the ticks as they are, drop_top, ${sent?.output}; no cookies or page address`, JSON.stringify(sent));
    const got = listFiles(want).sort();
    check(JSON.stringify(got) === JSON.stringify(["data/a.csv", "readme.txt"]), `files land in Downloads\\helper-top without the doubled folder, skip/ left out (${got.join(", ")})`);
    check(got.every((f) => fs.readFileSync(path.join(want, f)).equals(top[f])), "and match byte for byte");
    check(listFiles(chromeDownloads).length === 0, "nothing went through Chrome's downloads");
    await sleep(400);
    const labels = await popup.$$eval("button", (bs) => bs.filter((x) => !x.hidden).map((x) => x.textContent.trim()));
    check(labels.includes("Open folder"), `the done view offers Open folder (Explorer, from the helper) (${labels.join(" | ")})`);
    await popup.close();

    // ---- On, but a job the helper can't do: the browser takes it and the popup says why -----
    popup = await openPopup();
    await inspect(popup, "locked.zip");
    const lockedNote = await note(popup);
    check(/^Extracted in the browser: the helper can't open password-protected files/.test(lockedNote || "") && (await text(popup, ".folder-name")) === "Downloads > locked", `a password zip: "${lockedNote}"`);
    await popup.close();

    // ---- A helper too old for this ----------------------------------------------------------
    if (OLD_HELPER) {
      for (const s of b.sessions.values()) s.child.kill();
      await waitHelper((h) => !h);
      b.state.exe = OLD_HELPER;
      popup = await openPopup();
      const old = await waitHelper((h) => h?.features);
      await popup.close();
      popup = await openPopup();
      await inspect(popup, "plain.zip");
      const oldNote = await note(popup);
      check(!old?.features?.includes("marks") && /too old/.test(oldNote || "") && (await text(popup, ".folder-name")) === "Downloads > plain", `helper ${old?.version} without marks: "${oldNote}"`);
      await popup.click("#settings-btn");
      await sleep(200);
      const oldRow = await popup.evaluate(() => document.getElementById("set-helper-note").textContent);
      check(/too old/.test(oldRow), `Settings says so too ("${oldRow}")`);
      await popup.close();
    }
  } finally {
    await browser.close();
    zips.close();
    for (const s of b.sessions.values()) s.child.kill();
    b.server.close();
  }
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
