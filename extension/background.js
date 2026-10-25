// LinkUnzip background worker.
//
// It keeps the state of every job in chrome.storage.session so the popup can redraw it at any
// time, reacts to the right-click menu and (optionally) to .zip downloads, and hands the work to
// an engine:
//
// * the browser engine (engine/, run by offscreen.html, a hidden page that keeps working when the
//   popup closes): reads the index, extracts, checks every file, and writes it into the chosen
//   folder, or hands it to Chrome's own downloads (saved below) for Downloads;
// * the Windows helper, if it is installed: only for servers that can't send parts of a file
//   (stream mode) and to open a folder in Explorer.
//
// Both answer the same messages (see src/host.rs and engine/engine.js).

import { REVIEW_URL, UNINSTALL_URL, rateCheck } from "./config.js";
import { folderLabel, getFolder, removeFolder } from "./folder.js";
import { fileNameFromUrl, folderNameFor, humanBytes, joinPath, sitePattern } from "./fmt.js";
import { loadSettings, migrate } from "./settings.js";
import { indexCache, savedCount } from "./store.js";

const HOST = "com.linkunzip.host";
const MENU_ID = "linkunzip-extract-link";

let port = null; // the native helper, when it is installed
let hostInfo = null; // its reply to `hello`
let hostError = null; // why it cannot be reached
let helloWaiters = [];
let enginePort = null; // the offscreen page's engine
let engineInfo = null;
let engineWaiters = [];
const jobs = new Map(); // job id -> job
const bypass = new Map(); // url -> expiry: downloads we started ourselves ("download normally")
let currentId = null; // the job the popup shows

const ready = restore();

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

async function restore() {
  const { jobs: saved = {}, hostInfo: savedInfo = null, current = null } = await chrome.storage.session.get(["jobs", "hostInfo", "current"]);
  currentId = current;
  const restartedAt = Date.now();
  for (const [id, job] of Object.entries(saved)) {
    // The helper's process ends with this worker, so its jobs are lost. The browser engine's
    // page outlives the worker and reconnects with the job still running: give it a moment.
    if ((job.phase === "inspecting" || job.phase === "extracting") && job.via === "helper") {
      job.failedWhile = job.phase === "extracting" ? "extract" : "inspect";
      job.phase = "error";
      job.error = { code: "host", message: "LinkUnzip was interrupted." };
    }
    jobs.set(id, job);
  }
  hostInfo = savedInfo;
  // Engine jobs that were running before the restart and haven't been heard of since really were
  // lost. (Jobs started after the restart can be quiet for longer: reading a big index sends
  // nothing until it's done.)
  setTimeout(() => {
    for (const job of jobs.values()) {
      if (running(job) && job.via !== "helper" && !(job.startedAt > restartedAt) && !(job.seenAt > restartedAt)) {
        fail(job, { code: "host", message: "LinkUnzip was interrupted." });
      }
    }
    persist();
    // Chrome keeps its download bubble hidden for as long as an extension asked, also across a
    // restart of this worker: show it again unless a job still saves into Downloads.
    if (!savingIntoDownloads()) chrome.downloads.setUiOptions({ enabled: true }).catch(() => {});
  }, ORPHAN_WAIT_MS);
}

/** How long a running engine job may stay silent after the worker restarted. */
const ORPHAN_WAIT_MS = 10_000;

// The popup redraws from storage.session. A job that moved on is written soon; while only its
// numbers change (progress), not more than about once a second: each write is the whole map.
const PERSIST_MS = 150;
const PROGRESS_PERSIST_MS = 750;
let persistTimer = null;
let persistDue = 0;
function persist(soon = true) {
  const wait = soon ? PERSIST_MS : PROGRESS_PERSIST_MS;
  if (persistTimer && persistDue <= Date.now() + wait) return;
  clearTimeout(persistTimer);
  persistDue = Date.now() + wait;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    prune();
    await chrome.storage.session.set({ jobs: Object.fromEntries(jobs), hostInfo, hostError, engineInfo });
  }, wait);
}

// Finished jobs stay until closed, but not forever: the newest KEEP_JOBS that aren't running, none
// idle for longer than a day (the one on screen always stays).
const KEEP_JOBS = 10;
const JOB_MAX_IDLE_MS = 24 * 60 * 60 * 1000;
const lastActive = (job) => Math.max(job.seenAt || 0, job.startedAt || 0, job.createdAt || 0);

function prune() {
  const idle = [...jobs.values()].filter((j) => !running(j) && j.id !== currentId).sort((a, b) => lastActive(b) - lastActive(a));
  idle.forEach((job, i) => {
    if (i >= KEEP_JOBS || Date.now() - lastActive(job) > JOB_MAX_IDLE_MS) forget(job.id);
  });
}

/** A job and what belongs to it alone: a folder picked just for it. */
function forget(id) {
  jobs.delete(id);
  removeFolder(`job:${id}`);
}

const getSettings = loadSettings;

