// End-to-end test of the browser extension: real Chrome, the real extension, the real native
// host (the installed linkunzip.exe), and a local Range server. It drives the popup like a user
// would and checks the files that land on disk against the generator's manifest.
//
//   set E2E_MODULES=%LOCALAPPDATA%\linkunzip-e2e        (a folder where `npm i puppeteer-core` ran)
//   dist\linkunzip-setup.exe  (or: linkunzip host install) (once)
//   node tools/e2e/extension.mjs [--shots <dir>]
//
// It needs a demo archive: python tools/make_test_zips.py demo --out <dir> --size-gb 1.2
// (point E2E_DATA at that folder; default %LOCALAPPDATA%\linkunzip-test\demo-data).

import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const require = createRequire(`${process.env.E2E_MODULES || root}/`);
const puppeteer = require("puppeteer-core");

const LOCAL = process.env.LOCALAPPDATA || os.tmpdir();
const DATA = process.env.E2E_DATA || path.join(LOCAL, "linkunzip-test", "demo-data");
const WORK = path.join(LOCAL, "linkunzip-e2e");
const SHOTS = process.argv.includes("--shots")
  ? process.argv[process.argv.indexOf("--shots") + 1]
  : path.join(WORK, "shots");
// --stubs-only: just the load checks and the stubbed views (quick, no local servers needed).
const STUBS_ONLY = process.argv.includes("--stubs-only");
const CHROME = process.env.CHROME || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT = path.join(root, "extension");
const EXT_ID = "mgmhodmhlmedihmpiofacdffdekaehhk";
const FAST = 8090;
const SLOW = 8091;
const NORANGE = 8092;

fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
let failures = 0;
let lastPopup = null;
let lastWorker = null;

function check(ok, what) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures += 1;
}

/** A check that needs a newer helper than the installed one. */
function skip(what, why) {
  console.log(`SKIP  ${what} (${why})`);
}

/** What the real helper said in hello (stored by the background). */
const realHostInfo = (page) => page.evaluate(() => chrome.storage.session.get("hostInfo").then((s) => s.hostInfo || {}));

/** Verify an extracted folder against the demo manifest; `only` limits it to some names. */
function verifyAgainstManifest(folder, only = null) {
  const args = [path.join(root, "tools", "verify_extract.py"), folder, path.join(DATA, "demo.manifest.json")];
  for (const name of only || []) args.push("--only", name);
  const r = spawnSync("python", args, { encoding: "utf8" });
  return { ok: r.status === 0, last: (r.stdout || r.stderr || "").trim().split("\n").pop() };
}

function serve(port, { mbps = 0, rangeless = false } = {}) {
  const args = rangeless
    ? ["-m", "http.server", String(port), "--bind", "127.0.0.1"]
    : [path.join(root, "tools", "range_server.py"), DATA, String(port)];
  const child = spawn("python", args, {
    cwd: DATA,
    env: { ...process.env, MBPS: String(mbps), PYTHONUNBUFFERED: "1" },
    stdio: "ignore",
  });
  servers.push(child);
  return child;
}

async function waitForPort(port) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/demo.zip`, { method: "HEAD" });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`server on ${port} did not start`);
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

async function openPopup(browser, params = "") {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 700, deviceScaleFactor: 2 });
  await page.goto(`chrome-extension://${EXT_ID}/popup.html${params}`);
  return page;
}

const HOST_INFO_V1 = { type: "hello", version: "0.2.0", os: "windows", downloads_dir: "C:\\Users\\me\\Downloads" };
const HOST_INFO_V2 = {
  ...HOST_INFO_V1,
  version: "0.2.1",
  protocol: 2,
  features: ["pick_folder", "list", "search", "measure", "select", "resume", "error_codes"],
};

/** A job that has read its index (`ready`), with a report like the helper's. */
function readyJob(report = {}) {
  const GB = 1024 ** 3;
  return {
    id: "j-ready",
    url: "http://127.0.0.1:8090/big.zip",
    pageUrl: "",
    name: "big.zip",
    phase: "ready",
    loginSent: false,
    output: "C:\\Users\\me\\Downloads\\LinkUnzip\\big",
    report: {
      url: "http://127.0.0.1:8090/big.zip", mode: "range", archive_size: 0.9 * GB, files: 24, dirs: 3,
      compressed: 0.88 * GB, extracted: 1.2 * GB, normal_needs: 2.1 * GB, linkunzip_needs: 1.2 * GB,
      free: 40 * GB, drive: "C:", normal_fits: true, linkunzip_fits: true, unsupported: 0,
      unsupported_sample: [], largest: [{ name: "videos/big.mp4", size: 0.4 * GB }],
      ...report,
    },
  };
}

/**
 * Open the popup with chrome.storage.session and the messages to the background replaced by canned
 * answers, for states the installed helper cannot produce. `session` is what the popup reads at
 * start; `replies` maps a command to its answer (default {ok: true}). In the page, window.__sent
 * holds every message sent and window.__emit(changes) plays a storage change.
 */
