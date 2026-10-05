// LinkUnzip background worker.
//
// It owns the connection to the native host (the LinkUnzip program on the user's machine), keeps
// the state of every job in chrome.storage.session so the popup can redraw it at any time, and
// reacts to the right-click menu and (optionally) to .zip downloads.

import { fileNameFromUrl, folderNameFor, humanBytes, joinPath, sitePattern } from "./fmt.js";
import { loadSettings, migrate } from "./settings.js";

const HOST = "com.linkunzip.host";
const MENU_ID = "linkunzip-extract-link";

let port = null;
let hostInfo = null; // reply to `hello`
let hostError = null; // why the host cannot be reached, when it cannot
let helloWaiters = [];
const jobs = new Map(); // job id -> job
const bypass = new Map(); // url -> expiry: downloads we started ourselves ("download normally")

const ready = restore();

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------

async function restore() {
  const { jobs: saved = {}, hostInfo: savedInfo = null } = await chrome.storage.session.get([
    "jobs",
    "hostInfo",
  ]);
  for (const [id, job] of Object.entries(saved)) {
    // A job that was running when the worker died lost its host connection with it.
    if (job.phase === "inspecting" || job.phase === "extracting") {
      job.failedWhile = job.phase === "extracting" ? "extract" : "inspect";
      job.phase = "error";
      job.error = { code: "host", message: "The connection to LinkUnzip was interrupted." };
    }
    jobs.set(id, job);
  }
  hostInfo = savedInfo;
}

let persistTimer = null;
function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    await chrome.storage.session.set({ jobs: Object.fromEntries(jobs), hostInfo, hostError });
  }, 150);
}

const getSettings = loadSettings;

async function setCurrent(id) {
  await chrome.storage.session.set({ current: id });
}

// ---------------------------------------------------------------------------------------
// Native host connection
// ---------------------------------------------------------------------------------------

// `detail` keeps the browser's own words, shown on the setup page for troubleshooting.
function friendlyHostError(raw) {
  const text = raw || "";
  if (/not found/i.test(text)) {
    return {
      code: "host_missing",
      message: "The LinkUnzip helper isn't installed on this PC yet. Setting it up takes about a minute.",
      detail: text,
    };
  }
  if (/forbidden/i.test(text)) {
    return {
      code: "host_forbidden",
      message: "The LinkUnzip helper on this PC doesn't accept this copy of the extension. Install the helper again.",
      detail: text,
    };
  }
  return { code: "host", message: text || "The connection to LinkUnzip was lost.", detail: text };
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
    for (const job of jobs.values()) {
      if (job.phase === "inspecting" || job.phase === "extracting") fail(job, hostError);
    }
    for (const w of helloWaiters) w();
    helloWaiters = [];
    for (const w of [...waiters]) w.finish({ type: "error", ...hostError });
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

// An open native port keeps both this worker and the LinkUnzip process alive, so close it once
// nothing has happened for a while: the helper then only runs while LinkUnzip is being used.
// Every request carries all it needs, so the next one simply starts a fresh process.
const IDLE_CLOSE_MS = 30_000;
let idleTimer = null;

function busy() {
  for (const job of jobs.values()) {
    if (job.phase === "inspecting" || job.phase === "extracting") return true;
  }
  return waiters.size > 0; // e.g. the folder picker is open: no messages, but not idle
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    // A running job will send more messages, and the last one reschedules this.
    if (!port || busy()) return;
    port.disconnect(); // our own disconnect does not fire onDisconnect, so tidy up here
    port = null;
  }, IDLE_CLOSE_MS);
}

/** Make sure the host is reachable and say hello; resolves with its info or null. */
async function ensureHost() {
  await ready;
  if (hostInfo && port) return hostInfo;
  if (!connect()) return null;
  await new Promise((resolve) => {
    helloWaiters.push(resolve);
    setTimeout(resolve, 2500);
  });
  if (!hostInfo && !hostError) {
    // Started (or still starting) but silent: say so rather than report nothing.
    hostError = {
      code: "host_silent",
      message: "The LinkUnzip helper started but didn't answer.",
      detail: "no reply to hello within 2.5 s",
    };
  }
  return hostInfo;
}