async function setCurrent(id) {
  currentId = id;
  await chrome.storage.session.set({ current: id });
}

const running = (job) => job.phase === "inspecting" || job.phase === "extracting";

// ---------------------------------------------------------------------------------------
// The browser engine (offscreen page)
// ---------------------------------------------------------------------------------------

// The offscreen page connects (and connects again whenever this worker was stopped while it had
// a job running). It counts as ready once it has answered hello.
chrome.runtime.onConnect.addListener((p) => {
  if (p.name !== "engine") return;
  enginePort = p;
  engineInfo = null;
  p.onMessage.addListener(onEngineMessage);
  p.onDisconnect.addListener(() => {
    if (enginePort !== p) return; // an older connection, already replaced
    enginePort = null;
    engineInfo = null;
    const error = { code: "host", message: "LinkUnzip's engine stopped (the browser closed it). Try again." };
    for (const job of jobs.values()) if (running(job) && job.via !== "helper") fail(job, error);
    for (const w of [...waiters]) if (w.via === "engine") w.finish({ type: "error", ...error });
    persist();
  });
  p.postMessage({ type: "hello" });
});

const engineReady = () => Boolean(enginePort && engineInfo);
/** How long a leftover offscreen page gets to connect before it is replaced. */
const RECONNECT_WAIT_MS = 1500;
let starting = null;

/** Make sure the engine runs and has said hello. Calls at the same time share one start. */
function ensureEngine() {
  if (engineReady()) return Promise.resolve(true);
  starting ??= startEngine().finally(() => (starting = null));
  return starting;
}

async function startEngine() {
  if (!enginePort) {
    // Chrome stops this worker after a while without events; the offscreen page outlives it but
    // loses its connection. One with a job running connects again right away; an idle one stays
    // quiet, so after a moment start it afresh (the next question about a zip then reads its
    // index again, see askAboutJob).
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }).catch(() => []);
    if (contexts.length) {
      await new Promise((resolve) => {
        engineWaiters.push(resolve);
        setTimeout(resolve, RECONNECT_WAIT_MS);
      });
      if (engineReady()) return true;
      if (!enginePort) await chrome.offscreen.closeDocument().catch(() => {});
    }
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Runs the extraction (download, decompress, check and write into the folder the user chose) so it keeps going when the popup closes.",
      });
    } catch (e) {
      if (!/single offscreen/i.test(String(e?.message))) throw e;
    }
  }
  if (!engineReady()) {
    await new Promise((resolve) => {
      engineWaiters.push(resolve);
      setTimeout(resolve, 5000);
    });
  }
  return engineReady();
}

async function toEngine(message) {
  if (!(await ensureEngine().catch(() => false))) return false;
  enginePort.postMessage(message);
  scheduleEngineClose();
  return true;
}

// The offscreen page holds the indexes of the zips being looked at. Close it a while after the
// last job: the next one simply reads the index again (askAboutJob).
const ENGINE_IDLE_MS = 120_000;
let engineTimer = null;
function scheduleEngineClose() {
  clearTimeout(engineTimer);
  engineTimer = setTimeout(async () => {
    if ([...jobs.values()].some((j) => running(j) && j.via !== "helper") || [...waiters].some((w) => w.via === "engine")) {
      return scheduleEngineClose();
    }
    enginePort = null;
    await chrome.offscreen.closeDocument().catch(() => {});
  }, ENGINE_IDLE_MS);
}

function onEngineMessage(msg) {
  scheduleEngineClose();
  if (msg.type === "hello") {
    engineInfo = { ...msg, version: chrome.runtime.getManifest().version };
    for (const w of engineWaiters) w();
    engineWaiters = [];
    persist();
    return;
  }
  onReply(msg);
}

// ---------------------------------------------------------------------------------------
// The Windows helper (optional)
// ---------------------------------------------------------------------------------------

function friendlyHostError(raw) {
  const text = raw || "";
  if (/not found/i.test(text)) {
    return { code: "host_missing", message: "The LinkUnzip helper isn't installed on this PC.", detail: text };
  }
  if (/forbidden/i.test(text)) {
    return { code: "host_forbidden", message: "The LinkUnzip helper on this PC doesn't accept this copy of the extension. Install the helper again.", detail: text };
  }
  return { code: "host", message: text || "The connection to the LinkUnzip helper was lost.", detail: text };
}

function connect() {
  if (port) return port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch (e) {
    hostError = friendlyHostError(String(e));
    return null;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const raw = chrome.runtime.lastError?.message;
    port = null;
    hostInfo = null;
    hostError = friendlyHostError(raw);
    for (const job of jobs.values()) if (running(job) && job.via === "helper") fail(job, hostError);
    for (const w of helloWaiters) w();
    helloWaiters = [];
    for (const w of [...waiters]) if (w.via === "helper") w.finish({ type: "error", ...hostError });
    persist();
  });
  port.postMessage({ type: "hello" });
  scheduleIdleClose();
  return port;
}