async function openStubbedPopup(browser, { session, replies = {}, local = null, archive = null, scheme = null }, params = "") {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 700, deviceScaleFactor: 2 });
  if (scheme) await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  await page.evaluateOnNewDocument((cfg) => {
    const state = cfg.session;
    const listeners = [];
    window.__sent = [];
    window.__emit = (changes) => {
      for (const [k, v] of Object.entries(changes)) state[k] = v.newValue;
      for (const fn of listeners) fn(changes, "session");
    };
    chrome.storage.session.get = async () => JSON.parse(JSON.stringify(state));
    chrome.storage.onChanged.addListener = (fn) => listeners.push(fn);
    if (cfg.local) chrome.storage.local.get = async () => JSON.parse(JSON.stringify(cfg.local));
    navigator.clipboard.writeText = async (t) => (window.__copied = t);
    if (cfg.archive) window.__fake = fakeHelper(cfg.archive);
    chrome.runtime.sendMessage = async (m) => {
      window.__sent.push(m);
      if (window.__fake?.[m.cmd]) return window.__fake[m.cmd](m);
      const r = cfg.replies[m.cmd];
      return r === undefined ? { ok: true } : r;
    };

    // list / search / measure over a made-up archive, the way protocol 2 describes them.
    // `spec` rows: [path, size] for one file, [folder, count, size] for many generated files.
    function fakeHelper(spec) {
      const files = [];
      for (const [path, a, b] of spec) {
        if (b === undefined) files.push({ path, size: a });
        else for (let i = 0; i < a; i++) files.push({ path: `${path}img${String(i).padStart(6, "0")}.jpg`, size: b });
      }
      for (const f of files) f.compressed = Math.round(f.size * 0.9);
      const tree = new Map();
      const node = (d) => tree.get(d) || tree.set(d, { dirs: new Map(), files: [] }).get(d);
      for (const f of files) {
        const parts = f.path.split("/");
        let dir = "";
        for (const part of parts.slice(0, -1)) {
          const sub = node(dir).dirs.get(part) || { files: 0, size: 0, compressed: 0 };
          sub.files += 1;
          sub.size += f.size;
          sub.compressed += f.compressed;
          node(dir).dirs.set(part, sub);
          dir += `${part}/`;
        }
        node(dir).files.push(f);
      }
      const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      const fileItem = (f) => ({ name: f.path.split("/").pop(), path: f.path, dir: false, size: f.size, compressed: f.compressed, unsupported: f.path.endsWith(".pdf") ? "encrypted" : null });
      const sorted = new Map();
      const children = (dir) => {
        if (!sorted.has(dir)) {
          const n = tree.get(dir) || { dirs: new Map(), files: [] };
          const dirs = [...n.dirs].map(([name, a]) => ({ name, path: `${dir}${name}/`, dir: true, ...a })).sort(byName);
          sorted.set(dir, [...dirs, ...n.files.map(fileItem).sort(byName)]);
        }
        return sorted.get(dir);
      };
      const at = (path) => (p) => path === p || (p.endsWith("/") && path.startsWith(p));
      const chosen = (path, sel) => (!sel?.paths?.length || sel.paths.some(at(path))) && !(sel?.exclude || []).some(at(path));
      return {
        list: ({ dir = "", offset = 0, limit = 500 }) => {
          const all = children(dir);
          return { ok: true, listing: { type: "listing", dir, offset, total: all.length, items: all.slice(offset, offset + Math.min(limit, 2000)) } };
        },
        search: ({ query, limit = 200 }) => {
          const hits = files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()));
          return { ok: true, results: { type: "search_results", query, total: hits.length, items: hits.slice(0, limit).map(fileItem) } };
        },
        measure: ({ select }) => {
          const m = { type: "measured", files: 0, extracted: 0, compressed: 0 };
          for (const f of files) {
            if (!chosen(f.path, select)) continue;
            m.files += 1;
            m.extracted += f.size;
            m.compressed += f.compressed;
          }
          return { ok: true, measured: m };
        },
      };
    }
  }, { session, replies: { ping: { ok: true, info: session.hostInfo }, ...replies }, local, archive });
  await page.goto(`chrome-extension://${EXT_ID}/popup.html${params}`);
  return page;
}

// The made-up archive for the file list: COCO-sized folder plus a few small ones (118,296 files).
const ARCHIVE = [
  ["train/", 118287, 160000],
  ["labels/a.txt", 100],
  ["labels/b.txt", 100],
  ["labels/c.txt", 100],
  ["docs/readme.txt", 2000],
  ["docs/api/index.html", 5000],
  ["docs/api/style.css", 1000],
  ["docs/guide.pdf", 50000],
  ["LICENSE", 1100],
  ["README.md", 2500],
];

/** A job in the error state, as background.js stores it. */
function failedJob(code, { error = {}, ...extra } = {}) {
  return {
    id: `j-${code}`,
    url: "https://files.example.com/private/data.zip?token=secret",
    pageUrl: "",
    name: "data.zip",
    phase: "error",
    failedWhile: "inspect",
    loginSent: false,
    output: "C:\\Users\\me\\Downloads\\LinkUnzip\\data",
    error: { code, message: `stub ${code}`, detail: `detail for ${code}`, host: "files.example.com", ...error },
    ...extra,
  };
}