// Requests answered by one particular reply (list, search, measure, pick_folder): each waits for
// the first host message its `match` accepts, or gives up after `timeoutMs` (0 = never).
const waiters = new Set();

function ask(message, match, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const w = { match, timer: null };
    w.finish = (reply) => {
      clearTimeout(w.timer);
      waiters.delete(w);
      resolve(reply);
    };
    if (timeoutMs) {
      w.timer = setTimeout(
        () => w.finish({ type: "error", code: "timeout", message: "The LinkUnzip helper didn't answer in time." }),
        timeoutMs,
      );
    }
    waiters.add(w);
    if (!sendToHost(message)) w.finish({ type: "error", ...(hostError || friendlyHostError("")) });
  });
}

/**
 * Ask about a job's archive. The helper keeps the index only while it runs: after an idle close it
 * answers `unknown_job`, so read the index again (quietly, the job stays as it is) and repeat.
 */
async function askAboutJob(job, message, accepts) {
  const match = (m) => m.id === job.id && (m.type === "error" || accepts(m));
  let reply = await ask(message, match);
  if (reply.type === "error" && reply.code === "unknown_job") {
    const headers = await buildHeaders(job);
    const again = await ask(
      { type: "inspect", id: job.id, url: job.url, headers, output: job.output || undefined },
      (m) => m.id === job.id && (m.type === "inspected" || m.type === "error"),
      120_000,
    );
    if (again.type !== "inspected") return again;
    reply = await ask(message, match);
  }
  return reply;
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
  for (const w of waiters) {
    if (w.match(msg)) return w.finish(msg);
  }
  const jobId = typeof msg.id === "string" ? msg.id.split(":")[0] : null;
  const job = jobId ? jobs.get(jobId) : null;
  if (!job) return;
  // Only ever an answer to a question about the archive; never something to show.
  if (msg.type === "error" && msg.code === "unknown_job") return;

  switch (msg.type) {
    case "inspected":
      job.phase = "ready";
      job.report = msg.report;
      break;
    case "started":
      job.phase = "extracting";
      job.output = msg.output;
      break;
    case "progress":
      job.phase = job.phase === "extracting" || job.phase === "ready" ? "extracting" : job.phase;
      job.progress = msg;
      updateBadge(job);
      break;
    case "done":
      job.phase = "done";
      job.result = msg;
      finishBadge("✓", "#2f9e6f");
      notifyDone(job);
      break;
    case "cancelled":
      job.phase = "cancelled";
      job.result = msg;
      finishBadge("", "#000000");
      break;
    case "error":
      fail(job, {
        code: msg.code || "failed",
        message: msg.message,
        detail: msg.detail,
        http_status: msg.http_status,
        host: msg.host,
      });
      break;
  }
  persist();
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
    message: `${humanBytes(r.extracted_bytes)} written to ${r.output}\nZip stored on disk: ${humanBytes(
      r.zip_bytes_on_disk,
    )}`,
    priority: 1,
  });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  await ready;
  const job = jobs.get(notificationId.replace(/^done:/, ""));
  if (job?.result?.output) sendToHost({ type: "reveal", path: job.result.output });
  chrome.notifications.clear(notificationId);
});

// ---------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------

/** Whether the user let LinkUnzip use their login on this link's site (that site, or every site). */
async function loginAllowed(url) {
  const pattern = sitePattern(url);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
}

/**
 * Headers for the helper's requests. Public links need none: the helper downloads the zip itself.
 * The browser's login for the zip's site (its cookies, plus the browser's User-Agent and the page
 * the link was on) goes along only once the user allowed it for that site.
 *
 * Tried and dropped: the `activeTab` grant from a right-click or toolbar click lets scripts run on
 * the page, but chrome.cookies still answers nothing for that site without a host permission.
 */
async function buildHeaders(job) {
  job.loginSent = await loginAllowed(job.url);
  if (!job.loginSent) {
    job.sentCookies = false;
    return {};
  }
  const headers = { "User-Agent": navigator.userAgent };
  try {
    const cookies = await chrome.cookies.getAll({ url: job.url });
    if (cookies.length) headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    // Permission removed in the meantime: continue without cookies.
  }
  if (job.pageUrl && /^https?:/i.test(job.pageUrl)) headers.Referer = job.pageUrl;
  job.sentCookies = Boolean(headers.Cookie);
  return headers;
}