function sendToHost(message) {
  const p = connect();
  if (!p) return false;
  try {
    p.postMessage(message);
    scheduleIdleClose();
    return true;
  } catch {
    return false;
  }
}

// An open native port keeps the helper process alive, so close it once nothing has happened for
// a while: the helper then only runs while it is being used.
const IDLE_CLOSE_MS = 30_000;
let idleTimer = null;

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const busy = [...jobs.values()].some((j) => running(j) && j.via === "helper") || [...waiters].some((w) => w.via === "helper");
    if (!port || busy) return;
    port.disconnect();
    port = null;
  }, IDLE_CLOSE_MS);
}

/** Is the helper there? Resolves with its hello or null (quietly: it is optional). */
async function ensureHost() {
  await ready;
  if (hostInfo && port) return hostInfo;
  if (!connect()) return null;
  await new Promise((resolve) => {
    helloWaiters.push(resolve);
    setTimeout(resolve, 2500);
  });
  return hostInfo;
}

function onHostMessage(msg) {
  scheduleIdleClose();
  if (msg.type === "hello") {
    hostInfo = msg;
    hostError = null;
    for (const w of helloWaiters) w();
    helloWaiters = [];
    persist();
    return;
  }
  onReply(msg);
}

// ---------------------------------------------------------------------------------------
// Replies (from either engine)
// ---------------------------------------------------------------------------------------

// Requests answered by one particular reply (list, search, measure, entry): each waits for the
// first message its `match` accepts, or gives up after `timeoutMs` (0 = never).
const waiters = new Set();

function ask(message, match, timeoutMs = 20_000, via = "engine") {
  return new Promise((resolve) => {
    const w = { match, timer: null, via };
    w.finish = (reply) => {
      clearTimeout(w.timer);
      waiters.delete(w);
      resolve(reply);
    };
    if (timeoutMs) {
      w.timer = setTimeout(() => w.finish({ type: "error", code: "timeout", message: "LinkUnzip didn't answer in time." }), timeoutMs);
    }
    waiters.add(w);
    const sent = via === "helper" ? Promise.resolve(sendToHost(message)) : toEngine(message);
    sent.then((ok) => {
      if (!ok) w.finish({ type: "error", ...(via === "helper" ? hostError || friendlyHostError("") : { code: "host", message: "LinkUnzip's engine didn't start." }) });
    });
  });
}

/**
 * Ask about a job's archive. The engine keeps the index only while it runs: after an idle close
 * it answers `unknown_job`, so read the index again (quietly, the job stays as it is) and repeat.
 */
async function askAboutJob(job, message, accepts) {
  const match = (m) => m.id === job.id && (m.type === "error" || accepts(m));
  let reply = await ask(message, match);
  if (reply.type === "error" && reply.code === "unknown_job") {
    const again = await ask(
      { type: "inspect", id: job.id, url: job.url, credentials: await credentialsFor(job) },
      (m) => m.id === job.id && (m.type === "inspected" || m.type === "error"),
      120_000,
    );
    if (again.type !== "inspected") return again;
    reply = await ask(message, match);
  }
  return reply;
}

function onReply(msg) {
  for (const w of waiters) {
    if (w.match(msg)) return w.finish(msg);
  }
  const jobId = typeof msg.id === "string" ? msg.id.split(":")[0] : null;
  const job = jobId ? jobs.get(jobId) : null;
  if (!job) return;
  job.seenAt = Date.now();
  // Only ever an answer to a question about the archive; never something to show.
  if (msg.type === "error" && msg.code === "unknown_job") return;
  // A quiet second read of the index (askAboutJob) must not move the job back.
  if (msg.type === "inspected" && job.phase !== "inspecting") return;

  switch (msg.type) {
    case "index_progress":
      if (job.phase !== "inspecting") return;
      job.indexProgress = { received: msg.received, total: msg.total };
      return persist(false);
    case "inspected":
      job.phase = "ready";
      job.report = msg.report;
      job.indexProgress = null;
      countEarlier(job);
      break;
    case "started":
      job.phase = "extracting";
      job.output = msg.output;
      break;
    case "progress":
      job.phase = job.phase === "extracting" || job.phase === "ready" ? "extracting" : job.phase;
      job.progress = msg;
      updateBadge(job);
      if (job.phase === "extracting") {
        syncDownloadUi();
        return persist(false);
      }
      break;
    case "done":
      job.phase = "done";
      job.result = msg;
      job.earlier = 0;
      finishBadge("✓", "#2f9e6f");
      notifyDone(job);
      countForRating(job);
      dropCaughtDownload(job);
      break;
    case "cancelled":
      job.phase = "cancelled";
      job.result = msg;
      finishBadge("", "#000000");
      break;
    case "error":
      fail(job, { code: msg.code || "failed", message: msg.message, detail: msg.detail, http_status: msg.http_status, host: msg.host });
      // A link that redirects to another site fails like a network error when LinkUnzip may only
      // read the first site: the popup then also offers access to every site.
      if ((msg.code === "network" || msg.code === "redirect_access") && job.via !== "helper") {
        chrome.permissions.contains({ origins: ["<all_urls>"] }).then((all) => {
          job.allSites = all;
          persist();
        });
      }
      break;
  }
  syncDownloadUi();
  persist();
}