/** Replace the job's folder (typing over a selection is flaky in headless). */
async function setFolderField(page, value) {
  await page.$eval('input[id^="folder-"]', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

const text = (page, sel) => page.$eval(sel, (el) => el.textContent).catch(() => null);

async function run() {
  if (!STUBS_ONLY) {
    if (!fs.existsSync(path.join(DATA, "demo.zip"))) throw new Error(`no demo.zip in ${DATA}`);
    serve(FAST);
    serve(SLOW, { mbps: 6 });
    serve(NORANGE, { rangeless: true });
    await Promise.all([FAST, SLOW, NORANGE].map(waitForPort));
  }

  const profile = fs.mkdtempSync(path.join(WORK, "profile-"));
  const downloads = fs.mkdtempSync(path.join(WORK, "dl-"));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: profile,
    enableExtensions: [EXT],
    args: ["--no-first-run", "--no-default-browser-check", "--window-size=900,900"],
  });
  try {
    await browser.target().createCDPSession().then((s) =>
      s.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads }),
    );
    const worker = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${EXT_ID}/`),
      { timeout: 20000 },
    );
    check(Boolean(worker), `extension loaded with the expected id ${EXT_ID}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
    check(
      !("host_permissions" in manifest) && manifest.optional_host_permissions?.includes("<all_urls>"),
      "the manifest asks for no site at install (optional_host_permissions only)",
    );
    // A first install opens the setup page, which finds the installed helper by itself.
    const welcomeTarget = await browser
      .waitForTarget((t) => t.url() === `chrome-extension://${EXT_ID}/welcome.html`, { timeout: 10000 })
      .catch(() => null);
    check(Boolean(welcomeTarget), "installing the extension opens the setup page");
    // The install handler adds the menu entry before it opens that page. Creating the same menu id
    // again fails with "duplicate id" only if the entry already exists.
    const sw0 = await worker.worker();
    const dup = await sw0.evaluate(
      () =>
        new Promise((resolve) =>
          chrome.contextMenus.create({ id: "linkunzip-extract-link", title: "x", contexts: ["link"] }, () =>
            resolve(chrome.runtime.lastError?.message || "created"),
          ),
        ),
    );
    check(/duplicate/i.test(dup), `the right-click entry "Extract with LinkUnzip" is registered (${dup})`);
    if (welcomeTarget) {
      const welcome = await welcomeTarget.page();
      await welcome.setViewport({ width: 900, height: 900 });
      const found = await welcome
        .waitForSelector('#step-helper[data-state="done"]', { timeout: 15000 })
        .then(() => true, () => false);
      check(found, `setup page detects the helper (${await text(welcome, "#helper-status")})`);
      // An older helper counts as installed; the update is only offered.
      // The background saves hostInfo a moment after the hello (debounced), so wait for it.
      const info = await (await worker.worker()).evaluate(async () => {
        for (let i = 0; i < 30; i++) {
          const { hostInfo } = await chrome.storage.session.get("hostInfo");
          if (hostInfo) return hostInfo;
          await new Promise((r) => setTimeout(r, 100));
        }
        return {};
      });
      const offered = await welcome.$eval("#helper-update", (el) => !el.hidden);
      check(offered === (info.protocol ?? 1) < 2, `the setup page offers the update only for an older helper (protocol ${info.protocol ?? 1}, offered: ${offered})`);
      await shot(welcome, "00-welcome");
      await welcome.close();

      // Update mode, from the popup's card: it waits for the new helper.
      const upd = await browser.newPage();
      await upd.setViewport({ width: 900, height: 900 });
      await upd.goto(`chrome-extension://${EXT_ID}/welcome.html?update=1`);
      const wantState = (info.protocol ?? 1) < 2 ? "next" : "done";
      const updOk = await upd.waitForSelector(`#step-helper[data-state="${wantState}"]`, { timeout: 15000 }).then(() => true, () => false);
      const updTitle = await text(upd, "#helper-title");
      check(updOk && updTitle === "Update the LinkUnzip helper", `the setup page in update mode: "${updTitle}", ${await text(upd, "#helper-status")}`);
      await shot(upd, "00b-welcome-update");
      await upd.close();
    }
    lastWorker = worker;
    if (STUBS_ONLY) {
      await stubbedViews(browser);
      return;
    }

    // ---- 1. paste a URL, inspect, extract ---------------------------------------------------
    let popup = await openPopup(browser);
    lastPopup = popup;
    lastWorker = worker;
    await popup.waitForSelector('#host-chip[data-state="ok"]', { timeout: 20000 });
    check(true, `popup reaches the native host (${await text(popup, "#host-chip")})`);
    const pickInfo = await realHostInfo(popup);
    if ((pickInfo.protocol ?? 1) < 2) {
      const card = await popup.waitForSelector(".card.update", { timeout: 5000 }).then(() => true, () => false);
      check(card, "an older helper gets the non-blocking 'A newer LinkUnzip helper is available' card");
    } else {
      check(!(await popup.$(".card.update")), "no update card with a current helper");
    }
    await shot(popup, "01-pick");

    await popup.type("input[type=url]", `http://127.0.0.1:${FAST}/demo.zip`);
    await popup.keyboard.press("Enter");
    await popup.waitForSelector(".compare", { timeout: 30000 });
    const cmp = await popup.$$eval(".cmp-total", (els) => els.map((e) => e.textContent));
    check(cmp.length === 2 && cmp[0] !== cmp[1], `comparison shows two different totals: ${cmp.join(" vs ")}`);
    const realBrowse = await popup.$$eval("button.browse", (bs) => bs.filter((b) => !b.hidden).length);
    const realProtocol = await popup.evaluate(() => chrome.storage.session.get("hostInfo").then((s) => s.hostInfo?.protocol ?? 1));
    check(realProtocol >= 2 || realBrowse === 0, `Browse... only when the helper has pick_folder (protocol ${realProtocol}, ${realBrowse} shown)`);
    await shot(popup, "02-ready");

    const out1 = path.join(WORK, "out", "demo");
    fs.rmSync(out1, { recursive: true, force: true });
    await setFolderField(popup, out1);
    await popup.click("#actions-slot button.btn.primary");
    await popup.waitForSelector(".big-pct", { timeout: 15000 });
    await popup.waitForSelector(".zero-line", { timeout: 180000 });
    const zeroText = await text(popup, ".zero-line");
    check(/Zip stored on disk\s*0 B/.test(zeroText), `done view says "${zeroText}"`);
    await shot(popup, "04-done");

    const verify = spawnSync("python", [path.join(root, "tools", "verify_extract.py"), out1, path.join(DATA, "demo.manifest.json")], { encoding: "utf8" });
    check(verify.status === 0, `every extracted file matches the manifest (${(verify.stdout || "").trim().split("\n").pop()})`);
    const sw1 = await worker.worker();
    const granted = await sw1.evaluate(() => chrome.permissions.getAll());
    const { jobs: jobs1 = {} } = await sw1.evaluate(() => chrome.storage.session.get("jobs"));
    const done1 = Object.values(jobs1).find((j) => j.phase === "done");
    check(
      (granted.origins || []).length === 0 && done1?.loginSent === false,
      `the public link worked with no site permission and no login sent (origins: ${JSON.stringify(granted.origins)})`,
    );
    const realFeatures = (await realHostInfo(popup)).features || [];

    // ---- 1b. choose files (helpers with list + select) ------------------------------------------
    if (realFeatures.includes("list") && realFeatures.includes("select")) {
      await popup.click("#actions-slot button.btn:not(.primary)"); // "Extract another"
      await popup.waitForSelector("input[type=url]");
      await popup.type("input[type=url]", `http://127.0.0.1:${FAST}/demo.zip`);
      await popup.keyboard.press("Enter");
      await popup.waitForSelector(".compare", { timeout: 30000 });
      await popup.waitForSelector(".fl-row", { timeout: 15000 });
      const firstFolder = (await rowNames(popup)).find((n) => n.endsWith("/"));
      await clickRow(popup, firstFolder);
      const demo = JSON.parse(fs.readFileSync(path.join(DATA, "demo.manifest.json"), "utf8"));
      const keep = demo.files.filter((f) => !f.name.startsWith(firstFolder)).map((f) => f.name);
      await popup.waitForFunction((p) => (document.querySelector(".fl-totals")?.textContent || "").startsWith(p), { timeout: 15000 }, `${keep.length} files`);
      await shot(popup, "02b-ready-chosen");
      const outSel = path.join(WORK, "out", "selected");
      fs.rmSync(outSel, { recursive: true, force: true });
      await setFolderField(popup, outSel);
      await popup.click("#actions-slot button.btn.primary");
      await popup.waitForSelector(".zero-line", { timeout: 180000 });
      const v = verifyAgainstManifest(outSel, keep);
      check(v.ok, `a real extraction of the ticked files (all but ${firstFolder}) matches the manifest (${v.last})`);
    } else {
      skip("real extraction of ticked files", "the installed helper has no list/select");
    }

    // ---- 2. stop in the middle ------------------------------------------------------------------
    await popup.click("#actions-slot button.btn:not(.primary)"); // "Extract another"
    await popup.waitForSelector("input[type=url]");
    await popup.type("input[type=url]", `http://127.0.0.1:${SLOW}/demo.zip`);
    await popup.keyboard.press("Enter");
    await popup.waitForSelector(".compare", { timeout: 30000 });
    const out2 = path.join(WORK, "out", "stopped");
    fs.rmSync(out2, { recursive: true, force: true });
    await setFolderField(popup, out2);
    await popup.click("#actions-slot button.btn.primary");
    await popup.waitForFunction(() => parseInt(document.querySelector(".big-pct")?.textContent || "0") >= 3, { timeout: 60000 });
    if (realFeatures.includes("resume")) {
      // Let a couple of files finish, so Resume has something to skip.
      await popup.waitForFunction(() => parseInt(document.querySelector(".stat b")?.textContent.replace(/,/g, "") || "0") >= 2, { timeout: 120000 });
    }
    await shot(popup, "03-extracting");
    await popup.click("#actions-slot button.btn.danger");
    await popup.waitForFunction(() => document.querySelector("h1")?.textContent === "Stopped", { timeout: 30000 });
    const parts = fs.existsSync(out2) ? listFiles(out2).filter((f) => f.endsWith(".part")) : [];
    check(parts.length === 0, `stopping leaves no .part files (${parts.length})`);
    await shot(popup, "05-stopped");

    // Resume (helpers with resume): only what is missing is downloaded, the result is complete.
    const stoppedLabels = await buttonLabels(popup);
    if (realFeatures.includes("resume")) {
      const sw2 = await worker.worker();
      const stoppedJob = await sw2.evaluate(() => chrome.storage.session.get(["jobs", "current"]).then((s) => s.jobs[s.current]));
      const finishedBefore = stoppedJob?.result?.files_done || 0;
      await clickButton(popup, "Resume");
      await popup.waitForSelector(".zero-line", { timeout: 300000 });
      const resumed = await sw2.evaluate(() => chrome.storage.session.get(["jobs", "current"]).then((s) => s.jobs[s.current]));
      const v = verifyAgainstManifest(out2);
      check(
        v.ok && resumed?.result?.skipped_existing >= finishedBefore && finishedBefore > 0,
        `Resume after Stop skips the ${resumed?.result?.skipped_existing} finished files and completes the folder (${v.last})`,
      );
      // The helper's progress says what was already there, so the popup's bar carries on
      // instead of starting again at 0 %.
      const carried = resumed?.progress?.skipped_files;
      check(carried >= finishedBefore && carried > 0, `the resumed progress counts the ${carried} files already there`);
      await shot(popup, "05b-resumed");
    } else {
      check(!stoppedLabels.includes("Resume"), "no Resume with a helper that can't skip finished files");
      skip("real Resume after Stop", "the installed helper has no resume");
    }

    // ---- 3. a server without Range support ---------------------------------------------------
    await popup.click("#actions-slot button.btn:last-child"); // "Close"
    await popup.waitForSelector("input[type=url]");
    await popup.type("input[type=url]", `http://127.0.0.1:${NORANGE}/demo.zip`);
    await popup.keyboard.press("Enter");
    await popup.waitForSelector(".tick.bad", { timeout: 30000 });
    const title = await text(popup, "h1");
    check(/can.t send parts/.test(title), `no-Range server explained: "${title}"`);
    await shot(popup, "06-no-range");

    // ...but it can still be streamed in one pass.
    const out3 = path.join(WORK, "out", "streamed");
    fs.rmSync(out3, { recursive: true, force: true });
    await setFolderField(popup, out3);
    await popup.click("#actions-slot button.btn.primary"); // "Stream it anyway"
    await popup.waitForSelector(".big-pct", { timeout: 15000 });
    await popup.waitForSelector(".zero-line", { timeout: 180000 });
    const streamed = await text(popup, ".kv");
    check(/1 pass/.test(streamed), `stream mode finished in one pass (${streamed.replace(/\s+/g, " ").trim().slice(0, 60)}...)`);
    const verify3 = spawnSync("python", [path.join(root, "tools", "verify_extract.py"), out3, path.join(DATA, "demo.manifest.json")], { encoding: "utf8" });
    check(verify3.status === 0, `streamed files match the manifest (${(verify3.stdout || "").trim().split("\n").pop()})`);
    await popup.click("#actions-slot button.btn:not(.primary)");

    // ---- 4. catch a .zip download ---------------------------------------------------------------
    await popup.evaluate(() => chrome.storage.local.set({ settings: { catchDownloads: true, loginWhenNeeded: true, connections: 4, baseFolder: "" } }));
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${FAST}/`);
    await page.click('a[href="demo.zip"]');
    const swHandle = await worker.worker();
    let job = null;
    for (let i = 0; i < 60 && !job; i++) {
      await sleep(250);
      const { jobs = {} } = await swHandle.evaluate(() => chrome.storage.session.get("jobs"));
      job = Object.values(jobs).find((j) => j.url.endsWith("/demo.zip") && j.phase === "ready") || null;
    }
    check(Boolean(job), "a .zip download was caught and turned into an inspected job");
    await sleep(500);
    const leftovers = fs.readdirSync(downloads);
    check(leftovers.length === 0, `Chrome saved nothing to the downloads folder (${leftovers.join(", ") || "empty"})`);
    await page.close();

    // ---- 5. views the installed helper cannot produce yet (stubbed) -------------------------
    await stubbedViews(browser);
  } catch (e) {
    await dumpFailure();
    throw e;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Click the button whose text is exactly `label`. */
async function clickButton(page, label) {
  const handle = await page.evaluateHandle(
    (l) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === l) || null,
    label,
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no button "${label}"`);
  await el.click();
}

