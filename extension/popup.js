// LinkUnzip popup. All the real work happens in background.js and the engine it runs; this page
// only shows the state of the current job and sends commands.
//
// Names, paths and messages come from archives and servers we do not control, so everything is
// put on the page with textContent (via h()), never innerHTML.

import { h } from "./dom.js";
import { fileList } from "./filelist.js";
import { askFolderPermission, folderPermission, getFolder, pickFolder as showFolderPicker, setFolder } from "./folder.js";
import { clock, fileNameFromUrl, folderNameFor, hostOf, humanBytes, humanDuration, joinPath, sitePattern } from "./fmt.js";
import { LANGUAGES, browserLanguage as navigatorLanguage, list, loadLanguage, num, t, tn, translatePage } from "./i18n.js";
import { engineFor, helperCanExtract } from "./route.js";
import { ALL_SITES, DEFAULT_SETTINGS, applyTheme, effectiveTheme, loadSettings } from "./settings.js";

const view = document.getElementById("view");
const windowMode = new URLSearchParams(location.search).has("window");
if (windowMode) document.body.classList.add("window-mode");

// hostInfo: the engine's hello (what it can do); helperInfo: the Windows helper's, if installed.
let st = { jobs: {}, current: null, hostInfo: null, hostError: null, helperInfo: null };
let settings = { ...DEFAULT_SETTINGS };
// What the user typed or chose for each job, so neither a redraw nor closing the popup loses it.
let drafts = {};
// A zip's password as typed, by job: only in this page's memory, never in the drafts (those are
// stored). Start hands it to the background, which keeps it in memory too.
const typedPasswords = new Map();
let drawn = ""; // which job/phase is on screen
let updater = null; // redraws the live numbers of the current view without rebuilding it

const send = (cmd, data = {}) => chrome.runtime.sendMessage({ cmd, ...data });

/** What the engine can do (`hello.features`). */
const hasFeature = (name) => Boolean(st.hostInfo?.features?.includes(name));

function draftFor(job) {
  const d = (drafts[job.id] = { include: "", force: false, ...drafts[job.id] });
  // The folder lives in the job (the background keeps it when Settings or a pick change it).
  d.output = job.output || "";
  d.target = job.target || null;
  // Settings > Extract with the Windows helper: it saves into the Windows Downloads folder (which
  // may not be the one Chrome uses), so the popup shows its whole path.
  if (engineFor(job, settings, st.helperInfo).via === "helper") {
    const sub = job.target?.sub || folderNameFor(job.name || "");
    d.target = { key: "helper", sub };
    d.output = joinPath(st.helperInfo.downloads_dir, sub);
  }
  return d;
}

let draftTimer = null;
function saveDrafts(now = false) {
  clearTimeout(draftTimer);
  const write = () => {
    for (const id of Object.keys(drafts)) if (!st.jobs[id]) delete drafts[id];
    chrome.storage.session.set({ drafts });
  };
  if (now) write();
  else draftTimer = setTimeout(write, 250);
}
addEventListener("pagehide", () => saveDrafts(true));

/** Append nodes to the view, skipping the nulls that conditional pieces leave behind. */
function show(...nodes) {
  view.append(...nodes.flat().filter(Boolean));
}

/** A white panel on the page, as in the design: the body of most views. */
function panel(...nodes) {
  return h("div", { class: "card panel" }, ...nodes.flat().filter(Boolean));
}

/** The status bar's left part: what LinkUnzip is doing now. */
function setStatus(text) {
  document.getElementById("status-text").textContent = text;
}

/** The bar pinned to the bottom of the popup: the view's buttons, then quieter text links. */
function actionBar(buttons, links = []) {
  const quiet = links.filter(Boolean);
  return h(
    "div",
    { class: "actions" },
    h("div", { class: "btn-row wrap" }, ...buttons.filter(Boolean)),
    quiet.length ? h("div", { class: "quiet-row" }, ...quiet) : null,
  );
}

// ---------------------------------------------------------------------------------------
// Loading state
// ---------------------------------------------------------------------------------------

async function loadState() {
  const s = await chrome.storage.session.get(["jobs", "current", "engineInfo", "hostInfo", "drafts", "pendingExtract"]);
  st = {
    jobs: s.jobs || {},
    current: s.current || null,
    hostInfo: s.engineInfo || null,
    hostError: null,
    helperInfo: s.hostInfo || null,
  };
  drafts = s.drafts || {};
  settings = await loadSettings();
  return s.pendingExtract || null;
}

// ---------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------
//
// Two places files can go:
//
// * Downloads (the default): Chrome's own downloads save every file into Downloads/<zip name>.
//   Nothing to pick or allow, so it starts right in the toolbar popup. Chrome takes a moment per
//   file, though, which zips with thousands of files notice (the popup says so before starting).
// * A folder the user picked (File System Access): much faster per file. Chrome's folder picker
//   and its "Let LinkUnzip edit files?" question take the focus, and the toolbar popup closes
//   when it loses the focus. So both only ever appear in the LinkUnzip window, which stays open;
//   the toolbar popup hands over to it. Those extractions also run with that window open: it
//   shows the progress, and Chrome keeps a folder permission while a LinkUnzip window is open.

const isDownloads = (target) => target?.key === "downloads";
/** Into Downloads, or by the helper: nothing for Chrome to ask, no picker. */
const noPicker = (target) => isDownloads(target) || target?.key === "helper";
/** Files Chrome's downloads save per second (measured: 6 to 11 small files). */
const DOWNLOADS_PER_SEC = 6;
/** From this many seconds of saving on, the popup suggests a folder instead of Downloads. */
const SLOW_SECS = 60;
/** "about 2 minutes", "about 1 hour 20 minutes": an estimate, so no seconds. */
function roughly(secs) {
  const min = Math.max(1, Math.round(secs / 60));
  if (min < 60) return tn("about {count} minute", "about {count} minutes", min);
  const hours = Math.floor(min / 60);
  const m = min % 60;
  return m ? t("about {hours} {minutes}", { hours: tn("{count} hour", "{count} hours", hours), minutes: tn("{count} minute", "{count} minutes", m) }) : tn("about {count} hour", "about {count} hours", hours);
}

/** "1 file", "5,518 files". */
const files = (n) => tn("{count} file", "{count} files", n);

const WINDOW_URL = chrome.runtime.getURL("popup.html");

// The extraction the toolbar popup handed over to this window ({id, include, select, ...}).
let pending = null;
const pendingFor = (job) => (pending && job && pending.id === job.id ? pending : null);

/** Open (or bring forward and reload) the LinkUnzip window with `query`, e.g. "&start=1". */
async function openLinkUnzipWindow(query = "") {
  saveDrafts(true);
  const url = `${WINDOW_URL}?window=1${query}`;
  const tabs = await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).catch(() => []);
  const open = tabs.find((c) => c.documentUrl?.startsWith(`${WINDOW_URL}?window=1`) && c.tabId >= 0);
  if (open) {
    await chrome.tabs.update(open.tabId, { url });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.windows.create({ url, type: "popup", width: 460, height: 720 });
  }
  if (!windowMode) window.close();
}

/** Chrome's folder picker (window only). null when cancelled or refused (said in `problem`). */
async function chooseFolder(problem) {
  try {
    return await showFolderPicker();
  } catch (e) {
    if (problem) {
      problem.textContent = t("Chrome didn't allow that folder: {error}", { error: e.message });
      problem.hidden = false;
    }
    return null;
  }
}

/** Pick the folder every job goes into (Settings, or the first extraction). */
async function chooseBaseFolder(problem) {
  const handle = await chooseFolder(problem);
  if (!handle) return null;
  await setFolder("base", handle);
  await send("baseFolderChanged");
  return handle;
}

/** Pick a folder for this one job (window only). With no folder in Settings yet it goes there too. */
async function chooseJobFolder(job, d, problem) {
  const handle = await chooseFolder(problem);
  if (!handle) return false;
  await setFolder(`job:${job.id}`, handle);
  if (!(await getFolder("base"))) await setFolder("base", handle);
  const r = await send("jobFolder", { id: job.id, name: handle.name });
  if (!r?.ok) return false;
  d.target = r.target;
  d.output = r.output;
  return true;
}

/** Back to Downloads for this one job. */
async function useDownloads(job, d) {
  const r = await send("jobDownloads", { id: job.id });
  if (!r?.ok) return false;
  d.target = r.target;
  d.output = r.output;
  return true;
}

/**
 * Window only, inside a click: a folder, and Chrome's OK to write there (Chrome asks again after
 * the browser restarts). Returns the target, or null with `problem` saying why.
 */
async function readyFolder(job, d, problem) {
  if (noPicker(d.target)) return d.target;
  if (!d.target && !(await chooseJobFolder(job, d, problem))) {
    if (problem.hidden) {
      problem.textContent = t("Choose a folder to extract into.");
      problem.hidden = false;
    }
    return null;
  }
  const handle = await getFolder(d.target.key);
  if (!handle) {
    d.target = null;
    problem.textContent = t("That folder is no longer known to LinkUnzip. Choose it again.");
    problem.hidden = false;
    return null;
  }
  if (!(await askFolderPermission(handle))) {
    problem.textContent = t("Chrome didn't let LinkUnzip save into {folder}. Click the button again and choose Allow (or \"Allow on every visit\").", { folder: handle.name });
    problem.hidden = false;
    return null;
  }
  return d.target;
}