/**
 * Files an earlier, unfinished extraction of this same archive already saved into Downloads
 * (store.js; the engine's Downloads sink keeps that record per archive version and zip folder).
 */
async function countEarlier(job) {
  const r = job.report;
  const etag = r?.etag && !/^\s*W\//.test(r.etag) ? r.etag.trim() : "";
  const lm = r?.last_modified || "";
  if (!r || (!etag && !lm)) return;
  const run = [r.url, r.archive_size, etag, lm, folderNameFor(job.name)].join("\n");
  const n = await savedCount(run).catch(() => 0);
  if (n !== (job.earlier || 0)) {
    job.earlier = n;
    persist();
  }
}

/**
 * A .zip download LinkUnzip caught was paused, not cancelled (a link may only work once). Once
 * the files are out, it goes; a download that had already finished stays where it is.
 */
async function dropCaughtDownload(job) {
  const id = job.caught?.downloadId;
  if (id == null) return;
  const [item] = await chrome.downloads.search({ id }).catch(() => []);
  if (item?.state === "in_progress") {
    await chrome.downloads.cancel(id).catch(() => {});
    await chrome.downloads.erase({ id }).catch(() => {});
  }
  job.caught = null;
  persist();
}

// One question, ever: after the third extraction where every file checked out, that job's Done
// screen asks for a store rating (rateCheck in config.js).
async function countForRating(job) {
  const { rate } = await chrome.storage.local.get("rate");
  const next = rateCheck(rate, job.result);
  await chrome.storage.local.set({ rate: next.rate });
  if (next.ask) {
    job.askRate = true;
    persist();
  }
}

function fail(job, error) {
  // Whether it failed while reading the index or while extracting decides what "try again" means.
  job.failedWhile = job.phase === "extracting" ? "extract" : "inspect";
  job.phase = "error";
  job.error = error;
  finishBadge("!", "#d1495b");
}

// ---------------------------------------------------------------------------------------
// Badge and notifications
// ---------------------------------------------------------------------------------------

let badgeTimer = null;

function updateBadge(job) {
  const p = job.progress;
  if (!p || !p.total_compressed) return;
  const pct = Math.min(99, Math.floor((p.downloaded / p.total_compressed) * 100));
  chrome.action.setBadgeBackgroundColor({ color: "#2a9d9a" });
  chrome.action.setBadgeText({ text: `${pct}%` });
}

function finishBadge(text, color) {
  clearTimeout(badgeTimer);
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  if (text) badgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: "" }), 8000);
}