const buttonLabels = (page) => page.$$eval("button", (bs) => bs.filter((b) => !b.hidden).map((b) => b.textContent.trim()));

async function stubbedViews(browser) {
  const session = (job, hostInfo = HOST_INFO_V1) => ({ jobs: { [job.id]: job }, current: job.id, hostInfo, hostError: null });

  // A site that wants the user's login, none sent: the card offers that one site.
  const login = failedJob("needs_login", { error: { http_status: 401 } });
  let p = await openStubbedPopup(browser, { session: session(login) });
  lastPopup = p;
  await p.waitForSelector(".hero h1");
  const h1 = await text(p, ".hero h1");
  check(
    /needs your login on files\.example\.com/.test(h1) && (await buttonLabels(p)).includes("Use my login on files.example.com"),
    `needs_login shows the login card: "${h1}"`,
  );
  await shot(p, "10-needs-login");
  // Refusing Chrome's prompt: a calm note, and the background hears about it.
  await p.evaluate(() => (chrome.permissions.request = async () => false));
  await clickButton(p, "Use my login on files.example.com");
  await p.waitForFunction(() => /No problem/.test(document.body.innerText), { timeout: 5000 });
  const sent = await p.evaluate(() => window.__sent.filter((m) => m.cmd !== "ping"));
  check(
    sent.some((m) => m.cmd === "awaitLogin") && sent.some((m) => m.cmd === "loginAnswer" && m.granted === false),
    `refusing the site permission is calm and reported (${sent.map((m) => m.cmd).join(", ")})`,
  );
  await p.close();

  // Every error code gets its own words and actions; unknown codes get the helper's message.
  const errorCases = [
    ["html_page", /web page, not the file/, ["Use my login on files.example.com", "Open link", "Download normally"]],
    ["link_expired", /link has expired/, ["Open the page"], { pageUrl: "https://files.example.com/downloads" }],
    ["not_found", /gone from the server/, ["Open link"], { error: { http_status: 404 } }],
    ["not_zip", /isn.t a ZIP/, ["Download normally"]],
    ["server_error", /files\.example\.com had a problem/, ["Try again", "Download normally"], { error: { http_status: 503 } }],
    ["network", /Can.t reach files\.example\.com/, ["Try again"]],
    ["disk_full", /Not enough free space/, ["Extract here"], { failedWhile: "extract", error: { message: "needs 2.1 GB, 1.2 GB free on C:" } }],
    ["folder_not_writable", /Can.t write to this folder/, ["Extract here"], { failedWhile: "extract" }],
    ["unsupported_entries", /can.t read these files/, ["Download normally"]],
    ["internal", /hit a bug/, ["Copy details", "Try again"]],
    ["some_future_code", /Couldn.t extract this/, ["Download normally"]],
  ];
  const wrong = [];
  for (const [code, title, wanted, extra] of errorCases) {
    const job = failedJob(code, extra);
    p = await openStubbedPopup(browser, { session: session(job) });
    lastPopup = p;
    await p.waitForSelector(".hero h1");
    const got = await text(p, ".hero h1");
    const labels = await buttonLabels(p);
    const primary = await text(p, "button.btn.primary");
    if (!title.test(got) || wanted.some((w) => !labels.includes(w)) || primary !== wanted[0] || !labels.includes("Copy details")) {
      wrong.push(`${code}: "${got}" [${labels.join(" | ")}]`);
    }
    if (["html_page", "disk_full", "internal"].includes(code)) await shot(p, `11-error-${code}`);
    if (code !== "internal") {
      await p.close();
      continue;
    }
    // Copy details: versions, code, host; never the link's path or query.
    await p.evaluate(() => {
      window.__copied = null;
      [...document.querySelectorAll("button")].find((b) => b.textContent === "Copy details").click();
    });
    await p.waitForFunction(() => window.__copied, { timeout: 5000 });
    const copied = await p.evaluate(() => window.__copied);
    const feedback = await p.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent === "Copied"), { timeout: 3000 }).then(() => true, () => false);
    check(
      /LinkUnzip extension \d/.test(copied) && /Helper: 0\.2\.0/.test(copied) && /Browser: /.test(copied) && /OS: /.test(copied) &&
        /Error: internal/.test(copied) && /Host: files\.example\.com/.test(copied) && !/secret|private/.test(copied) && feedback,
      `Copy details has the versions, code and host, no path or query, and says "Copied" (${copied.replaceAll("\n", " / ")})`,
    );
    await p.close();
  }
  check(wrong.length === 0, `each error code has its own view and actions${wrong.length ? `: ${wrong.join("; ")}` : ` (${errorCases.length} codes)`}`);

  // A URL in the helper's detail text is cut down to its host.
  const leaky = failedJob("network", { error: { detail: "error sending request for url (https://files.example.com/private/data.zip?token=secret): timed out" } });
  p = await openStubbedPopup(browser, { session: session(leaky) });
  await p.waitForSelector(".hero h1");
  await clickButton(p, "Copy details");
  await p.waitForFunction(() => window.__copied, { timeout: 5000 });
  const leakyText = await p.evaluate(() => window.__copied);
  check(!/secret|private/.test(leakyText) && /files\.example\.com\/.../.test(leakyText), `links in the detail text keep only their host (${leakyText.split("\n").pop()})`);
  await p.close();

  // Browse...: only with a helper that has pick_folder; the answer fills the field.
  const ready = readyJob();
  p = await openStubbedPopup(browser, {
    session: session(ready, HOST_INFO_V2),
    replies: { pickFolder: { ok: true, path: "D:\\Picked" } },
  });
  lastPopup = p;
  await p.waitForSelector(".compare");
  await clickButton(p, "Browse...");
  await p.waitForFunction(() => document.querySelector('input[id^="folder-"]').value === "D:\\Picked", { timeout: 5000 });
  const pick = await p.evaluate(() => window.__sent.find((m) => m.cmd === "pickFolder"));
  check(
    pick?.field === "output" && pick.jobId === "j-ready" && pick.start === ready.output,
    `Browse... asks the helper for a folder and fills in the answer (${JSON.stringify(pick)})`,
  );
  await shot(p, "12-ready-browse");
  await p.click("#settings-btn");
  const baseBrowse = await p.$eval("#set-base-browse", (b) => !b.hidden);
  check(baseBrowse, "the settings base folder has Browse... too");
  await p.close();

  // Reopened by the background after picking the base folder: the settings are open again.
  p = await openStubbedPopup(browser, { session: { ...session(ready, HOST_INFO_V2), reopen: "settings" } });
  await p.waitForSelector(".compare");
  check(await p.$eval("#settings", (s) => !s.hidden), "the popup reopens on the settings after a base folder was picked");
  await p.close();

  await chooseFiles(browser, session);

  // Resume: a stopped job, and a failed extraction (instead of "Try again").
  const lastExtract = { output: "C:\\Users\\me\\Downloads\\LinkUnzip\\big", include: [], connections: 4, stream: false };
  const stopped = {
    ...readyJob(),
    id: "j-stopped",
    phase: "cancelled",
    result: { type: "cancelled", output: lastExtract.output, files_done: 7, extracted_bytes: 123456 },
    lastExtract: { id: "j-stopped", ...lastExtract },
  };
  p = await openStubbedPopup(browser, { session: session(stopped, HOST_INFO_V2) });
  await p.waitForSelector(".hero h1");
  const stoppedPrimary = await text(p, "button.btn.primary");
  await clickButton(p, "Resume");
  const resumeSent = await p.evaluate(() => window.__sent.find((m) => m.cmd === "resume"));
  await shot(p, "16-stopped-resume");
  await p.close();
  const broken = failedJob("network", { failedWhile: "extract", lastExtract: { id: "j-network", ...lastExtract } });
  p = await openStubbedPopup(browser, { session: session(broken, HOST_INFO_V2) });
  await p.waitForSelector(".hero h1");
  const brokenLabels = await buttonLabels(p);
  const brokenPrimary = await text(p, "button.btn.primary");
  await p.close();
  check(
    stoppedPrimary === "Resume" && resumeSent?.id === "j-stopped" && brokenPrimary === "Resume" && !brokenLabels.includes("Try again"),
    `Resume on a stopped job and on a failed extraction (${brokenLabels.join(" | ")})`,
  );

  // The done view: verified files, files skipped because they were already there, the index.
  const MB = 1024 ** 2;
  const finished = {
    ...readyJob(),
    id: "j-done",
    phase: "done",
    result: {
      type: "done", output: lastExtract.output, files: 24, dirs: 3, extracted_bytes: 1229 * MB, downloaded_bytes: 712 * MB,
      archive_size: 910 * MB, normal_needs: 2139 * MB, elapsed_ms: 42000, retries: 0, requests: 31, zip_bytes_on_disk: 0,
      renamed: 0, stream: false, verified_files: 24, skipped_existing: 3, skipped_bytes: 120 * MB, index_bytes: 12.5 * MB,
    },
  };
  p = await openStubbedPopup(browser, { session: session(finished, HOST_INFO_V2) });
  await p.waitForSelector(".zero-line");
  const doneText = await p.evaluate(() => document.getElementById("view").innerText);
  check(
    /✓ All 24 files verified/.test(doneText) && /Skipped 3 files already in the folder/.test(doneText) && /of which the zip's index\s+12\.5 MB/.test(doneText),
    "the done view says all files were verified, which were skipped, and how much was the index",
  );
  await shot(p, "17-done-verified");
  await p.close();

  // A protocol-1 helper: no Browse... anywhere, the update card instead ("Later" puts it away).
  p = await openStubbedPopup(browser, { session: session(failedJob("no_range"), HOST_INFO_V1) });
  await p.waitForSelector(".hero h1");
  const v1Browse = await p.$$eval("button.browse", (bs) => bs.filter((b) => !b.hidden).length);
  check(v1Browse === 0 && (await p.$('input[id^="folder-"]')), "no Browse... with a protocol-1 helper (folder field still there)");
  const v1Card = Boolean(await p.$(".card.update"));
  await shot(p, "18-update-card");
  await clickButton(p, "Later");
  const gone = !(await p.$(".card.update"));
  await p.evaluate(() => chrome.storage.session.remove("updateLater"));
  await p.close();
  p = await openStubbedPopup(browser, { session: { ...session(failedJob("no_range"), HOST_INFO_V1), updateLater: true } });
  await p.waitForSelector(".hero h1");
  const stillLater = !(await p.$(".card.update"));
  await p.close();
  p = await openStubbedPopup(browser, { session: session(failedJob("no_range"), HOST_INFO_V2) });
  await p.waitForSelector(".hero h1");
  const v2Card = Boolean(await p.$(".card.update"));
  await p.close();
  check(
    v1Card && gone && stillLater && !v2Card,
    `the update card shows for a protocol-1 helper only, and Later puts it away for the session (${[v1Card, gone, stillLater, !v2Card]})`,
  );

  await themeSwitch(browser, session);
  await themes(browser, session);
}