/** Can an extraction start right away, without the picker or one of Chrome's questions? */
async function folderReady(d) {
  if (noPicker(d.target)) return true;
  if (!d.target) return false;
  const handle = await getFolder(d.target.key);
  return Boolean(handle) && (await folderPermission(handle)) === "granted";
}

/**
 * Start (or resume) an extraction. Into Downloads it starts right away; into a folder, the
 * toolbar popup moves to the LinkUnzip window, which asks what Chrome needs and starts it there
 * (see `pending` at the end of this file).
 */
async function startExtraction(job, d, request, problem) {
  if (!windowMode && !noPicker(d.target)) {
    // The window starts it from storage: the password goes to the background's memory instead.
    const { password, ...rest } = request;
    if (password) await send("setPassword", { id: job.id, password });
    await chrome.storage.session.set({ pendingExtract: { ...rest, id: job.id } });
    await openLinkUnzipWindow("&start=1");
    return;
  }
  problem.className = "notice bad";
  problem.hidden = true;
  const target = await readyFolder(job, d, problem);
  if (!target) return;
  pending = null;
  await chrome.storage.session.remove("pendingExtract");
  const res = await send("extract", { ...request, id: job.id, target, output: d.output });
  if (res && !res.ok) {
    problem.textContent = res.error;
    problem.hidden = false;
  }
}

/**
 * The zip's password: `text` says why it's asked, Show reveals what was typed, Enter runs
 * `onEnter`. What is typed stays in this page's memory (typedPasswords) until Start sends it.
 */
function passwordField(job, text, { onEnter = null } = {}) {
  const id = `password-${job.id}`;
  const input = h("input", { type: "password", id, autocomplete: "off", spellcheck: "false", value: typedPasswords.get(job.id) || "" });
  input.addEventListener("input", () => typedPasswords.set(job.id, input.value));
  if (onEnter) input.addEventListener("keydown", (e) => e.key === "Enter" && onEnter());
  const reveal = h("button", { type: "button", class: "link small", "aria-pressed": "false" }, t("Show"));
  reveal.addEventListener("click", () => {
    const shown = input.type === "password";
    input.type = shown ? "text" : "password";
    reveal.textContent = shown ? t("Hide") : t("Show");
    reveal.setAttribute("aria-pressed", String(shown));
  });
  return h(
    "div",
    { class: "notice password-row" },
    h("label", { for: id }, text),
    h("div", { class: "row" }, input, reveal),
    h("p", { class: "muted small" }, t("Kept only while LinkUnzip works on this zip, never saved. It may ask again later.")),
  );
}

/**
 * Where the files go, Change... for this job (the picker opens in the window) and, for a folder,
 * the way back to Downloads. `onChange` hears about a new place.
 */
function folderField(label, d, job, { compact = false, onChange = () => {} } = {}) {
  // With the helper turned on, say which program extracts this zip (and why the browser does).
  const route = engineFor(job, settings, st.helperInfo);
  const by = settings.useHelper
    ? h("p", { class: "muted small engine-note" }, route.via === "helper" ? t("Extracted by the Windows helper.") : t("Extracted in the browser: {reason}.", { reason: t(route.why, route.vars) }))
    : null;
  if (d.target?.key === "helper") {
    return h(
      "div",
      { class: "field" },
      h("span", { class: compact ? "sr-only" : "label" }, label),
      h("div", { class: "path-row folder-row" }, h("span", { class: "folder-name", title: d.output }, d.output)),
      by,
    );
  }
  const text = h("span", { class: "folder-name" });
  const problem = h("p", { class: "notice bad", hidden: true });
  const back = h("button", { class: "link small", type: "button" }, t("Save to Downloads instead"));
  const showPlace = () => {
    text.textContent = d.output || t("No folder chosen yet");
    text.title = d.output || "";
    back.hidden = !d.target || isDownloads(d.target);
  };
  const change = h(
    "button",
    {
      class: "btn browse",
      type: "button",
      "aria-label": t("Choose the folder to extract into"),
      onclick: async () => {
        if (!windowMode) return openLinkUnzipWindow("&change=1");
        problem.hidden = true;
        if (await chooseJobFolder(job, d, problem)) {
          showPlace();
          onChange();
        }
      },
    },
    t("Change..."),
  );
  back.addEventListener("click", async () => {
    if (await useDownloads(job, d)) {
      showPlace();
      onChange();
    }
  });
  showPlace();
  const choosing = windowMode && new URLSearchParams(location.search).has("change");
  return h(
    "div",
    { class: "field" },
    h("span", { class: compact ? "sr-only" : "label" }, label),
    h("div", { class: "path-row folder-row" }, change, text),
    h("div", { class: "folder-more" }, back),
    by,
    choosing ? h("p", { class: "muted small" }, t("Chrome doesn't let extensions pick Downloads, Desktop or Documents themselves: pick or make a folder inside one of them (Downloads > LinkUnzip, for example).")) : null,
    problem,
  );
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session") return;
  if (changes.jobs) st.jobs = changes.jobs.newValue || {};
  if ("current" in changes) st.current = changes.current.newValue || null;
  if (changes.engineInfo) st.hostInfo = changes.engineInfo.newValue || null;
  if (changes.hostInfo) st.helperInfo = changes.hostInfo.newValue || null;
  render();
});

function currentJob() {
  return st.current ? st.jobs[st.current] || null : null;
}

function render() {
  renderChip();
  const job = currentJob();
  // The rating line is decided just after the job is done, and an earlier unfinished run just
  // after the index is read: either redraws the view.
  const sig = job ? `${job.id}:${job.phase}${job.askRate ? ":rate" : ""}${job.earlier > 0 ? ":earlier" : ""}${job.caught ? ":caught" : ""}` : "pick";
  if (sig === drawn) {
    if (updater && job) updater(job);
    return;
  }
  const first = drawn === "";
  drawn = sig;
  updater = null;
  view.replaceChildren();
  const slot = document.getElementById("actions-slot");
  slot.replaceChildren();
  document.body.classList.remove("fill");
  jobLine(job);
  setStatus(statusText(job));
  const views = { inspecting: inspectingView, ready: readyView, extracting: extractingView, done: doneView, cancelled: cancelledView };
  if (!job) pickView();
  else (views[job.phase] || errorView)(job);
  // The view's buttons go in their strip under the scrolling middle.
  const bar = view.querySelector(":scope > .actions");
  if (bar) slot.append(bar);
  if (job && !first) announce(spokenState(job));
}

function statusText(job) {
  if (!job) return st.hostError ? t("Engine stopped") : t("Ready");
  const words = { inspecting: t("Reading index..."), ready: t("Ready"), extracting: t("Extracting"), done: t("Done"), cancelled: t("Stopped") };
  return words[job.phase] || t("Error");
}

/** Under the logo: which zip this is, and × to put it away (not while extracting: that is Stop). */
function jobLine(job) {
  const line = document.getElementById("job-line");
  line.hidden = !job;
  if (!job) return line.replaceChildren();
  const host = hostOf(job.url);
  // A zip inside a zip: the outer one's name first, and the way back to it.
  const name = job.parentId ? `${job.outerName} › ${job.name}` : job.name;
  line.replaceChildren(h("span", { class: "name", title: job.url }, host ? `${name} · ${host}` : name));
  if (job.parentId && st.jobs[job.parentId] && job.phase !== "extracting") {
    const back = t("Back to {zip}", { zip: job.outerName });
    line.prepend(h("button", { type: "button", title: back, "aria-label": back, onclick: () => send("back", { id: job.id }) }, "‹"));
  }
  if (job.phase !== "extracting") {
    line.append(h("button", { type: "button", title: t("Close this zip"), "aria-label": t("Close this zip"), onclick: () => send("dismiss", { id: job.id }) }, "✕"));
  }
}

/** Tell screen readers about a change without making the whole view a live region. */
function announce(text) {
  const region = document.getElementById("announce");
  region.textContent = "";
  if (text) requestAnimationFrame(() => (region.textContent = text));
}

/** One sentence for a job's new phase (errors announce themselves: their hero is an alert). */
function spokenState(job) {
  const r = job.report;
  switch (job.phase) {
    case "inspecting":
      return t("Reading the index of {zip}.", { zip: job.name });
    case "ready":
      return t("{zip}: {files}. Tick what you want, then Extract.", { zip: job.name, files: files(r.files) });
    case "extracting":
      return t("Extracting {zip}.", { zip: job.name });
    case "done":
      return t("Extracted {files}.", { files: files(job.result.files) });
    case "cancelled":
      return t("Stopped.");
    default:
      return "";
  }
}

function renderChip() {
  const chip = document.getElementById("host-chip");
  const [state, word, title] = st.hostError
    ? ["bad", t("Stopped"), st.hostError.message]
    : st.hostInfo
      ? ["ok", t("In browser"), t("LinkUnzip works right here in the browser: nothing to install")]
      : ["unknown", t("Starting..."), ""];
  chip.dataset.state = state;
  chip.title = title;
  chip.replaceChildren(`${t("Engine")} `, h("b", {}, word));
}

// ---------------------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------------------

async function start(url, pageUrl = "") {
  await send("inspect", { url, pageUrl });
}