async function defaultOutput(name, settings) {
  const info = await ensureHost();
  const base = settings.baseFolder || (info ? joinPath(info.downloads_dir, "LinkUnzip") : "");
  return base ? joinPath(base, folderNameFor(name)) : "";
}

/** Start looking at a URL: creates the job and asks the host to read the zip's index. */
async function startInspect({ url, pageUrl = "" }) {
  await ready;
  const settings = await getSettings();
  const id = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const name = fileNameFromUrl(url);
  const job = {
    id,
    url,
    pageUrl,
    name,
    phase: "inspecting",
    createdAt: Date.now(),
    output: await defaultOutput(name, settings),
  };
  jobs.set(id, job);
  await setCurrent(id);

  if (!/^https?:\/\//i.test(url)) {
    fail(job, {
      code: "unsupported_url",
      message:
        "LinkUnzip can only read http:// and https:// links. Downloads that live inside the page (blob: links, like WhatsApp Web) cannot be fetched by another program.",
    });
    persist();
    return job;
  }
  await sendInspect(job);
  return job;
}

/** Ask the host to read the index of an existing job (first time, or again after a failure). */
async function sendInspect(job) {
  job.phase = "inspecting";
  job.error = null;
  const headers = await buildHeaders(job);
  if (!sendToHost({ type: "inspect", id: job.id, url: job.url, headers, output: job.output || undefined })) {
    fail(job, hostError || friendlyHostError(""));
  }
  persist();
}

async function startExtract({ id, output, include = [], select, connections, force = false, stream = false, resume }) {
  await ready;
  const job = jobs.get(id);
  if (!job) return { ok: false, error: "That job no longer exists." };
  // An older helper would ignore the selection and extract everything: never send it there.
  if (select && !(await ensureHost())?.features?.includes("select")) {
    return { ok: false, error: "This LinkUnzip helper can't extract only some files. Update it, or use the pattern filter." };
  }
  const settings = await getSettings();
  const headers = await buildHeaders(job);
  job.output = output;
  job.stream = stream;
  job.lastExtract = { id, output, include, select, connections, force, stream };
  job.phase = "extracting";
  job.progress = null;
  job.error = null;
  const ok = sendToHost({
    type: "extract",
    id: `${id}:x`,
    url: job.url,
    output,
    include: include.filter(Boolean),
    select,
    resume,
    jobs: connections || settings.connections,
    force,
    stream,
    headers,
  });
  if (!ok) fail(job, hostError || friendlyHostError(""));
  persist();
  return { ok };
}

/** Run a failed job again the same way: read the index again, or repeat the last extraction. */
async function retry(job) {
  if (job.failedWhile === "extract" && job.lastExtract) return startExtract(job.lastExtract);
  await sendInspect(job);
  return { ok: true };
}

// "Use my login on <host>": the popup asks Chrome for the site (that needs the click), then the job
// runs again with the login. Chrome's prompt can close the toolbar popup before it hears the
// answer, so the background also watches for the grant itself.
async function retryWithLogin(job) {
  if (!job?.awaitingLogin || job.phase !== "error") return;
  if (!(await loginAllowed(job.url))) return;
  if (!job.awaitingLogin) return; // the other path got here first
  job.awaitingLogin = false;
  job.loginRefused = false;
  await retry(job);
}

chrome.permissions.onAdded.addListener(async () => {
  await ready;
  for (const job of jobs.values()) await retryWithLogin(job);
});

async function showPopup() {
  try {
    await chrome.action.openPopup();
  } catch {
    // No focused browser window to attach the popup to: use a small window instead.
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html?window=1"),
      type: "popup",
      width: 440,
      height: 680,
    });
  }
}

async function openUiFor(url, pageUrl) {
  await startInspect({ url, pageUrl });
  await showPopup();
}

async function popupIsOpen() {
  const page = chrome.runtime.getURL("popup.html");
  const contexts = await chrome.runtime.getContexts({}).catch(() => []);
  return contexts.some((c) => c.documentUrl?.startsWith(page));
}

