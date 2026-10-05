// LinkUnzip popup. All the real work happens in background.js and in the native LinkUnzip
// program; this page only shows the state of the current job and sends commands.
//
// Names, paths and messages come from archives and servers we do not control, so everything is
// put on the page with textContent (via h()), never innerHTML.

import { helperNeedsUpdate } from "./config.js";
import { h } from "./dom.js";
import { fileList } from "./filelist.js";
import { clock, fileNameFromUrl, hostOf, humanBytes, humanDuration, sitePattern } from "./fmt.js";
import { ALL_SITES, DEFAULT_SETTINGS, applyTheme, effectiveTheme, loadSettings } from "./settings.js";

const view = document.getElementById("view");
if (new URLSearchParams(location.search).has("window")) document.body.classList.add("window-mode");

let st = { jobs: {}, current: null, hostInfo: null, hostError: null };
let settings = { ...DEFAULT_SETTINGS };
// What the user typed or chose for each job, so neither a redraw nor closing the popup loses it
// (the toolbar popup closes whenever the Windows folder picker takes focus).
let drafts = {};
let drawn = ""; // which job/phase is on screen
let updater = null; // redraws the live numbers of the current view without rebuilding it
let updateLater = false; // "Later" on the helper update card, until the browser restarts

const send = (cmd, data = {}) => chrome.runtime.sendMessage({ cmd, ...data });

/** What the installed helper can do (`hello.features`); older helpers list nothing. */
const hasFeature = (name) => Boolean(st.hostInfo?.features?.includes(name));

function draftFor(job) {
  // The background may have stored only a folder picked while the popup was closed.
  return (drafts[job.id] = { output: job.output || "", include: "", force: false, ...drafts[job.id] });
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
  const s = await chrome.storage.session.get(["jobs", "current", "hostInfo", "hostError", "drafts", "reopen", "updateLater"]);
  updateLater = Boolean(s.updateLater);
  st = {
    jobs: s.jobs || {},
    current: s.current || null,
    hostInfo: s.hostInfo || null,
    hostError: s.hostError || null,
  };
  drafts = s.drafts || {};
  settings = await loadSettings();
  // Reopened by the background after the folder picker: go back to where the user was.
  if (s.reopen) chrome.storage.session.remove("reopen");
  return s.reopen || null;
}

/**
 * Show the Windows folder picker through the helper. The background keeps the answer (in the
 * job's draft or the settings) and reopens the popup if the dialog closed it; when this popup is
 * still open, the reply updates the field right here. null = cancelled.
 */
async function pickFolder(field, start, jobId) {
  saveDrafts(true);
  const r = await send("pickFolder", { field, start, jobId });
  return r?.ok ? r.path : null;
}

/**
 * A folder field: Browse... (when the helper can show the folder picker), then the text box.
 * `compact` keeps the label for screen readers only, as in the ready view's design.
 */
function folderField(label, d, jobId, { compact = false } = {}) {
  const id = `folder-${jobId}`;
  const input = h("input", { id, type: "text", value: d.output, spellcheck: "false", placeholder: "Choose a folder" });
  input.addEventListener("input", () => {
    d.output = input.value;
    saveDrafts();
  });
  const browse = hasFeature("pick_folder")
    ? h(
        "button",
        {
          class: "btn browse",
          type: "button",
          "aria-label": `Browse for the folder to ${label.toLowerCase()}`,
          onclick: async () => {
            const path = await pickFolder("output", d.output.trim(), jobId);
            if (path) {
              d.output = input.value = path;
              saveDrafts();
            }
          },
        },
        "Browse...",
      )
    : null;
  return h(
    "div",
    { class: "field" },
    h("label", { for: id, class: compact ? "sr-only" : null }, label),
    h("div", { class: "path-row" }, browse, input),
  );
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "session") return;
  if (changes.jobs) st.jobs = changes.jobs.newValue || {};
  if ("current" in changes) st.current = changes.current.newValue || null;
  if (changes.hostInfo) st.hostInfo = changes.hostInfo.newValue || null;
  if (changes.hostError) st.hostError = changes.hostError.newValue || null;
  render();
});

function currentJob() {
  return st.current ? st.jobs[st.current] || null : null;
}