async function findZipLinks() {
  if (document.body.classList.contains("window-mode")) return [];
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/i.test(tab.url || "")) return [];
  const found = [];
  if (/\.zip$/i.test(new URL(tab.url).pathname)) {
    found.push({ href: tab.url, text: t("This tab"), pageUrl: "" });
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const seen = new Map();
        for (const a of document.querySelectorAll("a[href]")) {
          let u;
          try {
            u = new URL(a.href, location.href);
          } catch {
            continue;
          }
          if (!/^https?:$/.test(u.protocol) || !/\.zip$/i.test(u.pathname)) continue;
          if (seen.has(u.href)) continue;
          seen.set(u.href, (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 70));
          if (seen.size >= 8) break;
        }
        return [...seen].map(([href, text]) => ({ href, text }));
      },
    });
    for (const l of result || []) found.push({ ...l, pageUrl: tab.url });
  } catch {
    // Pages Chrome does not let extensions read (chrome://, the Web Store): no suggestions.
  }
  return found.filter((l, i) => found.findIndex((o) => o.href === l.href) === i);
}

// ---------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------

function openSetup() {
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  window.close();
}

function hostBanner() {
  if (!st.hostError) return null;
  return h(
    "div",
    { class: "card" },
    h("p", {}, st.hostError.message),
    h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => location.reload() }, t("Try again"))),
  );
}

