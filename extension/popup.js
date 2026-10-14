// LinkUnzip popup. All the real work happens in background.js and the engine it runs; this page
// only shows the state of the current job and sends commands.
//
// Names, paths and messages come from archives and servers we do not control, so everything is
// put on the page with textContent (via h()), never innerHTML.

import { h } from "./dom.js";
import { fileList } from "./filelist.js";
import { askFolderPermission, folderPermission, getFolder, pickFolder as showFolderPicker, setFolder } from "./folder.js";
import { clock, fileNameFromUrl, hostOf, humanBytes, humanDuration, sitePattern } from "./fmt.js";
import { ALL_SITES, DEFAULT_SETTINGS, applyTheme, effectiveTheme, loadSettings } from "./settings.js";

const view = document.getElementById("view");
const windowMode = new URLSearchParams(location.search).has("window");
if (windowMode) document.body.classList.add("window-mode");

// hostInfo: the engine's hello (what it can do); helperInfo: the Windows helper's, if installed.
let st = { jobs: {}, current: null, hostInfo: null, hostError: null, helperInfo: null };
let settings = { ...DEFAULT_SETTINGS };
// What the user typed or chose for each job, so neither a redraw nor closing the popup loses it.
let drafts = {};
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
/** Files Chrome's downloads save per second (measured: 6 to 11 small files). */
const DOWNLOADS_PER_SEC = 6;
/** From this many seconds of saving on, the popup suggests a folder instead of Downloads. */
const SLOW_SECS = 60;
/** ".dll", ".dll and .ini", ".dll, .ini and .cfg" */
const listWords = (words) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`);

/** "about 2 minutes", "about 1 hour 20 minutes": an estimate, so no seconds. */
function roughly(secs) {
  const min = Math.max(1, Math.round(secs / 60));
  if (min < 60) return `about ${min} ${min === 1 ? "minute" : "minutes"}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `about ${h} ${h === 1 ? "hour" : "hours"}${m ? ` ${m} minutes` : ""}`;
}

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
      problem.textContent = `Chrome didn't allow that folder: ${e.message}`;
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
  if (isDownloads(d.target)) return d.target;
  if (!d.target && !(await chooseJobFolder(job, d, problem))) {
    if (problem.hidden) {
      problem.textContent = "Choose a folder to extract into.";
      problem.hidden = false;
    }
    return null;
  }
  const handle = await getFolder(d.target.key);
  if (!handle) {
    d.target = null;
    problem.textContent = "That folder is no longer known to LinkUnzip. Choose it again.";
    problem.hidden = false;
    return null;
  }
  if (!(await askFolderPermission(handle))) {
    problem.textContent = `Chrome didn't let LinkUnzip save into ${handle.name}. Click the button again and choose Allow (or "Allow on every visit").`;
    problem.hidden = false;
    return null;
  }
  return d.target;
}