function notifyDone(job) {
  const r = job.result;
  chrome.notifications.create(`done:${job.id}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `Extracted ${r.files.toLocaleString()} files`,
    message: `${humanBytes(r.extracted_bytes)} written to ${r.output}\nZip stored on disk: ${humanBytes(r.zip_bytes_on_disk)}`,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  await ready;
  const job = jobs.get(notificationId.replace(/^done:/, ""));
  if (job?.via === "helper" && job.result?.output) sendToHost({ type: "reveal", path: job.result.output });
  else if (job?.target?.key === "downloads") chrome.downloads.showDefaultFolder();
  else await showPopup();
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------------------
// Saving into Downloads
// ---------------------------------------------------------------------------------------
//
// The engine's page has no chrome.downloads, so it hands each checked file over as a blob URL
// (saveFile) and this worker downloads it into Downloads/<zip name>/... Chrome then treats it
// like any download: it may hold back a file it thinks is risky until the user keeps it, and it
// asks for a location first when "Ask where to save each file" is on in its settings.

/** A download that still has no name after this long waits for Chrome's Save As dialog. */
const ASK_WAIT_MS = 3000;
const DISK_FULL = new Set(["FILE_NO_SPACE", "FILE_TOO_LARGE"]);
const BLOCKED = new Set(["FILE_VIRUS_INFECTED", "FILE_BLOCKED", "FILE_SECURITY_CHECK_FAILED"]);
const TRANSIENT = new Set(["FILE_TRANSIENT_ERROR", "FILE_FAILED"]);
// Chrome is still checking (enterprise scans): wait. Any other danger but these is held back.
const DANGER_OK = new Set(["safe", "accepted", "allowlistedByPolicy", "deepScannedSafe", "asyncScanning", "asyncLocalPasswordScanning"]);
const saving = new Map(); // download id -> waiter

chrome.downloads.onChanged.addListener((d) => {
  saving.get(d.id)?.check({ state: d.state?.current, danger: d.danger?.current, error: d.error?.current, filename: d.filename?.current });
});

/** Download `url` (a blob URL of the engine's page) as `filename` inside Downloads. */
async function saveDownload({ url, filename }) {
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: "overwrite", saveAs: false });
  } catch (e) {
    const message = String(e?.message || e);
    return { ok: false, code: /invalid filename/i.test(message) ? "bad_name" : "failed", error: message };
  }
  return new Promise((resolve) => {
    const w = { named: false, holding: false };
    const finish = (r, erase = true) => {
      if (saving.get(id) !== w) return;
      saving.delete(id);
      clearTimeout(w.timer);
      // Out of the download list: it would fill up with every file of the zip.
      if (erase) chrome.downloads.erase({ id }).catch(() => {});
      resolve(r);
    };
    // Held back: answer once all of it is written (the blob URL may go away after that).
    const hold = async (why) => {
      if (w.holding) return;
      w.holding = true;
      for (let i = 0; i < 240 && saving.get(id) === w; i++) {
        const [it] = await chrome.downloads.search({ id }).catch(() => []);
        if (!it || it.state !== "in_progress" || (it.totalBytes > 0 && it.bytesReceived >= it.totalBytes)) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      finish({ ok: true, held: why, downloadId: id }, false);
    };
    w.check = ({ state, danger, error, filename }) => {
      if (filename) w.named = true;
      if (state === "complete") return w.holding ? finish({ ok: true }, false) : finish({ ok: true });
      if (state === "interrupted") {
        // Cancelled before it had a name: the Save As dialog was closed.
        if (error === "USER_CANCELED" && !w.named) return finish({ ok: false, code: "ask_where", error });
        if (error === "USER_CANCELED") return finish({ ok: true, held: "cancelled", downloadId: id }, false);
        if (BLOCKED.has(error)) return finish({ ok: true, held: "blocked", downloadId: id }, false);
        if (DISK_FULL.has(error)) return finish({ ok: false, code: "disk_full", error });
        return finish({ ok: false, code: TRANSIENT.has(error) ? "transient" : "failed", error });
      }
      if (danger && !DANGER_OK.has(danger)) hold(danger);
    };
    saving.set(id, w);
    // It may have finished before anyone listened.
    chrome.downloads.search({ id }).then(([it]) => it && w.check(it), () => {});
    w.timer = setTimeout(async () => {
      const [it] = await chrome.downloads.search({ id }).catch(() => []);
      if (it?.state === "in_progress" && !it.filename) finish({ ok: false, code: "ask_where", error: "Chrome is waiting for a place to save the file" }, false);
    }, ASK_WAIT_MS);
  });
}

const savingIntoDownloads = () => [...jobs.values()].some((j) => running(j) && j.via !== "helper" && j.target?.key === "downloads");

// While a job saves into Downloads, Chrome's download bubble would pop up for every single file:
// it stays hidden until the job ends (Chrome shows it again when the extension asks, or restarts).
// Then the files Chrome holds back show up in it, with Keep.
let downloadUiHidden = false;
function syncDownloadUi() {
  const hide = savingIntoDownloads();
  if (hide === downloadUiHidden) return;
  downloadUiHidden = hide;
  chrome.downloads.setUiOptions({ enabled: !hide }).catch(() => {});
  if (!hide) eraseFinishedSaves();
}

/**
 * Our finished saves that are still in the download list (normally each one is erased as it
 * finishes; not when this worker was restarted meanwhile). Held-back and blocked files stay:
 * that list is where the user keeps them or sees why.
 */
async function eraseFinishedSaves() {
  const ours = await chrome.downloads.search({ urlRegex: `^blob:${chrome.runtime.getURL("")}` }).catch(() => []);
  for (const d of ours) {
    const leftover = d.state === "complete" || (d.state === "interrupted" && !BLOCKED.has(d.error) && d.error !== "USER_CANCELED");
    if (leftover && !saving.has(d.id)) chrome.downloads.erase({ id: d.id }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------
// Site access and login
// ---------------------------------------------------------------------------------------

/** Chrome lets LinkUnzip read this link's site (that site, or every site). */
async function siteAllowed(url) {
  const pattern = sitePattern(url);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
}

const originOf = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

/** Whether the user let LinkUnzip use their login on this link's site. */
async function loginAllowed(url) {
  const { loginSites = [] } = await chrome.storage.local.get("loginSites");
  const settings = await getSettings();
  return Boolean(settings.loginEverywhere) || loginSites.includes(originOf(url));
}

/** The browser sends its cookies for the zip's site only when the user allowed it there. */
async function credentialsFor(job) {
  job.loginSent = await loginAllowed(job.url);
  return job.loginSent ? "include" : "omit";
}

/**
 * Headers for the helper (stream mode): the site's cookies only with the user's go-ahead, and
 * only once Chrome's optional "cookies" permission was granted (the popup asks when it's needed).
 */
async function helperHeaders(job) {
  if (!(await loginAllowed(job.url))) return {};
  const headers = { "User-Agent": navigator.userAgent };
  try {
    if (await chrome.permissions.contains({ permissions: ["cookies"] })) {
      const cookies = await chrome.cookies.getAll({ url: job.url });
      if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    }
  } catch {
    // No access to that site's cookies: continue without.
  }
  if (job.pageUrl && /^https?:/i.test(job.pageUrl)) headers.Referer = job.pageUrl;
  return headers;
}

// ---------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------

/** Where a job goes: `Downloads/<zip name>`, or `<chosen folder>/<zip name>` (Settings). */
async function defaultTarget(name) {
  const sub = folderNameFor(name);
  const { saveTo } = await getSettings();
  const base = saveTo === "folder" ? await getFolder("base") : null;
  if (base) return { target: { key: "base", sub }, output: folderLabel(base.name, sub) };
  return { target: { key: "downloads", sub }, output: folderLabel("Downloads", sub) };
}

/** Start looking at a URL: creates the job and asks the engine to read the zip's index. */
async function startInspect({ url, pageUrl = "" }) {
  await ready;
  const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = fileNameFromUrl(url);
  const job = { id, url, pageUrl, name, phase: "inspecting", createdAt: Date.now(), ...(await defaultTarget(name)) };
  jobs.set(id, job);
  await setCurrent(id);

  if (!/^https?:\/\//i.test(url)) {
    fail(job, {
      code: "unsupported_url",
      message: "LinkUnzip can only read http:// and https:// links. Downloads that live inside the page (blob: links, like WhatsApp Web) cannot be fetched again.",
    });
    persist();
    return job;
  }
  await sendInspect(job);
  return job;
}

/** Ask the engine to read the index of an existing job (first time, or again after a failure). */
async function sendInspect(job) {
  job.phase = "inspecting";
  job.startedAt = Date.now();
  job.error = null;
  job.via = "engine";
  persist();
  if (!(await siteAllowed(job.url))) {
    fail(job, { code: "site_access", message: "LinkUnzip needs your permission to read files from this site." });
    persist();
    return;
  }
  const credentials = await credentialsFor(job);
  if (!(await toEngine({ type: "inspect", id: job.id, url: job.url, credentials }))) {
    fail(job, { code: "host", message: "LinkUnzip's engine didn't start." });
  }
  persist();
}

async function startExtract({ id, output, target, include = [], select, connections, force = false, stream = false, resume }) {
  await ready;
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "That job no longer exists." };
  const settings = await getSettings();
  job.lastExtract = { id, output, target, include, select, connections, force, stream };
  job.startedAt = Date.now();
  job.stream = stream;
  job.progress = null;
  job.error = null;

  if (stream) {
    // Servers without Range support: only the Windows helper can read them (in one pass).
    const info = await ensureHost();
    if (!info) return { ok: false, error: "Reading this server in one pass needs the LinkUnzip helper for Windows. Download the zip normally instead." };
    const path = joinPath(info.downloads_dir, joinPath("LinkUnzip", folderNameFor(job.name)));
    job.via = "helper";
    job.output = path;
    job.phase = "extracting";
    const ok = sendToHost({ type: "extract", id: `${id}:x`, url: job.url, output: path, include: [], jobs: 1, force, stream: true, headers: await helperHeaders(job) });
    if (!ok) fail(job, hostError || friendlyHostError(""));
    persist();
    return { ok };
  }

  if (!target) return { ok: false, error: "Choose a folder to extract into." };
  job.via = "engine";
  job.target = target;
  job.output = output || job.output;
  job.phase = "extracting";
  const ok = await toEngine({
    type: "extract",
    id: `${id}:x`,
    url: job.url,
    target,
    include: include.filter(Boolean),
    select,
    resume,
    jobs: connections || settings.connections,
    force,
    credentials: await credentialsFor(job),
  });
  if (!ok) fail(job, { code: "host", message: "LinkUnzip's engine didn't start." });
  persist();
  return { ok };
}

/** Run a failed job again the same way: read the index again, or repeat the last extraction. */
async function retry(job) {
  if (job.failedWhile === "extract" && job.lastExtract) return startExtract(job.lastExtract);
  await sendInspect(job);
  return { ok: true };
}

// "Allow" for a site: the popup asks Chrome (that needs the click), then the job runs again.
// Chrome's prompt can close the toolbar popup before it hears the answer, so the background also
// watches for the grant itself.
async function retryWithAccess(job) {
  if (!job?.awaitingAccess || job.phase !== "error") return;
  if (!(await siteAllowed(job.url))) return;
  if (!job.awaitingAccess) return; // the other path got here first
  job.awaitingAccess = false;
  job.accessRefused = false;
  await retry(job);
}

chrome.permissions.onAdded.addListener(async () => {
  await ready;
  for (const job of jobs.values()) await retryWithAccess(job);
});

async function showPopup() {
  try {
    await chrome.action.openPopup();
  } catch {
    // No focused browser window to attach the popup to: use a small window instead.
    await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?window=1"), type: "popup", width: 460, height: 720 });
  }
}

async function openUiFor(url, pageUrl) {
  await startInspect({ url, pageUrl });
  await showPopup();
}

// ---------------------------------------------------------------------------------------
// Messages from the popup and the viewer
// ---------------------------------------------------------------------------------------

async function readyJob(id) {
  await ready;
  return jobs.get(id) || null;
}

const commands = {
  async ping() {
    await ready;
    await ensureEngine().catch(() => false);
    // The helper is optional: only asked so the popup can offer "Open folder" for its jobs.
    ensureHost().then(() => persist());
    return { ok: Boolean(engineInfo), info: engineInfo, helper: hostInfo, error: engineInfo ? null : { code: "host", message: "LinkUnzip's engine didn't start." } };
  },
  async inspect(m) {
    const job = await startInspect(m);
    return { ok: true, id: job.id };
  },
  extract: startExtract,
  // Where every job goes changed in Settings: jobs not started yet follow it, unless the user
  // chose a place for that one job.
  async baseFolderChanged({ id } = {}) {
    await ready;
    for (const job of jobs.values()) {
      if (job.phase === "ready" || job.phase === "error" || job.phase === "inspecting") {
        if (job.ownTarget) continue;
        Object.assign(job, await defaultTarget(job.name));
      }
    }
    persist();
    const job = id ? jobs.get(id) : null;
    return { ok: true, target: job?.target || null, output: job?.output || "" };
  },
  // A folder picked for one job (saved under "job:<id>" by the popup).
  async jobFolder({ id, name }) {
    const job = await readyJob(id);
    if (!job) return { ok: false };
    const sub = folderNameFor(job.name);
    job.target = { key: `job:${id}`, sub };
    job.output = folderLabel(name, sub);
    job.ownTarget = true;
    persist();
    return { ok: true, target: job.target, output: job.output };
  },
  // "Save to Downloads" for one job.
  async jobDownloads({ id }) {
    const job = await readyJob(id);
    if (!job) return { ok: false };
    const sub = folderNameFor(job.name);
    job.target = { key: "downloads", sub };
    job.output = folderLabel("Downloads", sub);
    job.ownTarget = true;
    persist();
    return { ok: true, target: job.target, output: job.output };
  },
  // A checked file from the engine, to save into Downloads (see saveDownload).
  async saveFile(m) {
    await ready;
    syncDownloadUi();
    return saveDownload(m);
  },
  async showDownloads() {
    chrome.downloads.showDefaultFolder();
    return { ok: true };
  },
  async list({ id, dir = "", offset = 0, limit = 500 }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That job no longer exists." } };
    const r = await askAboutJob(job, { type: "list", id, dir, offset, limit }, (m) => m.type === "listing" && m.dir === dir && m.offset === offset);
    return r.type === "listing" ? { ok: true, listing: r } : { ok: false, error: r };
  },
  async search({ id, query, limit = 200 }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That job no longer exists." } };
    const r = await askAboutJob(job, { type: "search", id, query, limit }, (m) => m.type === "search_results" && m.query === query);
    return r.type === "search_results" ? { ok: true, results: r } : { ok: false, error: r };
  },
  async measure({ id, select }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That job no longer exists." } };
    const r = await askAboutJob(job, { type: "measure", id, select }, (m) => m.type === "measured");
    return r.type === "measured" ? { ok: true, measured: r } : { ok: false, error: r };
  },
  // The viewer: where one file sits in the zip, so it can fetch and show it itself.
  async entry({ id, path }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That zip is no longer open in LinkUnzip." } };
    const r = await askAboutJob(job, { type: "entry", id, path }, (m) => m.type === "entry" && m.path === path);
    return r.type === "entry" ? { ok: true, ...r, name: job.name } : { ok: false, error: r };
  },
  // The viewer's Previous / Next.
  async neighbors({ id, path }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That zip is no longer open in LinkUnzip." } };
    const r = await askAboutJob(job, { type: "neighbors", id, path }, (m) => m.type === "neighbors" && m.path === path);
    return r.type === "neighbors" ? { ok: true, prev: r.prev, next: r.next, position: r.position, total: r.total } : { ok: false, error: r };
  },
  // "Select all results" in the file list.
  async tickMatches({ id, marks, query, ticked }) {
    const job = await readyJob(id);
    if (!job) return { ok: false, error: { message: "That job no longer exists." } };
    const r = await askAboutJob(job, { type: "tick_matches", id, marks, query, ticked }, (m) => m.type === "ticked" && m.query === query);
    return r.type === "ticked" ? { ok: true, marks: r.marks, matched: r.matched } : { ok: false, error: r };
  },
  async clearCache() {
    await indexCache.clear().catch(() => {});
    return { ok: true };
  },
  // A caught .zip download: let Chrome carry on with it after all, and put the job away.
  async continueDownload({ id }) {
    await ready;
    const job = jobs.get(id);
    const downloadId = job?.caught?.downloadId;
    if (downloadId == null) return { ok: false };
    await chrome.downloads.resume(downloadId).catch(() => {});
    return commands.dismiss({ id });
  },
  async preview({ id, path }) {
    const url = chrome.runtime.getURL(`viewer.html?job=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`);
    // Our own pages are listed without the "tabs" permission.
    const tabs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).catch(() => []);
    const viewer = tabs.find((c) => c.documentUrl?.startsWith(chrome.runtime.getURL("viewer.html")) && c.tabId >= 0);
    if (viewer) {
      await chrome.tabs.update(viewer.tabId, { url, active: true });
      await chrome.windows.update(viewer.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url });
    }
    return { ok: true };
  },
  async cancel({ id }) {
    const job = await readyJob(id);
    if (job?.via === "helper") sendToHost({ type: "cancel", id: `${id}:x` });
    else await toEngine({ type: "cancel", id: `${id}:x` });
    return { ok: true };
  },
  async reveal({ path }) {
    sendToHost({ type: "reveal", path });
    return { ok: true };
  },
  async dismiss({ id }) {
    await ready;
    forget(id);
    const { current } = await chrome.storage.session.get("current");
    if (current === id) {
      currentId = null;
      await chrome.storage.session.remove("current");
    }
    persist();
    return { ok: true };
  },
  // The rating line on the Done screen: either answer puts it away for good.
  async rate({ id, open }) {
    await ready;
    const job = jobs.get(id);
    if (job) {
      job.askRate = false;
      persist();
    }
    if (open) await chrome.tabs.create({ url: REVIEW_URL });
    return { ok: true };
  },
  async downloadNormally({ url }) {
    bypass.set(url, Date.now() + 60_000);
    await chrome.downloads.download({ url });
    return { ok: true };
  },
  async retry({ id }) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { ok: false, error: "That job no longer exists." };
    return retry(job);
  },
  // A stopped or failed extraction, again with the same link, folder, selection and filter: the
  // files that are already in the folder and correct are skipped.
  async resume({ id }) {
    await ready;
    const job = jobs.get(id);
    if (!job?.lastExtract) return { ok: false, error: "There is nothing to resume." };
    return startExtract({ ...job.lastExtract, resume: true });
  },
  // Sent just before the popup shows Chrome's permission prompt, and again with the answer.
  async awaitAccess({ id }) {
    await ready;
    const job = jobs.get(id);
    if (job) job.awaitingAccess = true;
    return { ok: Boolean(job) };
  },
  async accessAnswer({ id, granted }) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { ok: false };
    if (granted) {
      await retryWithAccess(job);
    } else {
      job.awaitingAccess = false;
      job.accessRefused = true;
      persist();
    }
    return { ok: true };
  },
  // "Use my login on <site>": remembered for that site, then the job runs again with it.
  async useLogin({ id }) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { ok: false };
    const { loginSites = [] } = await chrome.storage.local.get("loginSites");
    const origin = originOf(job.url);
    if (origin && !loginSites.includes(origin)) await chrome.storage.local.set({ loginSites: [...loginSites, origin] });
    return retry(job);
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = commands[message?.cmd];
  if (!handler) return false;
  handler(message).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// ---------------------------------------------------------------------------------------
// Right-click menu and download interception
// ---------------------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.contextMenus.create({ id: MENU_ID, title: "Extract with LinkUnzip", contexts: ["link"] });
  // On install and on every update, so the version in the address stays current.
  chrome.runtime.setUninstallURL(`${UNINSTALL_URL}?v=${chrome.runtime.getManifest().version}`);
  // First install: the welcome page asks for site access and the folder.
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  // Settings saved by an older version: store them in today's shape.
  const { settings } = await chrome.storage.local.get("settings");
  if (settings) await chrome.storage.local.set({ settings: migrate(settings) });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_ID && info.linkUrl) openUiFor(info.linkUrl, info.pageUrl);
});

function looksLikeZip(item) {
  const mime = (item.mime || "").toLowerCase();
  return mime === "application/zip" || mime === "application/x-zip-compressed" || /\.zip($|[?#])/i.test(item.url) || /\.zip$/i.test(item.filename || "");
}

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.catchDownloads || item.byExtensionId) return;
  if (!/^https?:\/\//i.test(item.url) || !looksLikeZip(item)) return;
  const expiry = bypass.get(item.url);
  if (expiry && expiry > Date.now()) return;

  // Pause the browser's own download rather than cancel it: some links only work once, and the
  // popup offers to continue it. It is cancelled once LinkUnzip extracted the files.
  await chrome.downloads.pause(item.id).catch(() => {});
  // ... and show what LinkUnzip would do with it instead.
  const job = await startInspect({ url: item.url, pageUrl: item.referrer });
  job.caught = { downloadId: item.id };
  persist();
  await showPopup();
});