function pickView() {
  const input = h("input", {
    type: "url",
    placeholder: "https://example.com/archive.zip",
    spellcheck: "false",
    "aria-label": t("Link to a .zip file"),
  });
  const go = () => {
    const url = input.value.trim();
    if (url) start(url);
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  const list = h("div", { class: "card panel links", hidden: true });
  show(
    panel(
      h("h1", {}, t("Extract a ZIP without saving it")),
      h(
        "p",
        { class: "muted" },
        t("Paste a link to a .zip, or right-click one on any page. LinkUnzip reads the index first, then streams every file straight into a folder."),
      ),
      h("div", { class: "url-row" }, input, h("button", { class: "btn primary", onclick: go }, t("Inspect"))),
    ),
    hostBanner(),
    list,
  );
  input.focus();
  findZipLinks().then((links) => {
    if (!links.length || drawn !== "pick") return;
    list.hidden = false;
    list.append(
      h("h2", {}, t("ZIP links on this page")),
      ...links.map((l) =>
        h(
          "button",
          { class: "link-item", onclick: () => start(l.href, l.pageUrl) },
          h("span", { class: "l1" }, l.text || fileNameFromUrl(l.href)),
          h("span", { class: "l2" }, `${hostOf(l.href)} · ${fileNameFromUrl(l.href)}`),
        ),
      ),
    );
  });
}

function dismissBtn(label = t("Close")) {
  return h("button", { class: "btn", onclick: () => send("dismiss", { id: st.current }) }, label);
}

function inspectingView(job) {
  const note = h("p", { class: "muted small" }, t("Only the end of the file is fetched, not the whole zip."));
  // A big index (COCO's is about 12 MB) shows how far it got.
  const fill = h("div", {});
  const bar = h("div", { class: "progress-bar", role: "progressbar", "aria-label": t("Reading the index"), "aria-valuemin": "0", "aria-valuemax": "100", hidden: true }, fill);
  show(
    panel(
      h(
        "div",
        { class: "row" },
        h("div", { class: "spinner" }),
        h("div", {}, h("h1", {}, t("Reading the index...")), note),
      ),
      bar,
      h("div", { class: "file-head" }, h("span", { class: "name" }, job.name), h("span", { class: "meta" }, hostOf(job.url))),
    ),
    caughtNotice(job),
    actionBar([dismissBtn(t("Cancel"))]),
  );
  updater = (j) => {
    const p = j.indexProgress;
    if (!p?.total) return;
    const pct = Math.min(100, Math.floor((p.received / p.total) * 100));
    bar.hidden = false;
    fill.style.width = `${pct}%`;
    bar.setAttribute("aria-valuenow", String(pct));
    note.textContent = t("The zip's index: {received} of {total}. Only the index is fetched, not the whole zip.", { received: humanBytes(p.received), total: humanBytes(p.total) });
  };
  updater(job);
}

/**
 * A .zip download LinkUnzip caught is paused, not cancelled (a link may only work once): say so,
 * and let Chrome carry on with it instead.
 */
function caughtNotice(job) {
  if (job.caught?.downloadId == null) return null;
  return h(
    "div",
    { class: "notice" },
    h("p", { style: "margin:0 0 6px" }, t("Chrome's download of this zip is paused. It is cancelled once LinkUnzip has extracted the files; close this to leave it paused in Chrome's downloads.")),
    h("button", { class: "link", type: "button", onclick: () => send("continueDownload", { id: job.id }) }, t("Continue the download instead")),
  );
}

/**
 * Cost Analysis: one bar for what a normal download needs on disk, split into the files (all
 * LinkUnzip writes) and the zip itself (which LinkUnzip never saves), then the numbers. With only
 * some files ticked (`m`, the file list's measured selection) the numbers are for those files; a
 * normal download still needs the whole zip.
 */
function costSection(r, m = null) {
  const write = m ? m.extracted : r.linkunzip_needs;
  const normal = m ? r.archive_size + m.extracted : r.normal_needs;
  const download = m ? m.compressed : r.compressed;
  const fitsHere = m ? (r.free == null ? null : m.extracted <= r.free) : r.linkunzip_fits;
  const whole = Math.max(normal, 1);
  const files = Math.min(100, (write / whole) * 100);
  const zip = Math.max(0, Math.min(100 - files, (r.archive_size / whole) * 100));
  const saved = normal - write;
  let room = null;
  if (r.free != null && fitsHere != null) {
    room = fitsHere ? h("span", { class: "good" }, ` ${t("(Good)")}`) : h("span", { class: "bad" }, ` ${t("(Not enough)")}`);
  }
  return h(
    "section",
    { class: "cost compare", "aria-label": t("Cost Analysis") },
    h("div", { class: "sec-head" }, h("h2", {}, t("Cost Analysis")), saved > 0 ? h("span", { class: "badge" }, t("Saves {size}", { size: humanBytes(saved) })) : null),
    h(
      "div",
      { class: "cost-bar", "aria-hidden": "true" },
      h("div", { class: "seg extracted", style: `width:${files}%` }),
      h("div", { class: "seg zip", style: `width:${zip}%` }),
    ),
    h(
      "div",
      { class: "stats2" },
      h("span", { class: "files" }, h("i"), `${t("Files to write:")} `, h("b", { class: "cmp-total" }, humanBytes(write))),
      h("span", { class: "zip" }, h("i"), `${t("Zip, never saved:")} `, h("b", {}, humanBytes(r.archive_size))),
      h("span", {}, `${t("Zip on disk:")} `, h("b", {}, humanBytes(0))),
      h("span", {}, `${t("To download:")} `, h("b", {}, `~${humanBytes(download)}`)),
      h("span", {}, `${t("Normal download:")} `, h("b", { class: "cmp-total" }, humanBytes(normal))),
      r.free == null ? null : h("span", {}, `${t("Free space:")} `, h("b", {}, humanBytes(r.free)), room),
    ),
  );
}

function readyView(job) {
  const r = job.report;
  const d = draftFor(job);
  const fits = r.linkunzip_fits !== false;
  const problem = h("p", { class: "notice bad", hidden: true });

  const include = h("input", { type: "text", value: d.include, placeholder: t("e.g. *.dll, docs/*   (empty = everything)"), spellcheck: "false" });
  include.addEventListener("input", () => {
    d.include = include.value;
    updateGo();
    saveDrafts();
  });

  let selection = null; // from the file list: all, none, or select (+ measured)
  const nothing = () => Boolean(selection?.none) || selection?.measured?.files === 0;
  // With a measured selection, what has to fit is what will be written, not the whole zip.
  const fitsNow = () => {
    const m = selection?.measured;
    return m && r.free != null ? m.extracted <= r.free : fits;
  };
  // The button says what it will do: "Start Extraction (5,518 files, 925.6 MB)", "Filtered" once
  // only some files are ticked.
  const goLabel = () => {
    // Sent here from the toolbar popup, and Chrome still has to ask something: one click.
    if (windowMode && pendingFor(job) && !noPicker(d.target)) return d.target ? t("Allow and start extraction") : t("Choose folder and start");
    const some = Boolean(d.include.trim()) || (selection && !selection.all);
    const verb = some ? t("Start Filtered Extraction") : t("Start Extraction");
    if (nothing() || d.include.trim()) return verb;
    const m = selection?.measured || (!selection || selection.all ? { files: r.files, extracted: r.extracted } : null);
    return m ? t("{action} ({files}, {size})", { action: verb, files: files(m.files), size: humanBytes(m.extracted) }) : verb;
  };
  const go = h("button", { class: "btn primary", id: "extract-btn" }, t("Start Extraction"));
  // Into Downloads, say before it starts when Chrome will make it slow (thousands of files) or
  // ask about files one by one (.dll, .ini, ...), and offer a folder instead.
  const slow = h("p", { class: "notice slow-note", hidden: true });
  // What the ticked files are (null while unknown: a pattern, or not measured yet).
  const planned = () => {
    if (d.include.trim()) return null;
    if (!selection || selection.all) return r;
    return selection.measured || null;
  };
  const updateSlow = () => {
    const m = isDownloads(d.target) ? planned() : null;
    const secs = m ? m.files / DOWNLOADS_PER_SEC : 0;
    const many = secs >= SLOW_SECS;
    const held = m?.held_back || 0;
    slow.hidden = !many && !held;
    if (slow.hidden) return;
    const types = list((m.held_back_types || []).slice(0, 3).map((x) => `.${x}`));
    const heldWhat = t("{types} files until you click Keep on each one ({count} here)", { types, count: num(held) });
    const text = many
      ? [
          t("{files}: Chrome's downloads save about {rate} files a second, so saving them takes {time}.", { files: files(m.files), rate: DOWNLOADS_PER_SEC, time: roughly(secs) }),
          held ? t("Chrome also holds back {what}.", { what: heldWhat }) : "",
          held ? t("A folder you choose is much faster and doesn't ask.") : t("A folder you choose is much faster for this many files."),
        ]
          .filter(Boolean)
          .join(" ")
      : `${t("Chrome's downloads hold back {what}.", { what: heldWhat })} ${t("A folder you choose doesn't ask.")}`;
    slow.replaceChildren(`${text} `, h("button", { class: "link", type: "button", onclick: () => view.querySelector(".folder-row .btn")?.click() }, t("Choose a folder...")));
  };
  const updateGo = () => {
    go.disabled = nothing() || (!fitsNow() && !d.force);
    go.textContent = goLabel();
    updateSlow();
  };
  // Password-protected files: one field for the zip's password, asked before anything starts.
  const locked = r.encrypted > 0 ? passwordField(job, r.encrypted === r.files ? t("This zip is password-protected.") : tn("{count} of its files is password-protected.", "{count} of its files are password-protected.", r.encrypted)) : null;
  const request = (resume = false) => ({
    include: d.include.split(",").map((s) => s.trim()).filter(Boolean),
    select: selection?.select,
    connections: settings.connections,
    force: !fitsNow() && d.force,
    resume,
    password: typedPasswords.get(job.id) || undefined,
  });
  const extractNow = async (resume) => {
    problem.hidden = true;
    if (nothing()) {
      problem.textContent = t("Tick at least one file to extract.");
      problem.hidden = false;
      return;
    }
    await startExtraction(job, d, request(resume), problem);
  };
  go.addEventListener("click", () => extractNow(false));
  // An earlier extraction of this same zip into Downloads stopped part way: carry on from there.
  const earlier =
    job.earlier > 0
      ? h(
          "div",
          { class: "notice earlier", hidden: !isDownloads(d.target) },
          h("p", { style: "margin:0 0 6px" }, `${t("An earlier extraction of this zip into Downloads stopped after {files}.", { files: files(job.earlier) })} ${t("Resume skips what it already saved.")}`),
          h("button", { class: "link", type: "button", onclick: () => extractNow(true) }, t("Resume it")),
        )
      : null;
  // Sent here from the toolbar popup, and Chrome still has to ask something: say what.
  if (windowMode && pendingFor(job) && !noPicker(d.target)) {
    go.textContent = goLabel();
    problem.className = "notice";
    problem.textContent = d.target
      ? t("Chrome needs your OK once to let LinkUnzip save into {folder}. Click the button, then Allow.", { folder: d.output.split(" > ")[0] })
      : t("Choose where to save: pick or make a folder inside Downloads (Chrome doesn't let extensions use Downloads itself).");
    problem.hidden = false;
  }

  // The Cost Analysis follows the ticked files once the helper has measured them; with nothing
  // ticked, or while measuring, it keeps what it showed.
  let cost = costSection(r);
  const updateCost = () => {
    if (nothing() || (selection && !selection.all && !selection.measured)) return;
    const next = costSection(r, selection?.all ? null : selection?.measured);
    cost.replaceWith(next);
    cost = next;
  };

  const force = fits
    ? null
    : h(
        "label",
        { class: "check" },
        h("input", { type: "checkbox", checked: d.force, onchange: (e) => { d.force = e.target.checked; updateGo(); } }),
        h("span", {}, t("Try anyway"), h("small", {}, t("Extraction may stop when the disk fills up."))),
      );

  // Newer helpers list the zip's files: tick what to extract. The pattern filter stays for power
  // users: "Pattern..." next to Select all / none opens one line above the list, and its ✕ clears
  // the pattern and closes it again.
  const patternRow = h("div", { class: "pattern-row", hidden: !d.include });
  const showPattern = (open) => {
    patternRow.hidden = !open;
    patternBtn.setAttribute("aria-expanded", String(open));
  };
  const patternBtn = h(
    "button",
    {
      type: "button",
      class: "link small",
      "aria-expanded": String(!patternRow.hidden),
      onclick: () => {
        showPattern(true);
        include.focus();
      },
    },
    t("Pattern..."),
  );
  const clearPattern = h(
    "button",
    {
      type: "button",
      class: "clear",
      title: t("Clear the pattern"),
      "aria-label": t("Clear the pattern"),
      onclick: () => {
        include.value = d.include = "";
        showPattern(false);
        updateGo();
        saveDrafts();
        patternBtn.focus();
      },
    },
    "✕",
  );
  const chooser =
    hasFeature("list") && hasFeature("select")
      ? fileList({
          job,
          draft: d,
          features: { search: hasFeature("search"), measure: hasFeature("measure"), preview: hasFeature("preview"), tickMatches: hasFeature("tick_matches"), inner: hasFeature("inner") && (job.inner?.length || 0) < 4 },
          api: {
            list: (dir, offset, limit) => send("list", { id: job.id, dir, offset, limit }),
            search: (query) => send("search", { id: job.id, query }),
            measure: (select) => send("measure", { id: job.id, select }),
            preview: (path) => send("preview", { id: job.id, path }),
            open: (path) => send("openInner", { id: job.id, path }),
            tickMatches: (marks, query, ticked) => send("tickMatches", { id: job.id, marks, query, ticked }),
          },
          onChange: (sel) => {
            selection = sel;
            updateGo();
            updateCost();
            saveDrafts();
          },
          actions: [patternBtn],
          toolbar: patternRow,
        })
      : null;
  updateGo();
  let filter = null;
  if (chooser) {
    include.id = `pattern-${job.id}`;
    include.placeholder = "*.dll, docs/*";
    patternRow.append(h("label", { for: include.id }, t("Only files matching")), include, clearPattern);
  } else {
    filter = h("label", { class: "field" }, h("span", {}, t("Only these files (optional)")), include);
  }

  const bar = actionBar([
    go,
    // A zip inside a zip has no link of its own to download normally.
    job.parentId
      ? null
      : job.caught?.downloadId != null
        ? h("button", { class: "btn", onclick: () => send("continueDownload", { id: job.id }) }, t("Continue Download"))
        : h("button", { class: "btn", onclick: () => send("downloadNormally", { url: job.url }) }, t("Download Normal ZIP (Fallback)")),
    h("button", { class: "btn cancel", onclick: () => send("dismiss", { id: job.id }) }, t("Cancel")),
  ]);
  bar.prepend(...[force, slow, problem].filter(Boolean));

  // With the file list the panel fills the popup and the list takes the height that is left.
  if (chooser) document.body.classList.add("fill");
  show(
    h("div", { class: "card main" }, cost, chooser?.el),
    r.unsupported > 0
      ? h("p", { class: "notice" }, `${tn("{count} file uses encryption or a compression LinkUnzip cannot read (e.g. {name}).", "{count} files use encryption or a compression LinkUnzip cannot read (e.g. {name}).", r.unsupported, { name: r.unsupported_sample[0].name })} ${chooser ? t("Untick them or use the filter to skip them.") : t("Use the filter to skip them.")}`)
      : null,
    filter,
    caughtNotice(job),
    locked,
    earlier,
    folderField(t("Extract into"), d, job, {
      compact: true,
      onChange: () => {
        problem.hidden = true;
        if (earlier) earlier.hidden = !isDownloads(d.target);
        updateGo();
      },
    }),
    bar,
  );
}

function extractingView(job) {
  const refs = {
    pct: h("div", { class: "big-pct" }, "0%"),
    bar: h("div", {}),
    sub: h("p", { class: "muted small" }, t("Reading the index and planning...")),
    files: h("b", {}, "-"),
    speed: h("b", {}, "-"),
    eta: h("b", {}, "-"),
    now: h("p", { class: "now" }, " "),
    zip: h("b", { class: "zero" }, humanBytes(0)),
    extracted: h("b", {}, humanBytes(0)),
    free: h("b", {}, "-"),
    freeLabel: h("span", {}, t("Free space")),
  };
  const stat = (label, el) => h("div", { class: "stat" }, el, h("span", {}, label));
  show(
    panel(
      h("p", { class: "path" }, t("Into {folder}", { folder: job.output })),
      isDownloads(job.target) && job.via !== "helper"
        ? h("p", { class: "muted small" }, t("Saving through Chrome's downloads (its download list stays quiet meanwhile). You can close this popup: LinkUnzip carries on."))
        : windowMode && job.via !== "helper"
          ? h("p", { class: "muted small" }, t("Keep this window open until LinkUnzip is done. You can minimise it."))
          : null,
      h("div", { class: "row", style: "justify-content:space-between" }, h("div", {}, h("h2", { style: "margin:0 0 4px" }, t("Extracting")), refs.pct), h("div", { class: "spinner", "aria-hidden": "true" })),
      h("div", { class: "progress-bar", role: "progressbar", "aria-label": t("Extraction progress"), "aria-valuemin": "0", "aria-valuemax": "100" }, refs.bar),
      refs.sub,
      h("div", { class: "stat-grid" }, stat(t("files"), refs.files), stat(t("speed"), refs.speed), stat(t("time left"), refs.eta)),
      refs.now,
      h("div", { class: "statusline" },
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", {}, t("Zip stored on disk")), refs.zip),
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", {}, t("Extracted so far")), refs.extracted),
        h("div", { class: "row", style: "justify-content:space-between" }, refs.freeLabel, refs.free),
      ),
    ),
    actionBar([h("button", { class: "btn danger", onclick: () => send("cancel", { id: job.id }) }, t("Stop"))]),
  );
  let spokenQuarter = 0; // screen readers hear 25 %, 50 %, 75 %, not every update
  updater = (j) => {
    const p = j.progress;
    if (!p) return;
    // Sequential mode from a server that does not announce the file size has no total.
    const known = p.total_compressed > 0;
    const bar = refs.bar.parentElement;
    bar.classList.toggle("indeterminate", !known);
    // A resumed job counts the files already in the folder as done, so the bar carries on from
    // where it stopped instead of starting again at 0 %.
    const skipped = { files: p.skipped_files || 0, compressed: p.skipped_compressed || 0, extracted: p.skipped_extracted || 0 };
    const whole = p.total_compressed + skipped.compressed;
    const pct = known ? Math.min(100, ((p.downloaded + skipped.compressed) / whole) * 100) : 0;
    refs.pct.textContent = known ? t("{n}%", { n: num(Math.floor(pct)) }) : humanBytes(p.downloaded);
    setStatus(t("Extracting {progress}", { progress: refs.pct.textContent }));
    if (known) {
      refs.bar.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(Math.floor(pct)));
      const quarter = Math.floor(pct / 25);
      if (quarter > spokenQuarter && quarter < 4) {
        spokenQuarter = quarter;
        announce(t("{n} percent extracted.", { n: quarter * 25 }));
      }
    } else {
      bar.removeAttribute("aria-valuenow");
      bar.setAttribute("aria-valuetext", t("{size} downloaded", { size: humanBytes(p.downloaded) }));
    }
    const retried = p.retries ? ` · ${t("{count} retried", { count: num(p.retries) })}` : "";
    if (!known) refs.sub.textContent = `${t("downloaded so far · read in one pass")}${retried}`;
    else if (skipped.files) {
      refs.sub.textContent = `${tn("Resumed: {count} file was already there", "Resumed: {count} files were already there", skipped.files)} · ${t("{done} of the remaining {total} downloaded", { done: humanBytes(p.downloaded), total: humanBytes(p.total_compressed) })}${retried}`;
    } else refs.sub.textContent = `${t("{done} of {total} downloaded", { done: humanBytes(p.downloaded), total: humanBytes(p.total_compressed) })}${retried}`;
    const filesDone = p.files_done + skipped.files;
    const filesAll = p.total_files + skipped.files;
    refs.files.textContent = p.total_files ? `${num(filesDone)} / ${num(filesAll)}` : num(filesDone);
    refs.speed.textContent = `${humanBytes(p.rate)}/s`;
    refs.eta.textContent = clock(p.eta_secs);
    const more = p.active_count > p.active.length ? ` ${t("(+{count} more)", { count: num(p.active_count - p.active.length) })}` : "";
    refs.now.textContent = p.active.length ? t("now: {files}", { files: `${p.active.join(", ")}${more}` }) : " ";
    refs.zip.textContent = humanBytes(p.zip_on_disk);
    refs.extracted.textContent = humanBytes(p.extracted + skipped.extracted);
    refs.free.parentElement.hidden = p.free == null;
    refs.free.textContent = p.free == null ? "?" : humanBytes(p.free);
    refs.freeLabel.textContent = j.report?.drive ? t("Free space on {drive}", { drive: j.report.drive }) : t("Free space");
  };
  const p0 = job.progress; // opened part way through: no catching up on missed quarters
  if (p0?.total_compressed > 0) {
    const before = p0.skipped_compressed || 0;
    spokenQuarter = Math.floor(((p0.downloaded + before) / (p0.total_compressed + before)) * 4);
  }
  updater(job);
}