function render() {
  renderChip();
  const job = currentJob();
  const sig = job ? `${job.id}:${job.phase}` : "pick";
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
  // Not while something is running: the card would only distract.
  const card = !job || !["inspecting", "extracting"].includes(job.phase) ? updateCard() : null;
  if (card) view.append(card);
  if (job && !first) announce(spokenState(job));
}

function statusText(job) {
  if (!job) return st.hostError ? "Setup needed" : "Ready";
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
      return `${job.name}: ${r.files.toLocaleString()} files. Choose a folder, then Extract.`;
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

/** A newer helper is available: say so once per browser session, without blocking anything. */
function updateCard() {
  if (updateLater || !helperNeedsUpdate(st.hostInfo)) return null;
  const card = h(
    "div",
    { class: "card update", role: "note" },
    h("p", {}, h("b", {}, "A newer LinkUnzip helper is available."), " It adds Browse..., choosing files and Resume. This one keeps working meanwhile."),
    h(
      "div",
      { class: "row" },
      h("button", { class: "link", onclick: () => openSetup("update") }, "Update the helper"),
      h("button", {
        class: "link quiet",
        onclick: () => {
          updateLater = true;
          chrome.storage.session.set({ updateLater: true });
          card.remove();
        },
      }, "Later"),
    ),
  );
  return card;
}

function renderChip() {
  document.getElementById("set-base-browse").hidden = !hasFeature("pick_folder");
  const chip = document.getElementById("host-chip");
  const [state, word, title] = st.hostInfo
    ? ["ok", "✓ Active", `LinkUnzip helper ${st.hostInfo.version} is connected`]
    : st.hostError
      ? ["bad", "✗ Not installed", "The LinkUnzip helper isn't connected"]
      : ["unknown", "Connecting...", ""];
  chip.dataset.state = state;
  chip.title = title;
  chip.replaceChildren("Helper Status ", h("b", {}, word));
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

function openSetup(mode) {
  chrome.tabs.create({ url: chrome.runtime.getURL(mode === "update" ? "welcome.html?update=1" : "welcome.html") });
  window.close();
}

function hostBanner() {
  if (!st.hostError) return null;
  return h(
    "div",
    { class: "card" },
    h("p", {}, st.hostError.message),
    h("div", { class: "btn-row" }, h("button", { class: "btn primary", onclick: openSetup }, "Set up LinkUnzip")),
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
      h("span", {}, "Free space: ", h("b", {}, r.free == null ? "unknown" : humanBytes(r.free)), room),
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
    const some = Boolean(d.include.trim()) || (selection && !selection.all);
    const verb = some ? "Start Filtered Extraction" : "Start Extraction";
    if (selection?.none || d.include.trim()) return verb;
    const m = selection?.measured || (!selection || selection.all ? { files: r.files, extracted: r.extracted } : null);
    return m ? `${verb} (${m.files.toLocaleString()} ${m.files === 1 ? "file" : "files"}, ${humanBytes(m.extracted)})` : verb;
  };
  const go = h("button", { class: "btn primary", id: "extract-btn" }, "Start Extraction");
  const updateGo = () => {
    go.disabled = Boolean(selection?.none) || (!fitsNow() && !d.force);
    go.textContent = goLabel();
  };
  go.addEventListener("click", async () => {
    const folder = d.output.trim();
    problem.hidden = false;
    if (!folder) return (problem.textContent = "Choose a folder to extract into.");
    if (selection?.none) return (problem.textContent = "Tick at least one file to extract.");
    problem.hidden = true;
    const res = await send("extract", {
      id: job.id,
      output: folder,
      include: d.include.split(",").map((s) => s.trim()).filter(Boolean),
      select: selection?.select,
      connections: settings.connections,
      force: !fitsNow() && d.force,
    });
    if (res && !res.ok) {
      problem.textContent = res.error;
      problem.hidden = false;
    }
  });

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
          features: { search: hasFeature("search"), measure: hasFeature("measure") },
          api: {
            list: (dir, offset, limit) => send("list", { id: job.id, dir, offset, limit }),
            search: (query) => send("search", { id: job.id, query }),
            measure: (select) => send("measure", { id: job.id, select }),
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
  bar.prepend(...[force, problem].filter(Boolean));

  // With the file list the panel fills the popup and the list takes the height that is left.
  if (chooser) document.body.classList.add("fill");
  show(
    h("div", { class: "card main" }, cost, chooser?.el),
    r.unsupported > 0
      ? h("p", { class: "notice" }, `${r.unsupported} file(s) use encryption or a compression LinkUnzip cannot read (e.g. ${r.unsupported_sample[0].name}). ${chooser ? "Untick them or use" : "Use"} the filter to skip them.`)
      : null,
    filter,
    folderField("Extract into", d, job.id, { compact: true }),
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
  const verified =
    r.verified_files == null
      ? null
      : r.verified_files === r.files && r.files > 1
        ? `✓ All ${files(r.files)} verified`
        : `✓ ${files(r.verified_files)} verified`;
  show(
    panel(
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
        r.renamed ? h("dt", {}, "Renamed for Windows") : null, r.renamed ? h("dd", {}, `${r.renamed} files`) : null,
      ),
      h("p", { class: "path" }, r.output),
    ),
    actionBar([h("button", { class: "btn primary", onclick: () => send("reveal", { path: r.output }) }, "Open folder"), dismissBtn("Extract another")]),
  );
}

/** Resume a stopped or failed extraction: only helpers with `resume` skip what is already there. */
const canResume = (job) => Boolean(job.lastExtract) && hasFeature("resume");

function cancelledView(job) {
  const r = job.result || {};
  const resume = canResume(job);
  show(
    panel(
      h(
        "div",
        { class: "hero" },
        h("div", { class: "tick bad", "aria-hidden": "true" }, "■"),
        h("h1", {}, "Stopped"),
        h("p", { class: "muted" }, `${(r.files_done || 0).toLocaleString()} files were already finished and stay in the folder. Half-written files were removed.`),
      ),
      resume ? h("p", { class: "muted small" }, "Resume carries on into the same folder: files already there are checked and skipped, not downloaded again.") : null,
    ),
    actionBar([
      resume ? h("button", { class: "btn primary", onclick: () => send("resume", { id: job.id }) }, "Resume") : null,
      r.output ? h("button", { class: "btn", onclick: () => send("reveal", { path: r.output }) }, "Open folder") : null,
      dismissBtn("Close"),
    ]),
  );
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

// What using a login means, said before Chrome's permission prompt (store policy: disclose first).
const loginUse = (host) =>
  `your browser's cookies for ${host} go to the LinkUnzip helper on this PC, which sends them only to ${host}. Nothing goes to LinkUnzip itself.`;

const LOGIN_REFUSED = "No problem. Without your login LinkUnzip can't read this download, but you can still download it normally.";

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
    case "host_missing":
    case "host_forbidden":
      return { title: "LinkUnzip isn't connected yet", text: e.message, actions: ["setup", "download"] };
    case "host":
    case "host_silent":
      return { title: "LinkUnzip stopped answering", text: e.message, actions: ["retry", "download"] };
    case "no_range":
      return {
        title: "This server can't send parts of the file",
        text: "It answered 200 OK with the whole file instead of 206 Partial Content.",
        more: "Servers like GitHub's 'Download ZIP' build the file while they send it, so it can only be read from the start. LinkUnzip can still extract it in one pass: one connection, no size preview, and the zip is still never saved.",
        folder: true,
        actions: ["stream", "download"],
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
          text: `The site says you need to be signed in. LinkUnzip can use your login on ${host}: ${loginUse(host)} Chrome asks you once, then the download starts again by itself.`,
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
  const helper = st.hostInfo ? `${st.hostInfo.version} (protocol ${st.hostInfo.protocol ?? 1})` : "not connected";
  return [
    `LinkUnzip extension ${chrome.runtime.getManifest().version}`,
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
function askForLogin(job, note) {
  send("awaitLogin", { id: job.id }); // in case Chrome's prompt closes this popup
  chrome.permissions.request({ origins: [sitePattern(job.url)] }).then(
    (granted) => {
      if (!granted) note.textContent = LOGIN_REFUSED;
      send("loginAnswer", { id: job.id, granted });
    },
    () => send("loginAnswer", { id: job.id, granted: false }),
  );
}

function errorView(job) {
  const e = job.error || { code: "failed", message: "Something went wrong." };
  const info = describeError(job, e);
  const host = hostOf(job.url);
  const web = /^https?:/i.test(job.url);
  const d = draftFor(job);
  const note = h("p", { class: "muted small", role: "status" }, job.loginRefused ? LOGIN_REFUSED : "");
  const problem = h("p", { class: "notice bad", hidden: true });

  const folder = () => {
    const path = d.output.trim();
    problem.hidden = Boolean(path);
    problem.textContent = path ? "" : "Choose a folder to extract into.";
    return path;
  };

  const actions = {
    setup: () => h("button", { onclick: openSetup }, "Set up LinkUnzip"),
    stream: () =>
      h("button", {
        onclick: () => {
          const path = folder();
          if (path) send("extract", { id: job.id, output: path, include: [], connections: 1, stream: true });
        },
      }, "Stream it anyway"),
    // The same extraction as before, into the folder now in the field.
    extractHere: () =>
      h("button", {
        onclick: () => {
          const path = folder();
          if (!path) return;
          if (job.lastExtract) send("extract", { ...job.lastExtract, id: job.id, output: path });
          else send("retry", { id: job.id });
        },
      }, "Extract here"),
    login: () => h("button", { onclick: () => askForLogin(job, note) }, `Use my login on ${host}`),
    retry: () => h("button", { onclick: () => send("retry", { id: job.id }) }, "Try again"),
    resume: () => h("button", { onclick: () => send("resume", { id: job.id }) }, "Resume"),
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
      info.folder ? folderField("Extract into", d, job.id) : null,
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
    baseFolder: document.getElementById("set-base"),
    connections: document.getElementById("set-jobs"),
    loginWhenNeeded: document.getElementById("set-login"),
    catchDownloads: document.getElementById("set-catch"),
  };
  const save = () => {
    settings = {
      baseFolder: fields.baseFolder.value.trim(),
      connections: Math.min(16, Math.max(1, Number(fields.connections.value) || 4)),
      loginWhenNeeded: fields.loginWhenNeeded.checked,
      catchDownloads: fields.catchDownloads.checked,
      theme: settings.theme,
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
  fields.baseFolder.value = settings.baseFolder;
  fields.connections.value = settings.connections;
  fields.loginWhenNeeded.checked = settings.loginWhenNeeded;
  fields.catchDownloads.checked = settings.catchDownloads;
  for (const el of Object.values(fields)) el.addEventListener("change", save);

  document.getElementById("set-base-browse").addEventListener("click", async () => {
    const path = await pickFolder("baseFolder", fields.baseFolder.value.trim() || st.hostInfo?.downloads_dir || "");
    if (path) {
      fields.baseFolder.value = path;
      save();
    }
  });

  // "Every site" is Chrome's permission itself, not a stored setting: ask on, remove off.
  const everySite = document.getElementById("set-login-all");
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
    const i = st.hostInfo;
    document.getElementById("host-info").textContent = i
      ? `LinkUnzip helper ${i.version} (protocol ${i.protocol ?? 1})${helperNeedsUpdate(i) ? ", update available" : ""} · ${i.os} · downloads: ${i.downloads_dir}`
      : "helper not connected";
  };
  button.addEventListener("click", () => toggle(panel.hidden));
  document.getElementById("settings-done").addEventListener("click", () => {
    toggle(false);
    button.focus();
  });
  return toggle;
}

// ---------------------------------------------------------------------------------------

const reopenedFor = await loadState();
const toggleSettings = setupSettings();
if (reopenedFor === "settings") toggleSettings(true);
render();
send("ping").then((r) => {
  const helperKey = () => `${st.hostInfo?.protocol}|${st.hostInfo?.version}|${st.hostInfo?.features}`;
  const before = helperKey();
  if (r?.info) st.hostInfo = r.info;
  if (r && !r.ok && r.error) st.hostError = r.error;
  if (r?.ok) st.hostError = null;
  renderChip();
  // Show the install hint if the host turned out to be missing, or what this helper allows.
  if (!currentJob() || helperKey() !== before) {
    drawn = "";
    render();
  }
});