/** Can an extraction start right away, without the picker or one of Chrome's questions? */
async function folderReady(d) {
  if (isDownloads(d.target)) return true;
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
  // The helper's one-pass mode writes where the helper decides: no folder to ask for.
  if (request.stream) return send("extract", { ...request, id: job.id });
  if (!windowMode && !isDownloads(d.target)) {
    await chrome.storage.session.set({ pendingExtract: { ...request, id: job.id } });
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
 * Where the files go, Change... for this job (the picker opens in the window) and, for a folder,
 * the way back to Downloads. `onChange` hears about a new place.
 */
function folderField(label, d, job, { compact = false, onChange = () => {} } = {}) {
  const text = h("span", { class: "folder-name" });
  const problem = h("p", { class: "notice bad", hidden: true });
  const back = h("button", { class: "link small", type: "button" }, "Save to Downloads instead");
  const showPlace = () => {
    text.textContent = d.output || "No folder chosen yet";
    text.title = d.output || "";
    back.hidden = !d.target || isDownloads(d.target);
  };
  const change = h(
    "button",
    {
      class: "btn browse",
      type: "button",
      "aria-label": `Choose the folder to ${label.toLowerCase()}`,
      onclick: async () => {
        if (!windowMode) return openLinkUnzipWindow("&change=1");
        problem.hidden = true;
        if (await chooseJobFolder(job, d, problem)) {
          showPlace();
          onChange();
        }
      },
    },
    "Change...",
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
    choosing ? h("p", { class: "muted small" }, "Chrome doesn't let extensions pick Downloads, Desktop or Documents themselves: pick or make a folder inside one of them (Downloads > LinkUnzip, for example).") : null,
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
  // The rating line is decided just after the job is done, so it redraws the Done view too.
  const sig = job ? `${job.id}:${job.phase}${job.askRate ? ":rate" : ""}` : "pick";
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
  if (!job) return st.hostError ? "Engine stopped" : "Ready";
  const words = { inspecting: "Reading index...", ready: "Ready", extracting: "Extracting", done: "Done", cancelled: "Stopped" };
  return words[job.phase] || "Error";
}

/** Under the logo: which zip this is, and × to put it away (not while extracting: that is Stop). */
function jobLine(job) {
  const line = document.getElementById("job-line");
  line.hidden = !job;
  if (!job) return line.replaceChildren();
  const host = hostOf(job.url);
  line.replaceChildren(h("span", { class: "name", title: job.url }, host ? `${job.name} · ${host}` : job.name));
  if (job.phase !== "extracting") {
    line.append(h("button", { type: "button", title: "Close this zip", "aria-label": "Close this zip", onclick: () => send("dismiss", { id: job.id }) }, "✕"));
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
      return `Reading the index of ${job.name}.`;
    case "ready":
      return `${job.name}: ${r.files.toLocaleString()} files. Tick what you want, then Extract.`;
    case "extracting":
      return `Extracting ${job.name}.`;
    case "done":
      return `Extracted ${job.result.files.toLocaleString()} files.`;
    case "cancelled":
      return "Stopped.";
    default:
      return "";
  }
}

function renderChip() {
  const chip = document.getElementById("host-chip");
  const [state, word, title] = st.hostError
    ? ["bad", "✗ Stopped", st.hostError.message]
    : st.hostInfo
      ? ["ok", "✓ In browser", "LinkUnzip works right here in the browser: nothing to install"]
      : ["unknown", "Starting...", ""];
  chip.dataset.state = state;
  chip.title = title;
  chip.replaceChildren("Engine ", h("b", {}, word));
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
    found.push({ href: tab.url, text: "This tab", pageUrl: "" });
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
    h("div", { class: "btn-row" }, h("button", { class: "btn", onclick: () => location.reload() }, "Try again")),
  );
}

function pickView() {
  const input = h("input", {
    type: "url",
    placeholder: "https://example.com/archive.zip",
    spellcheck: "false",
    "aria-label": "Link to a .zip file",
  });
  const go = () => {
    const url = input.value.trim();
    if (url) start(url);
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  const list = h("div", { class: "card panel links", hidden: true });
  show(
    panel(
      h("h1", {}, "Extract a ZIP without saving it"),
      h(
        "p",
        { class: "muted" },
        "Paste a link to a .zip, or right-click one on any page. LinkUnzip reads the index first, then streams every file straight into a folder.",
      ),
      h("div", { class: "url-row" }, input, h("button", { class: "btn primary", onclick: go }, "Inspect")),
    ),
    hostBanner(),
    list,
  );
  input.focus();
  findZipLinks().then((links) => {
    if (!links.length || drawn !== "pick") return;
    list.hidden = false;
    list.append(
      h("h2", {}, "ZIP links on this page"),
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

function dismissBtn(label = "Close") {
  return h("button", { class: "btn", onclick: () => send("dismiss", { id: st.current }) }, label);
}

function inspectingView(job) {
  show(
    panel(
      h(
        "div",
        { class: "row" },
        h("div", { class: "spinner" }),
        h(
          "div",
          {},
          h("h1", {}, "Reading the index..."),
          h("p", { class: "muted small" }, "Only the end of the file is fetched, not the whole zip."),
        ),
      ),
      h("div", { class: "file-head" }, h("span", { class: "name" }, job.name), h("span", { class: "meta" }, hostOf(job.url))),
    ),
    actionBar([dismissBtn("Cancel")]),
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
    room = fitsHere ? h("span", { class: "good" }, " (Good)") : h("span", { class: "bad" }, " (Not enough)");
  }
  return h(
    "section",
    { class: "cost compare", "aria-label": "Cost analysis" },
    h("div", { class: "sec-head" }, h("h2", {}, "Cost Analysis"), saved > 0 ? h("span", { class: "badge" }, `Saves ${humanBytes(saved)}`) : null),
    h(
      "div",
      { class: "cost-bar", "aria-hidden": "true" },
      h("div", { class: "seg extracted", style: `width:${files}%` }),
      h("div", { class: "seg zip", style: `width:${zip}%` }),
    ),
    h(
      "div",
      { class: "stats2" },
      h("span", { class: "files" }, h("i"), "Files to write: ", h("b", { class: "cmp-total" }, humanBytes(write))),
      h("span", { class: "zip" }, h("i"), "Zip, never saved: ", h("b", {}, humanBytes(r.archive_size))),
      h("span", {}, "Zip on disk: ", h("b", {}, "0 B")),
      h("span", {}, "To download: ", h("b", {}, `~${humanBytes(download)}`)),
      h("span", {}, "Normal download: ", h("b", { class: "cmp-total" }, humanBytes(normal))),
      r.free == null ? null : h("span", {}, "Free space: ", h("b", {}, humanBytes(r.free)), room),
    ),
  );
}

function readyView(job) {
  const r = job.report;
  const d = draftFor(job);
  const fits = r.linkunzip_fits !== false;
  const problem = h("p", { class: "notice bad", hidden: true });

  const include = h("input", { type: "text", value: d.include, placeholder: "e.g. *.dll, docs/*   (empty = everything)", spellcheck: "false" });
  include.addEventListener("input", () => {
    d.include = include.value;
    updateGo();
    saveDrafts();
  });

  let selection = null; // from the file list: all, none, or select (+ measured)
  // With a measured selection, what has to fit is what will be written, not the whole zip.
  const fitsNow = () => {
    const m = selection?.measured;
    return m && r.free != null ? m.extracted <= r.free : fits;
  };
  // The button says what it will do: "Start Extraction (5,518 files, 925.6 MB)", "Filtered" once
  // only some files are ticked.
  const goLabel = () => {
    // Sent here from the toolbar popup, and Chrome still has to ask something: one click.
    if (windowMode && pendingFor(job) && !isDownloads(d.target)) return d.target ? "Allow and start extraction" : "Choose folder and start";
    const some = Boolean(d.include.trim()) || (selection && !selection.all);
    const verb = some ? "Start Filtered Extraction" : "Start Extraction";
    if (selection?.none || d.include.trim()) return verb;
    const m = selection?.measured || (!selection || selection.all ? { files: r.files, extracted: r.extracted } : null);
    return m ? `${verb} (${m.files.toLocaleString()} ${m.files === 1 ? "file" : "files"}, ${humanBytes(m.extracted)})` : verb;
  };
  const go = h("button", { class: "btn primary", id: "extract-btn" }, "Start Extraction");
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
    const types = listWords((m.held_back_types || []).slice(0, 3).map((t) => `.${t}`));
    const heldWhat = `${types} files until you click Keep on each one (${held.toLocaleString()} here)`;
    const text = many
      ? `${m.files.toLocaleString()} files: Chrome's downloads save about ${DOWNLOADS_PER_SEC} files a second, so saving them takes ${roughly(secs)}.${held ? ` Chrome also holds back ${heldWhat}.` : ""} A folder you choose is much faster${held ? " and doesn't ask" : " for this many files"}. `
      : `Chrome's downloads hold back ${heldWhat}. A folder you choose doesn't ask. `;
    slow.replaceChildren(text, h("button", { class: "link", type: "button", onclick: () => view.querySelector(".folder-row .btn")?.click() }, "Choose a folder..."));
  };
  const updateGo = () => {
    go.disabled = Boolean(selection?.none) || (!fitsNow() && !d.force);
    go.textContent = goLabel();
    updateSlow();
  };
  go.addEventListener("click", async () => {
    problem.hidden = true;
    if (selection?.none) {
      problem.textContent = "Tick at least one file to extract.";
      problem.hidden = false;
      return;
    }
    await startExtraction(
      job,
      d,
      {
        include: d.include.split(",").map((s) => s.trim()).filter(Boolean),
        select: selection?.select,
        connections: settings.connections,
        force: !fitsNow() && d.force,
      },
      problem,
    );
  });
  // Sent here from the toolbar popup, and Chrome still has to ask something: say what.
  if (windowMode && pendingFor(job) && !isDownloads(d.target)) {
    go.textContent = goLabel();
    problem.className = "notice";
    problem.textContent = d.target
      ? `Chrome needs your OK once to let LinkUnzip save into ${d.output.split(" > ")[0]}. Click the button, then Allow.`
      : "Choose where to save: pick or make a folder inside Downloads (Chrome doesn't let extensions use Downloads itself).";
    problem.hidden = false;
  }

  // The Cost Analysis follows the ticked files once the helper has measured them; with nothing
  // ticked, or while measuring, it keeps what it showed.
  let cost = costSection(r);
  const updateCost = () => {
    if (selection?.none || (selection && !selection.all && !selection.measured)) return;
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
        h("span", {}, "Try anyway", h("small", {}, "Extraction may stop when the disk fills up.")),
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
    "Pattern...",
  );
  const clearPattern = h(
    "button",
    {
      type: "button",
      class: "clear",
      title: "Clear the pattern",
      "aria-label": "Clear the pattern",
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
          features: { search: hasFeature("search"), measure: hasFeature("measure"), preview: hasFeature("preview") },
          api: {
            list: (dir, offset, limit) => send("list", { id: job.id, dir, offset, limit }),
            search: (query) => send("search", { id: job.id, query }),
            measure: (select) => send("measure", { id: job.id, select }),
            preview: (path) => send("preview", { id: job.id, path }),
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
    patternRow.append(h("label", { for: include.id }, "Only files matching"), include, clearPattern);
  } else {
    filter = h("label", { class: "field" }, h("span", {}, "Only these files (optional)"), include);
  }

  const bar = actionBar([
    go,
    h("button", { class: "btn", onclick: () => send("downloadNormally", { url: job.url }) }, "Download Normal ZIP (Fallback)"),
    h("button", { class: "btn cancel", onclick: () => send("dismiss", { id: job.id }) }, "Cancel"),
  ]);
  bar.prepend(...[force, slow, problem].filter(Boolean));

  // With the file list the panel fills the popup and the list takes the height that is left.
  if (chooser) document.body.classList.add("fill");
  show(
    h("div", { class: "card main" }, cost, chooser?.el),
    r.unsupported > 0
      ? h("p", { class: "notice" }, `${r.unsupported} file(s) use encryption or a compression LinkUnzip cannot read (e.g. ${r.unsupported_sample[0].name}). ${chooser ? "Untick them or use" : "Use"} the filter to skip them.`)
      : null,
    filter,
    folderField("Extract into", d, job, {
      compact: true,
      onChange: () => {
        problem.hidden = true;
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
    sub: h("p", { class: "muted small" }, "Reading the index and planning..."),
    files: h("b", {}, "-"),
    speed: h("b", {}, "-"),
    eta: h("b", {}, "-"),
    now: h("p", { class: "now" }, " "),
    zip: h("b", { class: "zero" }, "0 B"),
    extracted: h("b", {}, "0 B"),
    free: h("b", {}, "-"),
    freeLabel: h("span", {}, "Free space"),
  };
  const stat = (label, el) => h("div", { class: "stat" }, el, h("span", {}, label));
  show(
    panel(
      h("p", { class: "path" }, `Into ${job.output}`),
      isDownloads(job.target) && job.via !== "helper"
        ? h("p", { class: "muted small" }, "Saving through Chrome's downloads (its download list stays quiet meanwhile). You can close this popup: LinkUnzip carries on.")
        : windowMode && job.via !== "helper"
          ? h("p", { class: "muted small" }, "Keep this window open until LinkUnzip is done. You can minimise it.")
          : null,
      h("div", { class: "row", style: "justify-content:space-between" }, h("div", {}, h("h2", { style: "margin:0 0 4px" }, "Extracting"), refs.pct), h("div", { class: "spinner", "aria-hidden": "true" })),
      h("div", { class: "progress-bar", role: "progressbar", "aria-label": "Extraction progress", "aria-valuemin": "0", "aria-valuemax": "100" }, refs.bar),
      refs.sub,
      h("div", { class: "stat-grid" }, stat("files", refs.files), stat("speed", refs.speed), stat("time left", refs.eta)),
      refs.now,
      h("div", { class: "statusline" },
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", {}, "Zip stored on disk"), refs.zip),
        h("div", { class: "row", style: "justify-content:space-between" }, h("span", {}, "Extracted so far"), refs.extracted),
        h("div", { class: "row", style: "justify-content:space-between" }, refs.freeLabel, refs.free),
      ),
    ),
    actionBar([h("button", { class: "btn danger", onclick: () => send("cancel", { id: job.id }) }, "Stop")]),
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
    refs.pct.textContent = known ? `${Math.floor(pct)}%` : humanBytes(p.downloaded);
    setStatus(`Extracting ${refs.pct.textContent}`);
    if (known) {
      refs.bar.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(Math.floor(pct)));
      const quarter = Math.floor(pct / 25);
      if (quarter > spokenQuarter && quarter < 4) {
        spokenQuarter = quarter;
        announce(`${quarter * 25} percent extracted.`);
      }
    } else {
      bar.removeAttribute("aria-valuenow");
      bar.setAttribute("aria-valuetext", `${humanBytes(p.downloaded)} downloaded`);
    }
    const retried = p.retries ? ` · ${p.retries} retried` : "";
    if (!known) refs.sub.textContent = `downloaded so far · read in one pass${retried}`;
    else if (skipped.files) {
      refs.sub.textContent = `Resumed: ${skipped.files.toLocaleString()} ${skipped.files === 1 ? "file was" : "files were"} already there · ${humanBytes(p.downloaded)} of the remaining ${humanBytes(p.total_compressed)} downloaded${retried}`;
    } else refs.sub.textContent = `${humanBytes(p.downloaded)} of ${humanBytes(p.total_compressed)} downloaded${retried}`;
    const filesDone = p.files_done + skipped.files;
    const filesAll = p.total_files + skipped.files;
    refs.files.textContent = p.total_files ? `${filesDone.toLocaleString()} / ${filesAll.toLocaleString()}` : filesDone.toLocaleString();
    refs.speed.textContent = `${humanBytes(p.rate)}/s`;
    refs.eta.textContent = clock(p.eta_secs);
    refs.now.textContent = p.active.length ? `now: ${p.active.join(", ")}${p.active_count > p.active.length ? ` (+${p.active_count - p.active.length} more)` : ""}` : " ";
    refs.zip.textContent = humanBytes(p.zip_on_disk);
    refs.extracted.textContent = humanBytes(p.extracted + skipped.extracted);
    refs.free.parentElement.hidden = p.free == null;
    refs.free.textContent = p.free == null ? "?" : humanBytes(p.free);
    refs.freeLabel.textContent = `Free space${j.report?.drive ? ` on ${j.report.drive}` : ""}`;
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
  const files = (n) => `${n.toLocaleString()} ${n === 1 ? "file" : "files"}`;
  // Newer helpers say how many files they checked (size + CRC-32) and which were already there.
  const intoDownloads = isDownloads(job.target) && job.via !== "helper";
  const verified =
    r.verified_files == null
      ? null
      : r.verified_files === r.files && r.files > 1
        ? `✓ All ${files(r.files)} verified`
        : `✓ ${files(r.verified_files)} verified`;
  show(
    panel(
      job.askRate ? rateLine(job) : null,
      h("div", { class: "hero" }, h("div", { class: "tick", "aria-hidden": "true" }, "✓"), h("h1", {}, `Extracted ${files(r.files)}`), h("p", { class: "muted" }, `in ${humanDuration(r.elapsed_ms)} · ${humanBytes(r.extracted_bytes)} written`)),
      verified ? h("p", { class: "verified" }, verified, h("span", { class: "muted small" }, " (size and CRC-32 checked)")) : null,
      r.skipped_existing > 0
        ? h("p", { class: "muted small" }, `Skipped ${files(r.skipped_existing)} already in the folder${r.skipped_bytes ? ` (${humanBytes(r.skipped_bytes)}, not downloaded again)` : ""}.`)
        : null,
      h("div", { class: "zero-line" }, h("span", {}, "Zip stored on disk"), h("b", {}, humanBytes(r.zip_bytes_on_disk))),
      h("dl", { class: "kv" },
        h("dt", {}, "Downloaded"), h("dd", {}, `${humanBytes(r.downloaded_bytes)} in ${r.requests} ${r.stream ? "pass" : r.requests === 1 ? "request" : "requests"}`),
        r.index_bytes > 0 ? h("dt", {}, "of which the zip's index") : null, r.index_bytes > 0 ? h("dd", {}, humanBytes(r.index_bytes)) : null,
        h("dt", {}, "A normal download needs"), h("dd", {}, humanBytes(r.normal_needs)),
        h("dt", {}, "Disk space saved"), h("dd", { class: "accent" }, humanBytes(saved)),
        r.retries ? h("dt", {}, "Network retries") : null, r.retries ? h("dd", {}, String(r.retries)) : null,
        r.renamed ? h("dt", {}, intoDownloads ? "Renamed for Chrome" : "Renamed for Windows") : null, r.renamed ? h("dd", {}, `${r.renamed} files`) : null,
      ),
      r.renamed && r.renamed_sample?.length
        ? h("p", { class: "muted small" }, `${intoDownloads ? "Chrome's downloads don't take some names, like .gitignore or names with ~, so they got a _" : "Names Windows can't store got a _"}: ${r.renamed_sample.map(([from, to]) => `${from} became ${to}`).join(", ")}${r.renamed > r.renamed_sample.length ? ", ..." : ""}`)
        : null,
      r.held > 0 ? heldNotice(r) : null,
      h("p", { class: "path" }, `In ${r.output}`),
    ),
    actionBar([
      job.via === "helper" ? h("button", { class: "btn primary", onclick: () => send("reveal", { path: r.output }) }, "Open folder") : null,
      intoDownloads ? h("button", { class: "btn primary", onclick: () => send("showDownloads") }, "Open Downloads") : null,
      h("button", { class: job.via === "helper" || intoDownloads ? "btn" : "btn primary", onclick: () => send("dismiss", { id: st.current }) }, "Extract another"),
    ]),
  );
}

/**
 * Files Chrome's downloads held back: it asks about types like .dll or .ini from any download, or
 * a virus scan blocked one. Keep asks Chrome for each file in turn (one question per file).
 */
function heldNotice(r) {
  const names = (r.held_sample || []).map((f) => f.name.split("/").pop());
  const more = r.held > names.length ? ` and ${(r.held - names.length).toLocaleString()} more` : "";
  const one = r.held === 1;
  const status = h("p", { class: "small", style: "margin:6px 0 0", role: "status" });
  const keep = h("button", { class: "link", type: "button" }, one ? "Keep it" : "Keep them");
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
    status.textContent = `${kept.toLocaleString()} of ${r.held.toLocaleString()} kept.`;
    keep.disabled = false;
  });
  return h(
    "div",
    { class: "notice" },
    h("p", { style: "margin:0 0 6px" }, `Chrome held back ${one ? "1 file" : `${r.held.toLocaleString()} files`} until you say to keep ${one ? "it" : "them"}: ${names.join(", ")}${more}. ${one ? "It" : "They"} checked out (size and CRC-32); Chrome asks about files like these from any download.`),
    h("div", { class: "row", style: "gap:14px" }, keep, h("button", { class: "link", type: "button", onclick: () => chrome.tabs.create({ url: "chrome://downloads" }) }, "Open Chrome's downloads")),
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
    h("p", {}, h("b", {}, "Worked well?"), " A rating on the Chrome Web Store helps other people find LinkUnzip."),
    h(
      "div",
      { class: "row" },
      h("button", { class: "link", onclick: () => answer(true) }, "Rate it"),
      h("button", { class: "link quiet", onclick: () => answer(false) }, "No thanks"),
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
      ? `Chrome needs your OK once to let LinkUnzip save into ${d.output.split(" > ")[0]}. Click ${button}, then Allow.`
      : `Choose where to save, then click ${button}. Pick or make a folder inside Downloads (Chrome doesn't let extensions use Downloads itself).`,
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
        h("h1", {}, "Stopped"),
        h("p", { class: "muted" }, `${(r.files_done || 0).toLocaleString()} files were already finished and stay in the folder. Half-written files were removed.`),
      ),
      resume
        ? h(
            "p",
            { class: "muted small" },
            isDownloads(job.target)
              ? "Resume carries on into the same folder: the files LinkUnzip already saved are skipped, not downloaded again."
              : "Resume carries on into the same folder: files already there are checked and skipped, not downloaded again.",
          )
        : null,
      handoverNotice(job, d, "Resume"),
      problem,
    ),
    actionBar([
      resume ? h("button", { class: "btn primary", onclick: () => startExtraction(job, d, { ...extractAgain(job), resume: true }, problem) }, "Resume") : null,
      r.output && job.via === "helper" ? h("button", { class: "btn", onclick: () => send("reveal", { path: r.output }) }, "Open folder") : null,
      dismissBtn("Close"),
    ]),
  );
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

// What using a login means, said before it is used (store policy: disclose first).
const loginUse = (host) =>
  `your browser sends its cookies for ${host} with LinkUnzip's requests to ${host}, and only there. Nothing goes to LinkUnzip itself.`;

const ACCESS_REFUSED = "No problem. Without access to this site LinkUnzip can't read the zip, but you can still download it normally.";

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
        title: `Allow LinkUnzip to read ${host}`,
        text: `To read the zip without downloading all of it, LinkUnzip needs Chrome's permission to fetch files from ${host}. It only connects there when you give it a link.`,
        more: "Tip: Settings > Read zip links on every site saves you this step for every new site.",
        actions: ["access", "download"],
      };
    case "ask_where":
      return {
        title: "Chrome asks where to save each download",
        text: "Chrome is set to ask where to save every file, so it would ask once for each file in this zip.",
        more: "Turn off \"Ask where to save each file before downloading\" in Chrome's download settings and try again, or choose a folder for LinkUnzip instead.",
        folder: true,
        actions: ["chromeSettings", "extractHere"],
      };
    case "folder_permission":
      return { title: "LinkUnzip needs to write into the folder again", text: e.message, more: "Chrome asks again after the browser restarts. Click Extract here and choose Allow.", folder: true, actions: ["extractHere"] };
    case "no_folder":
      return { title: "Choose a folder", text: "Pick the folder LinkUnzip should extract into.", folder: true, actions: ["extractHere"] };
    case "too_big":
      return { title: "This zip's index is too big for the browser", text: e.message, actions: ["download"] };
    case "host_missing":
    case "host_forbidden":
      return { title: "This needs the LinkUnzip helper for Windows", text: e.message, actions: ["setup", "download"] };
    case "host":
    case "host_silent":
      return { title: "LinkUnzip stopped", text: e.message, actions: ["retry", "download"] };
    case "no_range":
      return {
        title: "This server can't send parts of the file",
        text: "It answered 200 OK with the whole file instead of 206 Partial Content.",
        more: st.helperInfo
          ? "Servers like GitHub's 'Download ZIP' build the file while they send it, so it can only be read from the start. The LinkUnzip helper can still extract it in one pass: one connection, no size preview, and the zip is still never saved."
          : "Servers like GitHub's 'Download ZIP' build the file while they send it, so it can only be read from the start. Reading it in one pass needs the LinkUnzip helper for Windows for now; or download it normally.",
        actions: st.helperInfo ? ["stream", "download"] : ["download"],
      };
    case "html_page":
      return {
        title: "This link opens a web page, not the file",
        text: "The link answered with a web page instead of the zip. Sites like Google Drive or Dropbox show a page first: open the link, then right-click the page's own download button and choose Extract with LinkUnzip.",
        more: offerLogin ? `If that page asks you to sign in, LinkUnzip can use your login on ${host}: ${loginUse(host)}` : null,
        actions: offerLogin ? ["login", "open", "download"] : ["open", "download"],
      };
    case "needs_login":
      if (offerLogin) {
        return {
          title: `This download needs your login on ${host}`,
          text: `The site says you need to be signed in. LinkUnzip can use your login on ${host}: ${loginUse(host)} It starts again right away.`,
          actions: ["login", "download"],
        };
      }
      return {
        title: `This download needs your login on ${host}`,
        text: job.loginSent
          ? "LinkUnzip sent your login, but the site still says no. Open the link, sign in on the page, then try again."
          : "The site says you need to be signed in. Turn on 'Use my login when a site needs it' in Settings, or download the file normally.",
        actions: job.loginSent ? ["open", "retry", "download"] : ["download"],
      };
    case "link_expired":
      return {
        title: "This link has expired",
        text: `Links like this one only work for a while${status}. Go back to the page, get a fresh link and right-click it again.`,
        actions: job.pageUrl ? ["page"] : [],
      };
    case "not_found":
      return {
        title: "The file is gone from the server",
        text: `${host} says there is nothing at this link${status}. It may be old, moved, or mistyped.`,
        actions: ["open"],
      };
    case "not_zip":
      return {
        title: "This file isn't a ZIP",
        text: "LinkUnzip only reads .zip archives, and this link gives something else. You can still download it normally.",
        actions: ["download"],
      };
    case "server_error":
      return {
        title: `${host} had a problem`,
        text: `The server kept answering with an error${status}. This is usually temporary: try again in a minute.`,
        actions: ["retry", "download"],
      };
    case "network":
      if (job.allSites === false) {
        return {
          title: `Can't read from ${host}`,
          text: "Check your internet connection (or VPN or proxy), then try again.",
          more: "If the link sends the download on to another site (many download links do), LinkUnzip needs permission to read there too. Allowing every site covers that.",
          actions: ["accessAll", "retry"],
        };
      }
      return {
        title: `Can't reach ${host}`,
        text: "Check your internet connection (or VPN or proxy), then try again.",
        actions: ["retry"],
      };
    case "disk_full":
      return {
        title: "Not enough free space",
        text: e.message || "The drive is full.",
        more: "Choose a folder on a drive with more room.",
        folder: true,
        actions: ["extractHere"],
      };
    case "folder_not_writable":
      if (isDownloads(job.target)) {
        return {
          title: "Couldn't save into Downloads",
          text: e.message,
          more: "Try again, or choose a folder for LinkUnzip instead.",
          folder: true,
          actions: ["extractHere"],
        };
      }
      return {
        title: "Can't write to this folder",
        text: "Windows didn't let LinkUnzip create files there (no permission, or the path is too long). Choose another folder.",
        more: e.message,
        folder: true,
        actions: ["extractHere"],
      };
    case "unsupported_entries":
      return { title: "LinkUnzip can't read these files", text: e.message, actions: ["download"] };
    case "internal":
      return {
        title: "LinkUnzip hit a bug",
        text: "Nothing more was written. Copy the details and send them to the LinkUnzip developers so it can be fixed.",
        actions: ["copy", "retry"],
      };
    default:
      return { title: "Couldn't extract this", text: e.message || "Something went wrong.", actions: ["download"] };
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
  const btn = h("button", { class: cls }, "Copy details");
  btn.addEventListener("click", async () => {
    const text = await detailsText(job, e);
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      announce("Details copied.");
    } catch {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = "Copy details"), 2000);
  });
  return btn;
}

/** Ask Chrome for this job's site (it needs this click), then the background runs the job again. */
function askForAccess(job, note) {
  send("awaitAccess", { id: job.id }); // in case Chrome's prompt closes this popup
  chrome.permissions.request({ origins: [sitePattern(job.url)] }).then(
    (granted) => {
      if (!granted) note.textContent = ACCESS_REFUSED;
      send("accessAnswer", { id: job.id, granted });
    },
    () => send("accessAnswer", { id: job.id, granted: false }),
  );
}

function errorView(job) {
  const e = job.error || { code: "failed", message: "Something went wrong." };
  const info = describeError(job, e);
  const host = hostOf(job.url);
  const web = /^https?:/i.test(job.url);
  const d = draftFor(job);
  const note = h("p", { class: "muted small", role: "status" }, job.accessRefused ? ACCESS_REFUSED : "");
  const problem = h("p", { class: "notice bad", hidden: true });

  const actions = {
    setup: () => h("button", { onclick: openSetup }, "Get the helper"),
    access: () => h("button", { onclick: () => askForAccess(job, note) }, `Allow ${host}`),
    accessAll: () =>
      h("button", {
        onclick: () => {
          send("awaitAccess", { id: job.id });
          chrome.permissions.request(ALL_SITES).then(
            (granted) => send("accessAnswer", { id: job.id, granted }),
            () => send("accessAnswer", { id: job.id, granted: false }),
          );
        },
      }, "Allow every site"),
    stream: () => h("button", { onclick: () => send("extract", { id: job.id, include: [], connections: 1, stream: true }) }, "Stream it anyway"),
    // The same extraction as before, into the folder now in the field.
    extractHere: () =>
      h("button", {
        onclick: () => (job.lastExtract ? startExtraction(job, d, extractAgain(job), problem) : send("retry", { id: job.id })),
      }, isDownloads(d.target) ? "Try again" : "Extract here"),
    chromeSettings: () => h("button", { onclick: () => chrome.tabs.create({ url: "chrome://settings/downloads" }) }, "Open Chrome's download settings"),
    login: () => h("button", { onclick: () => send("useLogin", { id: job.id }) }, `Use my login on ${host}`),
    retry: () => h("button", { onclick: () => send("retry", { id: job.id }) }, "Try again"),
    resume: () => h("button", { onclick: () => startExtraction(job, d, { ...extractAgain(job), resume: true }, problem) }, "Resume"),
    open: () => (web ? h("button", { onclick: () => chrome.tabs.create({ url: job.url }) }, "Open link") : null),
    page: () => h("button", { onclick: () => chrome.tabs.create({ url: job.pageUrl }) }, "Open the page"),
    download: () => (web ? h("button", { onclick: () => send("downloadNormally", { url: job.url }) }, "Download normally") : null),
    copy: () => copyDetailsBtn(job, e, "btn"),
  };
  // An extraction that failed part way can carry on where it stopped (not for setup problems).
  let wanted = info.actions;
  if (job.failedWhile === "extract" && canResume(job) && !["host_missing", "host_forbidden"].includes(e.code)) {
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
      info.folder ? folderField("Extract into", d, job) : null,
      handoverNotice(job, d, buttons[0]?.textContent || "the button"),
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
  };
  const save = () => {
    settings = {
      ...settings,
      connections: Math.min(16, Math.max(1, Number(fields.connections.value) || 4)),
      loginWhenNeeded: fields.loginWhenNeeded.checked,
      loginEverywhere: fields.loginEverywhere.checked,
      catchDownloads: fields.catchDownloads.checked,
    };
    chrome.storage.local.set({ settings });
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
    const label = dark ? "Switch to light mode" : "Switch to dark mode";
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
        ? "Much faster for zips with thousands of files. Chrome asks once to let LinkUnzip save there (and again after a browser restart)."
        : "Each zip gets its own folder in Downloads. Nothing to set up; Chrome saves about 6 files a second, so for zips with thousands of files a folder you choose is faster.";
  };
  const showBase = (handle) => {
    baseName.textContent = handle ? handle.name : "Not chosen yet";
    baseBtn.textContent = handle ? "Change..." : "Choose folder...";
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
  const toggle = (open) => {
    panel.hidden = !open;
    document.body.classList.toggle("settings-open", open);
    button.setAttribute("aria-expanded", String(open));
    const helper = st.helperInfo;
    document.getElementById("host-info").textContent = `LinkUnzip ${chrome.runtime.getManifest().version} · works in the browser${helper ? ` · Windows helper ${helper.version} installed (used for servers without Range support)` : ""}`;
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
if (windowMode && query.has("settings")) toggleSettings(true);
if (windowMode && query.has("change")) {
  announce("Click Change... to choose the folder.");
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