function doneView(job) {
  const r = job.result;
  const saved = r.normal_needs - r.extracted_bytes;
  // Newer helpers say how many files they checked (size + CRC-32) and which were already there.
  const intoDownloads = isDownloads(job.target) && job.via !== "helper";
  const verified =
    r.verified_files == null
      ? null
      : r.verified_files === r.files && r.files > 1
        ? `✓ ${t("All {files} verified", { files: files(r.files) })}`
        : `✓ ${t("{files} verified", { files: files(r.verified_files) })}`;
  show(
    panel(
      job.askRate ? rateLine(job) : null,
      h("div", { class: "hero" }, h("div", { class: "tick", "aria-hidden": "true" }, "✓"), h("h1", {}, t("Extracted {files}", { files: files(r.files) })), h("p", { class: "muted" }, t("in {time} · {size} written", { time: humanDuration(r.elapsed_ms), size: humanBytes(r.extracted_bytes) }))),
      verified ? h("p", { class: "verified" }, verified, h("span", { class: "muted small" }, ` ${t("(size and CRC-32 checked)")}`)) : null,
      r.skipped_existing > 0
        ? h("p", { class: "muted small" }, r.skipped_bytes ? t("Skipped {files} already in the folder ({size}, not downloaded again).", { files: files(r.skipped_existing), size: humanBytes(r.skipped_bytes) }) : t("Skipped {files} already in the folder.", { files: files(r.skipped_existing) }))
        : null,
      h("div", { class: "zero-line" }, h("span", {}, t("Zip stored on disk")), h("b", {}, humanBytes(r.zip_bytes_on_disk))),
      h("dl", { class: "kv" },
        h("dt", {}, t("Downloaded")), h("dd", {}, r.stream ? t("{size} in one pass", { size: humanBytes(r.downloaded_bytes) }) : tn("{size} in {count} request", "{size} in {count} requests", r.requests, { size: humanBytes(r.downloaded_bytes) })),
        r.index_bytes > 0 ? h("dt", {}, t("of which the zip's index")) : null, r.index_bytes > 0 ? h("dd", {}, humanBytes(r.index_bytes)) : null,
        h("dt", {}, t("A normal download needs")), h("dd", {}, humanBytes(r.normal_needs)),
        h("dt", {}, t("Disk space saved")), h("dd", { class: "accent" }, humanBytes(saved)),
        r.retries ? h("dt", {}, t("Network retries")) : null, r.retries ? h("dd", {}, num(r.retries)) : null,
        r.renamed ? h("dt", {}, intoDownloads ? t("Renamed for Chrome") : t("Renamed for Windows")) : null, r.renamed ? h("dd", {}, files(r.renamed)) : null,
      ),
      r.renamed && r.renamed_sample?.length
        ? h("p", { class: "muted small" }, `${intoDownloads ? t("Chrome's downloads don't take some names, like .gitignore or names with ~, so they got a _:") : t("Names Windows can't store got a _:")} ${r.renamed_sample.map(([from, to]) => t("{from} became {to}", { from, to })).join(", ")}${r.renamed > r.renamed_sample.length ? ", ..." : ""}`)
        : null,
      r.held > 0 ? heldNotice(r) : null,
      r.other_password > 0
        ? h("p", { class: "notice" }, tn(
            "{count} file in this zip has another password, so it was left out: {names}. Extract it again with that password.",
            "{count} files in this zip have another password, so they were left out: {names}. Extract them again with that password.",
            r.other_password,
            { names: `${r.other_password_sample.map((n) => n.split("/").pop()).join(", ")}${r.other_password > r.other_password_sample.length ? ", ..." : ""}` },
          ))
        : null,
      r.listing_differs > 0
        ? h("p", { class: "notice" }, tn(
            "The zip's own index lists {count} file differently from the data that came ({names}). Other zip programs may show it with another size or content.",
            "The zip's own index lists {count} files differently from the data that came ({names}). Other zip programs may show them with another size or content.",
            r.listing_differs,
            { names: r.listing_differs_sample.join(", ") },
          ))
        : null,
      h("p", { class: "path" }, t("In {folder}", { folder: r.output })),
    ),
    actionBar([
      job.via === "helper" ? h("button", { class: "btn primary", onclick: () => send("reveal", { path: r.output }) }, t("Open folder")) : null,
      intoDownloads ? h("button", { class: "btn primary", onclick: () => send("openFolder", { id: job.id }) }, t("Open folder")) : null,
      h("button", { class: job.via === "helper" || intoDownloads ? "btn" : "btn primary", onclick: () => send("dismiss", { id: st.current }) }, t("Extract another")),
    ]),
  );
}

/**
 * Files Chrome's downloads held back: it asks about types like .dll or .ini from any download, or
 * a virus scan blocked one. Keep asks Chrome for each file in turn (one question per file).
 */