/** Light / dark: the header button picks the other one, Settings can go back to following Windows. */
async function themeSwitch(browser, session) {
  const p = await openStubbedPopup(browser, { session: { jobs: {}, current: null, hostInfo: HOST_INFO_V2, hostError: null }, scheme: "light" });
  await p.waitForSelector("#view > *");
  const state = () =>
    p.evaluate(async () => ({
      attr: document.documentElement.dataset.theme || "system",
      kept: localStorage.getItem("linkunzip-theme"),
      saved: (await chrome.storage.local.get("settings")).settings?.theme,
      bg: getComputedStyle(document.body).backgroundColor,
      icon: document.querySelector("#theme-btn svg:not([hidden])")?.getAttribute("class"),
    }));
  const before = await state();
  await p.click("#theme-btn");
  const dark = await state();
  await p.click("#settings-btn");
  await p.evaluate(() => document.querySelector('#set-theme input[value="system"]').click());
  const system = await state();
  await p.close();
  check(
    before.attr === "system" && dark.attr === "dark" && dark.kept === "dark" && dark.saved === "dark" && dark.bg !== before.bg &&
      before.icon === "moon" && dark.icon === "sun" &&
      system.attr === "system" && system.kept === null && system.saved === "system" && system.bg === before.bg,
    `the theme button switches to dark and remembers it; Match Windows goes back (${before.bg} -> ${dark.bg} -> ${system.bg})`,
  );
}