/**
 * Browse...: the helper shows the Windows folder picker (owned by the browser window). The toolbar
 * popup closes as soon as the dialog takes focus, so the choice is kept here, where the popup
 * looks when it opens (the job's draft, or the settings), and the popup is opened again.
 */
let picks = 0;
async function pickFolder({ field, start, jobId }) {
  const info = await ensureHost();
  if (!info?.features?.includes("pick_folder")) return { ok: false, error: "This LinkUnzip helper can't show the folder picker." };
  const id = `pick${++picks}`;
  const reply = await ask(
    { type: "pick_folder", id, start: start || undefined },
    (m) => m.id === id && (m.type === "picked" || m.type === "error"),
    0, // the dialog stays open as long as the user wants
  );
  if (reply.type !== "picked") return { ok: false, error: reply.message };
  if (!reply.path) return { ok: true, path: null }; // cancelled: nothing changes
  if (field === "baseFolder") {
    const settings = await getSettings();
    await chrome.storage.local.set({ settings: { ...settings, baseFolder: reply.path } });
  } else if (jobId) {
    const { drafts = {} } = await chrome.storage.session.get("drafts");
    drafts[jobId] = { ...drafts[jobId], output: reply.path };
    await chrome.storage.session.set({ drafts });
  }
  if (!(await popupIsOpen())) {
    await chrome.storage.session.set({ reopen: field === "baseFolder" ? "settings" : "job" });
    await showPopup();
  }
  return { ok: true, path: reply.path };
}

// ---------------------------------------------------------------------------------------
// Messages from the popup
// ---------------------------------------------------------------------------------------

async function readyJob(id) {
  await ready;
  return jobs.get(id) || null;
}

const commands = {
  async ping() {
    const info = await ensureHost();
    return { ok: Boolean(info), info, error: hostError };
  },
  async inspect(m) {
    const job = await startInspect(m);
    return { ok: true, id: job.id };
  },
  extract: startExtract,
  pickFolder,
  // Browsing the archive (helpers with `list`, `search`, `measure`); answers come straight back.
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
  async cancel({ id }) {
    sendToHost({ type: "cancel", id: `${id}:x` });
    return { ok: true };
  },
  async reveal({ path }) {
    sendToHost({ type: "reveal", path });
    return { ok: true };
  },
  async dismiss({ id }) {
    await ready;
    jobs.delete(id);
    const { current } = await chrome.storage.session.get("current");
    if (current === id) await chrome.storage.session.remove("current");
    persist();
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
  // helper skips the files that are already in the folder and correct.
  async resume({ id }) {
    await ready;
    const job = jobs.get(id);
    if (!job?.lastExtract) return { ok: false, error: "There is nothing to resume." };
    return startExtract({ ...job.lastExtract, resume: true });
  },
  // Sent just before the popup shows Chrome's permission prompt, and again with the answer.
  async awaitLogin({ id }) {
    await ready;
    const job = jobs.get(id);
    if (job) job.awaitingLogin = true;
    return { ok: Boolean(job) };
  },
  async loginAnswer({ id, granted }) {
    await ready;
    const job = jobs.get(id);
    if (!job) return { ok: false };
    if (granted) {
      await retryWithLogin(job);
    } else {
      job.awaitingLogin = false;
      job.loginRefused = true;
      persist();
    }
    return { ok: true };
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
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Extract with LinkUnzip",
    contexts: ["link"],
  });
  // First install: walk the user through getting the helper program.
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
  return (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    /\.zip($|[?#])/i.test(item.url) ||
    /\.zip$/i.test(item.filename || "")
  );
}

chrome.downloads.onCreated.addListener(async (item) => {
  const settings = await getSettings();
  if (!settings.catchDownloads || item.byExtensionId) return;
  if (!/^https?:\/\//i.test(item.url) || !looksLikeZip(item)) return;
  const expiry = bypass.get(item.url);
  if (expiry && expiry > Date.now()) return;

  // Stop the browser's own download (and throw away whatever it already wrote) ...
  await chrome.downloads.cancel(item.id).catch(() => {});
  await chrome.downloads.removeFile(item.id).catch(() => {});
  await chrome.downloads.erase({ id: item.id }).catch(() => {});
  // ... and show what LinkUnzip would do with it instead.
  await openUiFor(item.url, item.referrer);
});