function heldNotice(r) {
  const names = (r.held_sample || []).map((f) => f.name.split("/").pop());
  const shown = r.held > names.length ? list([...names, t("{count} more", { count: num(r.held - names.length) })]) : list(names);
  const one = r.held === 1;
  const status = h("p", { class: "small", style: "margin:6px 0 0", role: "status" });
  const keep = h("button", { class: "link", type: "button" }, one ? t("Keep it") : t("Keep them"));
  keep.addEventListener("click", async () => {
    keep.disabled = true;
    let kept = 0;
    for (const id of r.held_ids || []) {
      const [item] = await chrome.downloads.search({ id }).catch(() => []);
      if (!item || item.state !== "in_progress") continue;
      // Chrome shows its own question for each file; nothing is kept without the user's click.
      await chrome.downloads.acceptDanger(id).catch(() => {});
      const [after] = await chrome.downloads.search({ id }).catch(() => []);
      if (after && after.danger === "accepted") kept += 1;
    }
    status.textContent = t("{kept} of {held} kept.", { kept: num(kept), held: num(r.held) });
    keep.disabled = false;
  });
  return h(
    "div",
    { class: "notice" },
    h("p", { style: "margin:0 0 6px" }, tn(
      "Chrome held back {count} file until you say to keep it: {names}. It checked out (size and CRC-32); Chrome asks about files like these from any download.",
      "Chrome held back {count} files until you say to keep them: {names}. They checked out (size and CRC-32); Chrome asks about files like these from any download.",
      r.held,
      { names: shown },
    )),
    h("div", { class: "row", style: "gap:14px" }, keep, h("button", { class: "link", type: "button", onclick: () => chrome.tabs.create({ url: "chrome://downloads" }) }, t("Open Chrome's downloads"))),
    status,
  );
}

/** Asked once, ever (rateCheck in config.js). Either answer removes it for good. */
function rateLine(job) {
  const answer = (open) => {
    line.remove();
    send("rate", { id: job.id, open });
  };
  const line = h(
    "div",
    { class: "rate", role: "note" },
    h("p", {}, h("b", {}, t("Worked well?")), ` ${t("A rating on the Chrome Web Store helps other people find LinkUnzip.")}`),
    h(
      "div",
      { class: "row" },
      h("button", { class: "link", onclick: () => answer(true) }, t("Rate it")),
      h("button", { class: "link quiet", onclick: () => answer(false) }, t("No thanks")),
    ),
  );
  return line;
}

/** Resume a stopped or failed extraction: only helpers with `resume` skip what is already there. */
const canResume = (job) => Boolean(job.lastExtract) && hasFeature("resume");

/** In the window, after the toolbar popup handed over a Resume or Extract here: what's left. */
function handoverNotice(job, d, button) {
  if (!windowMode || !pendingFor(job)) return null;
  return h(
    "p",
    { class: "notice" },
    d.target
      ? t("Chrome needs your OK once to let LinkUnzip save into {folder}. Click {button}, then Allow.", { folder: d.output.split(" > ")[0], button })
      : t("Choose where to save, then click {button}. Pick or make a folder inside Downloads (Chrome doesn't let extensions use Downloads itself).", { button }),
  );
}

/** The last extraction's settings, to run it again (Resume, Extract here). */
function extractAgain(job) {
  const { include, select, connections, force, stream } = job.lastExtract || {};
  return { include, select, connections, force, stream };
}