const rowNames = (page) => page.$$eval(".fl-row .fl-name", (els) => els.map((e) => e.textContent));
const flText = (page, sel) => page.$eval(sel, (el) => el.textContent).catch(() => "");

/** Tick or untick the file-list row named `name` (folders end in "/"). */
const clickRow = (page, name) =>
  page.evaluate((n) => {
    const row = [...document.querySelectorAll(".fl-row")].find((r) => r.querySelector(".fl-name").textContent === n);
    row.querySelector("input").click();
  }, name);

const openFolderRow = (page, name) =>
  page.evaluate((n) => [...document.querySelectorAll("button.fl-name.dir")].find((b) => b.textContent === n).click(), name);

const waitFor = (page, fn, arg) =>
  page.waitForFunction(fn, { timeout: 8000 }, arg).catch((e) => {
    throw new Error(`${e.message} waiting for ${arg === undefined ? fn : JSON.stringify(arg)}`);
  });
const waitTotals = (page, prefix) => waitFor(page, (p) => (document.querySelector(".fl-totals")?.textContent || "").startsWith(p), prefix);
const waitCrumbs = (page, last) => waitFor(page, (l) => [...document.querySelectorAll(".fl-crumbs > *")].pop()?.textContent === l, last);

/** Choose files: browse, tick, the selection the helper gets, keyboard, paging, search. */
async function chooseFiles(browser, session) {
  const sizes = ARCHIVE.map(([, a, b]) => (b === undefined ? a : a * b));
  const extracted = sizes.reduce((x, y) => x + y, 0);
  const job = readyJob({ files: 118296, dirs: 5, extracted, compressed: Math.round(extracted * 0.9) });
  const p = await openStubbedPopup(browser, { session: session(job, HOST_INFO_V2), archive: ARCHIVE });
  lastPopup = p;
  await p.waitForSelector(".fl-row");
  const root = await rowNames(p);
  const summary = await flText(p, ".fl-sum");
  check(
    summary === "All files" && root.join(" ") === "docs/ labels/ train/ LICENSE README.md",
    `the file list shows "All files" ticked, folders first (${root.join(" ")})`,
  );

  // Untick two folders, then keep one file of one of them: the totals follow each step.
  await clickRow(p, "train/");
  await waitTotals(p, "9 files");
  await clickRow(p, "docs/");
  await waitTotals(p, "5 files");
  await openFolderRow(p, "docs/");
  await waitCrumbs(p, "docs");
  await clickRow(p, "readme.txt");
  await waitTotals(p, "6 files");
  check(true, `unticking folders and ticking one file inside one of them: ${await flText(p, ".fl-totals")}`);

  // Keyboard: Space ticks, Enter opens a folder, Backspace goes up, arrows move.
  await p.focus(".fl-row input");
  await p.keyboard.press("Space");
  await waitTotals(p, "8 files");
  await p.keyboard.press("Enter");
  await waitCrumbs(p, "api");
  const apiRows = await rowNames(p);
  const apiTicked = await p.$$eval(".fl-row input", (cbs) => cbs.every((c) => c.checked));
  await p.keyboard.press("Backspace");
  await waitCrumbs(p, "docs");
  await p.keyboard.press("ArrowDown");
  const focused = await p.evaluate(() => document.activeElement.getAttribute("aria-label"));
  check(
    apiRows.join(" ") === "index.html style.css" && apiTicked && /^guide\.pdf/.test(focused || ""),
    `keyboard: Space ticks, Enter opens, Backspace goes up, arrows move (focus on "${focused}")`,
  );

  // Back at the top, docs/ is partly ticked.
  await p.evaluate(() => document.querySelector(".fl-crumbs button").click());
  await waitCrumbs(p, "All files");
  const docsMixed = await p.evaluate(
    () => [...document.querySelectorAll(".fl-row")].find((r) => r.querySelector(".fl-name").textContent === "docs/").querySelector("input").indeterminate,
  );
  check(docsMixed, "a partly ticked folder shows a mixed checkbox");
  await shot(p, "13-choose-files");

  // A folder with 118,287 files: a page at a time, never more than 2,000 rows on the page.
  const t0 = Date.now();
  await openFolderRow(p, "train/");
  await waitCrumbs(p, "train");
  const firstPage = await p.$$eval(".fl-row", (r) => r.length);
  const openMs = Date.now() - t0;
  await clickRow(p, "img000000.jpg");
  await waitFor(p, () => !document.querySelector(".fl .notice").hidden);
  const stillTicked = await p.$eval(".fl-row input", (c) => c.checked);
  for (let i = 0; i < 4; i++) {
    const before = await flText(p, ".fl-count");
    await clickButton(p, "Show more");
    await waitFor(p, (b) => document.querySelector(".fl-count").textContent !== b, before);
  }
  const windowRows = await p.$$eval(".fl-row", (r) => r.length);
  const countText = await flText(p, ".fl-count");
  await shot(p, "14-choose-big-folder");
  // Again, now that the fake helper has its sorted listing: this is the popup's own time.
  await p.evaluate(() => document.querySelector(".fl-crumbs button").click());
  await waitCrumbs(p, "All files");
  const t1 = Date.now();
  await openFolderRow(p, "train/");
  await waitCrumbs(p, "train");
  const againMs = Date.now() - t1;
  check(
    firstPage === 500 && windowRows === 2000 && /showing 501-2,500/.test(countText) && !stillTicked && againMs < 1000,
    `big folder: 500 rows (${openMs} ms first, ${againMs} ms again), ${windowRows} rows after 4× Show more (${countText}); a file inside the unticked 118k folder is refused with a hint`,
  );

  // Search covers the whole zip.
  await p.type("input[type=search]", "readme");
  await waitFor(p, () => /match/.test(document.querySelector(".fl-count").textContent));
  const hits = await rowNames(p);
  const hitCount = await flText(p, ".fl-count");
  check(hits.join(" ") === "readme.txt README.md" && hitCount === "2 matches", `search finds ${hits.join(", ")} (${hitCount})`);
  await shot(p, "15-choose-search");

  // Extract sends the selection in the protocol's terms.
  await p.click("#extract-btn"); // its label says how many: "Start Filtered Extraction (6 files, 5.8 KB)"
  const ex = await p.evaluate(() => window.__sent.find((m) => m.cmd === "extract"));
  check(
    ex?.select?.paths?.length === 0 && [...ex.select.exclude].sort().join(" ") === "docs/guide.pdf train/",
    `Extract sends select ${JSON.stringify(ex?.select)}`,
  );

  // Select none / all for the whole zip.
  await p.$eval("input[type=search]", (el) => {
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await waitCrumbs(p, "train");
  await p.evaluate(() => document.querySelector(".fl-crumbs button").click());
  await waitCrumbs(p, "All files");
  await clickButton(p, "Select none");
  await waitTotals(p, "No files");
  const noneDisabled = await p.evaluate(() => document.getElementById("extract-btn").disabled);
  await clickButton(p, "Select all");
  await waitTotals(p, "118,296 files");
  const allSummary = await flText(p, ".fl-sum");
  check(noneDisabled && allSummary === "All files", `Select none disables Extract; Select all is back to "${allSummary}"`);
  await p.close();
}

/**
 * WCAG AA for every visible piece of text on the page: its colour against the backgrounds behind
 * it (composited, so translucent tints count). Large text (24px, or 18.66px bold) needs 3:1, the
 * rest 4.5:1. Decorative (aria-hidden), disabled and screen-reader-only text is skipped.
 */
const contrastProblems = (page) =>
  page.evaluate(() => {
    const parse = (c) => {
      const m = /rgba?\(([^)]+)\)/.exec(c || "");
      if (!m) return null;
      const [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return { r, g, b, a };
    };
    const over = (top, under) => ({
      r: top.r * top.a + under.r * (1 - top.a),
      g: top.g * top.a + under.g * (1 - top.a),
      b: top.b * top.a + under.b * (1 - top.a),
      a: 1,
    });
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el) => {
      const chain = [];
      for (let e = el; e; e = e.parentElement) chain.unshift(e);
      let c = { r: 255, g: 255, b: 255, a: 1 };
      for (const e of chain) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg && bg.a > 0) c = over(bg, c);
      }
      return c;
    };
    const problems = [];
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!node.textContent.trim() || seen.has(el)) continue;
      seen.add(el);
      if (!el.getClientRects().length || el.closest("[hidden], .sr-only, [aria-hidden='true'], :disabled")) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden") continue;
      const bg = backdrop(el);
      const fg = over(parse(cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize);
      const need = size >= 24 || (parseInt(cs.fontWeight, 10) >= 700 && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) problems.push(`"${node.textContent.trim().slice(0, 24)}" ${ratio.toFixed(2)}:1`);
    }
    return problems;
  });