function cancelledView(job) {
  const r = job.result || {};
  const resume = canResume(job);
  const d = draftFor(job);
  const problem = h("p", { class: "notice bad", hidden: true });
  show(
    panel(
      h(
        "div",
        { class: "hero" },
        h("div", { class: "tick bad", "aria-hidden": "true" }, "■"),
        h("h1", {}, t("Stopped")),
        h("p", { class: "muted" }, `${tn("{count} file was already finished and stays in the folder.", "{count} files were already finished and stay in the folder.", r.files_done || 0)} ${t("Half-written files were removed.")}`),
      ),
      resume
        ? h(
            "p",
            { class: "muted small" },
            isDownloads(job.target)
              ? t("Resume carries on into the same folder: the files LinkUnzip already saved are skipped, not downloaded again.")
              : t("Resume carries on into the same folder: files already there are checked and skipped, not downloaded again."),
          )
        : null,
      handoverNotice(job, d, t("Resume")),
      problem,
    ),
    actionBar([
      resume ? h("button", { class: "btn primary", onclick: () => startExtraction(job, d, { ...extractAgain(job), resume: true }, problem) }, t("Resume")) : null,
      r.output && job.via === "helper" ? h("button", { class: "btn", onclick: () => send("reveal", { path: r.output }) }, t("Open folder")) : null,
      dismissBtn(t("Close")),
    ]),
  );
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

// What using a login means, said before it is used (store policy: disclose first).
const loginUse = (host) =>
  t("your browser sends its cookies for {host} with LinkUnzip's requests to {host}, and only there. Nothing goes to LinkUnzip itself.", { host });

const accessRefused = () => t("No problem. Without access to this site LinkUnzip can't read the zip, but you can still download it normally.");

/**
 * What each error code looks like: a title, a sentence or two, and what to offer (the first
 * action is the main button). Codes this version does not know get the helper's own message.
 */
function describeError(job, e) {
  const host = hostOf(job.url);
  const status = e.http_status ? ` (HTTP ${e.http_status})` : "";
  // A login only helps if none was sent; the user can turn the offer off in Settings.
  const offerLogin = !job.loginSent && settings.loginWhenNeeded && Boolean(sitePattern(job.url));
  switch (e.code) {
    case "site_access":
      return {
        title: t("Allow LinkUnzip to read {host}", { host }),
        text: t("To read the zip without downloading all of it, LinkUnzip needs Chrome's permission to fetch files from {host}. It only connects there when you give it a link.", { host }),
        more: t("Tip: Settings > Read zip links on every site saves you this step for every new site."),
        actions: ["access", "download"],
      };
    case "ask_where":
      return {
        title: t("Chrome asks where to save each download"),
        text: t("Chrome is set to ask where to save every file, so it would ask once for each file in this zip."),
        more: t("Turn off \"Ask where to save each file before downloading\" in Chrome's download settings and try again, or choose a folder for LinkUnzip instead."),
        folder: true,
        actions: ["chromeSettings", "extractHere"],
      };
    case "folder_permission":
      return { title: t("LinkUnzip needs to write into the folder again"), text: t("Chrome needs your OK again to let LinkUnzip write into this folder."), more: t("Chrome asks again after the browser restarts. Click Extract here and choose Allow."), folder: true, actions: ["extractHere"] };
    case "no_folder":
      return { title: t("Choose a folder"), text: t("Pick the folder LinkUnzip should extract into."), folder: true, actions: ["extractHere"] };
    case "too_big":
      return { title: t("This zip's index is too big for the browser"), text: e.message, actions: ["download"] };
    case "host_missing":
    case "host_forbidden":
      return { title: t("This needs the LinkUnzip helper for Windows"), text: e.message, actions: ["setup", "download"] };
    case "host":
    case "host_silent":
      return { title: t("LinkUnzip stopped"), text: e.message, actions: ["retry", "download"] };
    case "no_range":
      return {
        title: t("This server sends the zip only from the start"),
        text: t("It can't send parts of the file (like GitHub's Download ZIP, which builds the zip while it sends it), so there is no file list first. LinkUnzip can still extract all of it in one pass."),
        more: t("One connection, no size before it starts, and the zip is still never saved. Every file is checked as it arrives."),
        folder: true,
        actions: ["stream", "download"],
      };
    case "inner_compressed":
      return {
        title: t("This zip inside the zip can only be read in one pass"),
        text: t("It is compressed inside the outer zip, so LinkUnzip can't read just its index first."),
        more: t("One pass reads it from its first byte to its last, through the outer zip. Every file is checked as it arrives."),
        folder: true,
        actions: ["stream"],
      };
    case "password_needed":
      return { title: t("This zip is password-protected"), text: t("Type its password to extract the protected files."), password: true, folder: true, actions: ["withPassword"] };
    case "password_wrong":
      return { title: t("That password doesn't fit"), text: t("LinkUnzip checked it on the first protected file before writing anything. Try again."), password: true, folder: true, actions: ["withPassword"] };
    case "html_page":
      return {
        title: t("This link opens a web page, not the file"),
        text: t("The link answered with a web page instead of the zip. Sites like Google Drive or Dropbox show a page first: open the link, then right-click the page's own download button and choose Extract with LinkUnzip."),
        more: offerLogin ? t("If that page asks you to sign in, LinkUnzip can use your login on {host}: {how}", { host, how: loginUse(host) }) : null,
        actions: offerLogin ? ["login", "open", "download"] : ["open", "download"],
      };
    case "needs_login":
      if (offerLogin) {
        return {
          title: t("This download needs your login on {host}", { host }),
          text: t("The site says you need to be signed in. LinkUnzip can use your login on {host}: {how} It starts again right away.", { host, how: loginUse(host) }),
          actions: ["login", "download"],
        };
      }
      return {
        title: t("This download needs your login on {host}", { host }),
        text: job.loginSent
          ? t("LinkUnzip sent your login, but the site still says no. Open the link, sign in on the page, then try again.")
          : t("The site says you need to be signed in. Turn on 'Use my login when a site needs it' in Settings, or download the file normally."),
        actions: job.loginSent ? ["open", "retry", "download"] : ["download"],
      };
    case "link_expired":
      return {
        title: t("This link has expired"),
        text: t("Links like this one only work for a while{status}. Go back to the page, get a fresh link and right-click it again.", { status }),
        actions: job.pageUrl ? ["page"] : [],
      };
    case "not_found":
      return {
        title: t("The file is gone from the server"),
        text: t("{host} says there is nothing at this link{status}. It may be old, moved, or mistyped.", { host, status }),
        actions: ["open"],
      };
    case "not_zip":
      return {
        title: t("This file isn't a ZIP"),
        text: t("LinkUnzip only reads .zip archives, and this link gives something else. You can still download it normally."),
        actions: ["download"],
      };
    case "server_error":
      return {
        title: t("{host} had a problem", { host }),
        text: t("The server kept answering with an error{status}. This is usually temporary: try again in a minute.", { status }),
        actions: ["retry", "download"],
      };
    case "redirect_access":
      if (job.allSites !== true) {
        return {
          title: t("{host} sends the download on to another site", { host }),
          text: t("The link redirects to another server, as many download links do, and LinkUnzip may only read the sites you allowed. Allow every site so it can follow the link."),
          more: t("LinkUnzip still only connects to the sites your links lead to."),
          actions: ["accessAll", "download"],
        };
      }
    // falls through: with every site allowed, it really was the connection
    case "network":
      if (job.allSites === false) {
        return {
          title: t("Can't read from {host}", { host }),
          text: t("Check your internet connection (or VPN or proxy), then try again."),
          more: t("If the link sends the download on to another site (many download links do), LinkUnzip needs permission to read there too. Allowing every site covers that."),
          actions: ["accessAll", "retry"],
        };
      }
      return {
        title: t("Can't reach {host}", { host }),
        text: t("Check your internet connection (or VPN or proxy), then try again."),
        actions: ["retry"],
      };
    case "disk_full":
      return {
        title: t("Not enough free space"),
        text: t("The drive is full."),
        more: t("Choose a folder on a drive with more room."),
        folder: true,
        actions: ["extractHere"],
      };
    case "folder_not_writable":
      if (isDownloads(job.target)) {
        return {
          title: t("Couldn't save into Downloads"),
          text: e.message,
          more: t("Try again, or choose a folder for LinkUnzip instead."),
          folder: true,
          actions: ["extractHere"],
        };
      }
      return {
        title: t("Can't write to this folder"),
        text: t("Windows didn't let LinkUnzip create files there (no permission, or the path is too long). Choose another folder."),
        more: e.message,
        folder: true,
        actions: ["extractHere"],
      };
    case "unsupported_entries":
      return { title: t("LinkUnzip can't read these files"), text: e.message, actions: ["download"] };
    case "internal":
      return {
        title: t("LinkUnzip hit a bug"),
        text: t("Nothing more was written. Copy the details and send them to the LinkUnzip developers so it can be fixed."),
        actions: ["copy", "retry"],
      };
    default:
      return { title: t("Couldn't extract this"), text: e.message || t("Something went wrong."), actions: ["download"] };
  }
}

/** Never the path or query of a link in what people copy: they can hold sign-in tokens. */
function scrubUrls(text) {
  return String(text).replace(/\b(https?:\/\/[^\s/?#"'<>()]+)[^\s"'<>()]*/gi, "$1/...");
}

/** Browser name and version, and the OS, as precisely as Chrome tells extensions. */
async function browserAndOs() {
  try {
    const v = await navigator.userAgentData.getHighEntropyValues(["fullVersionList", "platformVersion"]);
    const brands = v.fullVersionList || [];
    const brand = brands.find((b) => !/not.?a.?brand|chromium/i.test(b.brand)) || brands.find((b) => /chromium/i.test(b.brand));
    let os = v.platform || "unknown";
    if (os === "Windows") {
      // Chrome reports Windows 11 as platform version 13 and up.
      const major = parseInt(v.platformVersion, 10);
      os = `${major >= 13 ? "Windows 11" : major > 0 ? "Windows 10" : "Windows"} (${v.platformVersion})`;
    }
    return { browser: brand ? `${brand.brand} ${brand.version}` : navigator.userAgent, os };
  } catch {
    return { browser: navigator.userAgent, os: st.hostInfo?.os || "unknown" };
  }
}

async function detailsText(job, e) {
  const { browser, os } = await browserAndOs();
  const helper = st.helperInfo ? `${st.helperInfo.version} (protocol ${st.helperInfo.protocol ?? 1})` : "not installed";
  return [
    `LinkUnzip extension ${chrome.runtime.getManifest().version}`,
    `Engine: ${job.via === "helper" ? "helper" : "browser"}`,
    `Helper: ${helper}`,
    `Browser: ${browser}`,
    `OS: ${os}`,
    `Error: ${e.code || "unknown"}`,
    e.http_status ? `HTTP status: ${e.http_status}` : null,
    `Host: ${e.host || hostOf(job.url) || "none"}`,
    `While: ${job.failedWhile === "extract" ? "extracting" : "reading the index"}`,
    `Detail: ${scrubUrls(e.detail || e.message || "none")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function copyDetailsBtn(job, e, cls) {
  const btn = h("button", { class: cls }, t("Copy details"));
  btn.addEventListener("click", async () => {
    const text = await detailsText(job, e);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = t("Copied");
      announce(t("Details copied."));
    } catch {
      btn.textContent = t("Couldn't copy");
    }
    setTimeout(() => (btn.textContent = t("Copy details")), 2000);
  });
  return btn;
}

/** Ask Chrome for this job's site (it needs this click), then the background runs the job again. */
function askForAccess(job, note) {
  send("awaitAccess", { id: job.id }); // in case Chrome's prompt closes this popup
  chrome.permissions.request({ origins: [sitePattern(job.url)] }).then(
    (granted) => {
      if (!granted) note.textContent = accessRefused();
      send("accessAnswer", { id: job.id, granted });
    },
    () => send("accessAnswer", { id: job.id, granted: false }),
  );
}

function errorView(job) {
  const e = job.error || { code: "failed", message: t("Something went wrong.") };
  const info = describeError(job, e);
  const host = hostOf(job.url);
  const web = /^https?:/i.test(job.url);
  const d = draftFor(job);
  const note = h("p", { class: "muted small", role: "status" }, job.accessRefused ? accessRefused() : "");
  const problem = h("p", { class: "notice bad", hidden: true });

  const actions = {
    setup: () => h("button", { onclick: openSetup }, t("Get the helper")),
    access: () => h("button", { onclick: () => askForAccess(job, note) }, t("Allow {host}", { host })),
    accessAll: () =>
      h("button", {
        onclick: () => {
          send("awaitAccess", { id: job.id });
          chrome.permissions.request(ALL_SITES).then(
            (granted) => send("accessAnswer", { id: job.id, granted }),
            () => send("accessAnswer", { id: job.id, granted: false }),
          );
        },
      }, t("Allow every site")),
    // One pass from the first byte, into the folder in the field.
    stream: () =>
      h("button", {
        onclick: () => startExtraction(job, d, { include: [], connections: 1, stream: true, password: typedPasswords.get(job.id) || undefined }, problem),
      }, t("Extract everything (one pass)")),
    // The last extraction again, now with the password in the field.
    withPassword: () =>
      h("button", {
        onclick: () => {
          const password = typedPasswords.get(job.id);
          if (!password) {
            problem.textContent = t("Type the password first.");
            problem.hidden = false;
            return;
          }
          startExtraction(job, d, { ...extractAgain(job), password }, problem);
        },
      }, t("Extract")),
    // The same extraction as before, into the folder now in the field.
    extractHere: () =>
      h("button", {
        onclick: () => (job.lastExtract ? startExtraction(job, d, extractAgain(job), problem) : send("retry", { id: job.id })),
      }, isDownloads(d.target) ? t("Try again") : t("Extract here")),
    chromeSettings: () => h("button", { onclick: () => chrome.tabs.create({ url: "chrome://settings/downloads" }) }, t("Open Chrome's download settings")),
    login: () => h("button", { onclick: () => send("useLogin", { id: job.id }) }, t("Use my login on {host}", { host })),
    retry: () => h("button", { onclick: () => send("retry", { id: job.id }) }, t("Try again")),
    resume: () => h("button", { onclick: () => startExtraction(job, d, { ...extractAgain(job), resume: true }, problem) }, t("Resume")),
    open: () => (web ? h("button", { onclick: () => chrome.tabs.create({ url: job.url }) }, t("Open link")) : null),
    page: () => h("button", { onclick: () => chrome.tabs.create({ url: job.pageUrl }) }, t("Open the page")),
    download: () =>
      job.caught?.downloadId != null
        ? h("button", { onclick: () => send("continueDownload", { id: job.id }) }, t("Continue the download"))
        : web
          ? h("button", { onclick: () => send("downloadNormally", { url: job.url }) }, t("Download normally"))
          : null,
    copy: () => copyDetailsBtn(job, e, "btn"),
  };
  // An extraction that failed part way can carry on where it stopped (not for setup problems).
  let wanted = info.actions;
  if (job.failedWhile === "extract" && canResume(job) && !["host_missing", "host_forbidden", "password_needed", "password_wrong"].includes(e.code)) {
    wanted = wanted.filter((a) => a !== "retry");
    const keepFirst = ["extractHere", "login", "copy"].includes(wanted[0]);
    wanted = keepFirst ? [wanted[0], "resume", ...wanted.slice(1)] : ["resume", ...wanted];
  }
  const buttons = wanted.map((a) => actions[a]()).filter(Boolean);
  buttons.forEach((b, i) => (b.className = i === 0 ? "btn primary" : "btn"));

  show(
    panel(
      h(
        "div",
        { class: "hero", role: "alert" },
        h("div", { class: "tick bad", "aria-hidden": "true" }, "!"),
        h("h1", {}, info.title),
        h("p", { class: "muted" }, info.text),
      ),
      info.more ? h("p", { class: "muted small" }, info.more) : null,
      note,
      info.password ? passwordField(job, t("Password"), { onEnter: () => buttons[0]?.click() }) : null,
      info.folder ? folderField(t("Extract into"), d, job) : null,
      handoverNotice(job, d, buttons[0]?.textContent || t("the button")),
      problem,
    ),
    actionBar([...buttons, dismissBtn()], [wanted.includes("copy") ? null : copyDetailsBtn(job, e, "link quiet")]),
  );
}

// ---------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------

function setupSettings() {
  const panel = document.getElementById("settings");
  const button = document.getElementById("settings-btn");
  const fields = {
    connections: document.getElementById("set-jobs"),
    loginWhenNeeded: document.getElementById("set-login"),
    loginEverywhere: document.getElementById("set-login-all"),
    catchDownloads: document.getElementById("set-catch"),
    useHelper: document.getElementById("set-helper"),
  };
  const save = () => {
    settings = {
      ...settings,
      connections: Math.min(16, Math.max(1, Number(fields.connections.value) || 4)),
      loginWhenNeeded: fields.loginWhenNeeded.checked,
      loginEverywhere: fields.loginEverywhere.checked,
      catchDownloads: fields.catchDownloads.checked,
      useHelper: fields.useHelper.checked,
    };
    chrome.storage.local.set({ settings });
    showHelper();
    // Where a waiting zip goes, and who extracts it, may have changed.
    drawn = "";
    render();
  };

  // Light / dark: the header button flips what is on screen; Settings can also go back to
  // following Windows.
  const themeBtn = document.getElementById("theme-btn");
  const themeRadios = [...document.querySelectorAll('#set-theme input[name="theme"]')];
  const showTheme = () => {
    for (const radio of themeRadios) radio.checked = radio.value === settings.theme;
    const dark = effectiveTheme(settings.theme) === "dark";
    // SVG elements have no `hidden` property, only the attribute.
    themeBtn.querySelector(".moon").toggleAttribute("hidden", dark);
    themeBtn.querySelector(".sun").toggleAttribute("hidden", !dark);
    const label = dark ? t("Switch to light mode") : t("Switch to dark mode");
    themeBtn.title = label;
    themeBtn.setAttribute("aria-label", label);
  };
  const setTheme = (theme) => {
    settings = { ...settings, theme };
    applyTheme(theme);
    chrome.storage.local.set({ settings });
    showTheme();
  };
  for (const radio of themeRadios) radio.addEventListener("change", () => radio.checked && setTheme(radio.value));
  themeBtn.addEventListener("click", () => setTheme(effectiveTheme(settings.theme) === "dark" ? "light" : "dark"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", showTheme);
  applyTheme(settings.theme);
  showTheme();
  fields.connections.value = settings.connections;
  fields.loginWhenNeeded.checked = settings.loginWhenNeeded;
  fields.loginEverywhere.checked = settings.loginEverywhere;
  fields.catchDownloads.checked = settings.catchDownloads;
  fields.useHelper.checked = settings.useHelper;
  for (const el of Object.values(fields)) el.addEventListener("change", save);

  // Where every job goes: Downloads, or a folder chosen here (a subfolder per zip either way).
  const saveRadios = [...document.querySelectorAll('#set-save input[name="save"]')];
  const baseField = document.getElementById("set-base-field");
  const baseName = document.getElementById("set-base");
  const baseBtn = document.getElementById("set-base-browse");
  const saveNote = document.getElementById("set-save-note");
  const showSave = () => {
    for (const radio of saveRadios) radio.checked = radio.value === settings.saveTo;
    baseField.hidden = settings.saveTo !== "folder";
    saveNote.textContent =
      settings.saveTo === "folder"
        ? t("Much faster for zips with thousands of files. Chrome asks once to let LinkUnzip save there (and again after a browser restart).")
        : t("Each zip gets its own folder in Downloads. Nothing to set up; Chrome saves about 6 files a second, so for zips with thousands of files a folder you choose is faster.");
  };
  const showBase = (handle) => {
    baseName.textContent = handle ? handle.name : t("Not chosen yet");
    baseBtn.textContent = handle ? t("Change...") : t("Choose folder...");
  };
  const setSaveTo = async (saveTo) => {
    settings = { ...settings, saveTo };
    await chrome.storage.local.set({ settings });
    showSave();
    await send("baseFolderChanged");
  };
  for (const radio of saveRadios) radio.addEventListener("change", () => radio.checked && setSaveTo(radio.value));
  showSave();
  getFolder("base").then(showBase);
  baseBtn.addEventListener("click", async () => {
    // The picker can't open in the toolbar popup (see Folders): Settings open in the window.
    if (!windowMode) return openLinkUnzipWindow("&settings=1");
    const handle = await chooseBaseFolder(null);
    if (handle) {
      showBase(handle);
      if (settings.saveTo !== "folder") await setSaveTo("folder");
    }
  });

  // "Every site" is Chrome's permission itself, not a stored setting: ask on, remove off.
  const everySite = document.getElementById("set-sites-all");
  chrome.permissions.contains(ALL_SITES).then((on) => (everySite.checked = on));
  everySite.addEventListener("change", () => {
    if (everySite.checked) {
      chrome.permissions.request(ALL_SITES).then(
        (granted) => (everySite.checked = granted),
        () => (everySite.checked = false),
      );
    } else {
      chrome.permissions.remove(ALL_SITES).catch(() => {});
    }
  });
  // Extract with the Windows helper: only offered when it is installed, and only new ones can.
  const helperRow = document.getElementById("set-helper-row");
  const helperNote = document.getElementById("set-helper-note");
  const showHelper = () => {
    const helper = st.helperInfo;
    helperRow.hidden = !helper && !settings.useHelper;
    const able = helperCanExtract(helper);
    fields.useHelper.disabled = !able && !settings.useHelper;
    helperNote.textContent = !helper
      ? t("The helper isn't running on this PC, so the browser extracts everything.")
      : able
        ? t("The helper program saves straight into {folder}, a folder per zip, fast even with thousands of files, and Open folder opens it in Explorer. Password zips, zips inside zips and links that need your login are still extracted in the browser.", { folder: helper.downloads_dir || t("Downloads") })
        : t("The helper on this PC ({version}) is too old for this. Install the new one first.", { version: helper.version });
    const parts = [`LinkUnzip ${chrome.runtime.getManifest().version}`, t("works in the browser")];
    if (helper) parts.push(settings.useHelper && able ? t("Windows helper {version} installed, extracts the zips it can", { version: helper.version }) : t("Windows helper {version} installed, not used", { version: helper.version }));
    document.getElementById("host-info").textContent = parts.join(" · ");
  };
  showHelper();
  const clearCache = document.getElementById("clear-cache");
  clearCache.addEventListener("click", async () => {
    clearCache.disabled = true;
    await send("clearCache");
    clearCache.textContent = t("Forgotten");
    announce(t("The kept zip indexes were removed."));
  });

  // Language: the browser's by default; a choice here reloads the page in that language.
  const langSelect = document.getElementById("set-lang");
  const browserLang = LANGUAGES[navigatorLanguage()] || LANGUAGES.en;
  langSelect.replaceChildren(
    h("option", { value: "auto" }, t("Automatic ({language})", { language: browserLang })),
    ...Object.entries(LANGUAGES).map(([code, name]) => h("option", { value: code }, name)),
  );
  langSelect.value = settings.language && LANGUAGES[settings.language] ? settings.language : "auto";
  langSelect.addEventListener("change", async () => {
    settings = { ...settings, language: langSelect.value };
    await chrome.storage.local.set({ settings });
    location.replace(windowMode ? `${location.pathname}?window=1&settings=1` : `${location.pathname}?settings=1`);
  });

  const toggle = (open) => {
    panel.hidden = !open;
    document.body.classList.toggle("settings-open", open);
    button.setAttribute("aria-expanded", String(open));
    showHelper();
  };
  button.addEventListener("click", () => toggle(panel.hidden));
  document.getElementById("settings-done").addEventListener("click", () => {
    toggle(false);
    button.focus();
  });
  return toggle;
}

// ---------------------------------------------------------------------------------------

const handedOver = await loadState();
await loadLanguage(settings.language);
translatePage();
const query = new URLSearchParams(location.search);
const toggleSettings = setupSettings();
// The toolbar popup sent an extraction here: start it right away when Chrome has nothing to
// ask, otherwise the ready view asks for the one click (see readyView).
if (windowMode && query.has("start") && handedOver) {
  const job = st.jobs[handedOver.id];
  const d = job ? draftFor(job) : null;
  if (job?.phase === "ready" || job?.phase === "error" || job?.phase === "cancelled") {
    if (await folderReady(d)) {
      await chrome.storage.session.remove("pendingExtract");
      await send("extract", { ...handedOver, target: d.target, output: d.output });
    } else {
      // The view's own button (Start Extraction, Resume, Extract here) does the asking.
      pending = handedOver;
    }
  }
}
render();
if (query.has("settings")) toggleSettings(true);
if (windowMode && query.has("change")) {
  announce(t("Click Change... to choose the folder."));
  document.querySelector(".folder-row .btn")?.focus();
}
send("ping").then((r) => {
  const key = () => `${st.hostInfo?.version}|${st.hostInfo?.features}|${Boolean(st.helperInfo)}`;
  const before = key();
  if (r?.info) st.hostInfo = r.info;
  if (r?.helper) st.helperInfo = r.helper;
  st.hostError = r && !r.ok ? r.error : null;
  renderChip();
  // What this engine allows (the file list, preview) may only be known now.
  if (!currentJob() || key() !== before) {
    drawn = "";
    render();
  }
});