const overflowX = (page) =>
  page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - document.documentElement.clientWidth);

/** Every view in light and dark at the popup's 400 px: no sideways scrolling, text contrast AA. */
async function themes(browser, session) {
  const dir = path.join(SHOTS, "themes");
  fs.mkdirSync(dir, { recursive: true });
  const GB = 1024 ** 3;
  const longName = `${"really-long-archive-name-without-any-spaces-".repeat(3)}v2.zip`;
  const progress = {
    type: "progress", downloaded: 0.31 * GB, total_compressed: 0.88 * GB, extracted: 0.42 * GB, total_extracted: 1.2 * GB,
    files_done: 9, total_files: 24, rate: 48 * 1024 ** 2, eta_secs: 12, active: ["logs/app/server-0012.log"], active_count: 3,
    retries: 0, requests: 14, zip_on_disk: 0, free: 40 * GB, elapsed_ms: 6400,
  };
  const ready = readyJob({ files: 118296, dirs: 5 });
  const views = [
    ["pick", { jobs: {}, current: null, hostInfo: HOST_INFO_V1, hostError: null }],
    ["settings", { jobs: {}, current: null, hostInfo: HOST_INFO_V2, hostError: null }, (p) => p.click("#settings-btn")],
    ["inspecting", session({ ...readyJob(), phase: "inspecting", report: null }, HOST_INFO_V2)],
    ["ready", { ...session(ready, HOST_INFO_V2), drafts: { [ready.id]: { listOpen: true } } }, (p) => p.waitForSelector(".fl-row")],
    ["ready-long-name", session({ ...readyJob({ unsupported: 2, unsupported_sample: [{ name: longName, reason: "encrypted" }] }), name: longName, output: `D:\\${longName}\\${longName}` }, HOST_INFO_V1)],
    ["ready-pattern", { ...session(ready, HOST_INFO_V2), drafts: { [ready.id]: { include: "*.dll" } } }, (p) => p.waitForSelector(".fl-row")],
    ["extracting", session({ ...readyJob(), phase: "extracting", progress }, HOST_INFO_V2)],
    // Resumed: 12 files were already there, so the bar starts past them, not at 0 %.
    ["extracting-resumed", session({ ...readyJob(), phase: "extracting", progress: { ...progress, downloaded: 0.2 * GB, total_compressed: 0.48 * GB, files_done: 3, total_files: 12, skipped_files: 12, skipped_compressed: 0.4 * GB, skipped_extracted: 0.55 * GB } }, HOST_INFO_V2)],
    ["done", session({ ...readyJob(), phase: "done", lastExtract: {}, result: { type: "done", output: "C:\\Users\\me\\Downloads\\LinkUnzip\\big", files: 24, dirs: 3, extracted_bytes: 1.2 * GB, downloaded_bytes: 0.7 * GB, archive_size: 0.9 * GB, normal_needs: 2.1 * GB, elapsed_ms: 42000, retries: 1, requests: 31, zip_bytes_on_disk: 0, renamed: 2, stream: false, verified_files: 24, skipped_existing: 3, skipped_bytes: 0.1 * GB, index_bytes: 12.5 * 1024 ** 2 } }, HOST_INFO_V2)],
    ["stopped", session({ ...readyJob(), phase: "cancelled", lastExtract: {}, result: { output: "C:\\x", files_done: 7 } }, HOST_INFO_V2)],
    ["error-login", session(failedJob("needs_login"), HOST_INFO_V1)],
    ["error-no-range", session(failedJob("no_range"), HOST_INFO_V2)],
    ["error-disk-full", session(failedJob("disk_full", { failedWhile: "extract", lastExtract: {}, error: { message: "LinkUnzip needs 2.1 GB on C: but only 1.2 GB is free." } }), HOST_INFO_V2)],
  ];
  const bad = [];
  let count = 0;
  // The checker itself: it must catch grey on grey.
  const probe = await openStubbedPopup(browser, { session: views[0][1] });
  await probe.waitForSelector("#view > *");
  await probe.evaluate(() => {
    const p = document.createElement("p");
    p.style.cssText = "color:#777;background:#999";
    p.textContent = "planted low contrast";
    document.getElementById("view").append(p);
  });
  const caught = (await contrastProblems(probe)).some((x) => x.includes("planted low contrast"));
  await probe.close();
  check(caught, "the contrast check catches a planted 1.3:1 line");
  for (const scheme of ["dark", "light"]) {
    for (const [name, state, prepare] of views) {
      const p = await openStubbedPopup(browser, { session: state, archive: name.startsWith("ready") ? ARCHIVE : null, scheme });
      lastPopup = p;
      await p.waitForSelector("#view > *");
      if (prepare) await prepare(p);
      await sleep(150);
      const wide = await overflowX(p);
      const low = await contrastProblems(p);
      if (wide > 0) bad.push(`${name}/${scheme}: ${wide}px too wide`);
      if (low.length) bad.push(`${name}/${scheme}: ${low.join(", ")}`);
      // Exactly what the toolbar popup shows: Chrome makes the popup as tall as the page, up to
      // 600 px, and the page scrolls inside it (the action bar stays pinned to its bottom).
      await p.setViewport({ width: 400, height: 100, deviceScaleFactor: 2 }); // the page's own height, not the window's
      const tall = await p.evaluate(() => document.documentElement.scrollHeight);
      await p.setViewport({ width: 400, height: Math.min(600, tall), deviceScaleFactor: 2 });
      await sleep(100);
      await p.screenshot({ path: path.join(dir, `${name}-${scheme}.png`) });
      count += 1;
      await p.close();
    }
    for (const mode of ["", "?update=1"]) {
      const w = await browser.newPage();
      await w.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await w.setViewport({ width: 900, height: 900 });
      await w.goto(`chrome-extension://${EXT_ID}/welcome.html${mode}`);
      await w.waitForSelector('#step-helper:not([data-state="checking"])', { timeout: 15000 });
      const low = await contrastProblems(w);
      if (low.length) bad.push(`welcome${mode}/${scheme}: ${low.join(", ")}`);
      await w.screenshot({ path: path.join(dir, `welcome${mode ? "-update" : ""}-${scheme}.png`), fullPage: true });
      count += 1;
      await w.close();
    }
  }
  check(bad.length === 0, `${count} views in light and dark: no sideways scrolling at 400 px, text contrast AA${bad.length ? `: ${bad.join("; ")}` : ""} (screenshots in ${dir})`);
}

async function dumpFailure() {
  try {
    if (!lastPopup) return;
    await lastPopup.screenshot({ path: path.join(SHOTS, "failure.png") });
    console.error("popup text:", (await lastPopup.evaluate(() => document.body.innerText)).replaceAll("\n", " | "));
    const sw = await lastWorker.worker();
    console.error("jobs:", JSON.stringify(await sw.evaluate(() => chrome.storage.session.get("jobs"))).slice(0, 1800));
  } catch (e) {
    console.error("(could not collect diagnostics:", e.message, ")");
  }
}

function listFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

try {
  await run();
} catch (e) {
  console.error("ERROR", e.message);
  failures += 1;
} finally {
  for (const s of servers) s.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
