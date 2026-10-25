// "Choose files" in the ready view: browse the zip's folders, tick what to extract, search by name
// or pattern (`*.jpg`) and see live totals. popup.js shows it when the engine has `list` and
// `select`; `search` and `measure` add the search box and the totals.
//
// The selection is kept as marks: path -> ticked or not, where a path is a file, a folder ending
// in "/", or "" for the whole zip, and every entry follows its nearest marked parent. The engine
// gets the marks as they are (`select: {marks}`) and applies the same rule, so any mix of ticks
// can be said, however big the folders.
//
// Folders can hold 100,000+ files (COCO), so at most WINDOW rows are ever on the page, fetched a
// page at a time.

import { h } from "./dom.js";
import { humanBytes } from "./fmt.js";

const PAGE = 500;
const WINDOW = 2000; // rows on the page at most: "Show more" past that lets go of the first ones
/** File types offered as search chips (the most common ones in the zip). */
const CHIPS = 4;

// ---------------------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------------------

const isFolder = (path) => path === "" || path.endsWith("/");
const depth = (path) => path.split("/").filter(Boolean).length;

/** "a/b/c.txt" -> "a/b/", "a/b/" -> "a/", "a/" -> "", and "" (the whole zip) -> null. */
export function parentOf(path) {
  if (path === "") return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i + 1);
}

/** Strictly inside a folder ("" = the whole zip). */
function inside(path, folder) {
  return isFolder(folder) && path !== folder && path.startsWith(folder);
}

/** The mark of the nearest marked parent (or the path's own); the whole zip is ticked by default. */
export function isTicked(marks, path) {
  for (let p = path; p !== null; p = parentOf(p)) {
    if (p in marks) return marks[p];
  }
  return true;
}

/** Drop the marks that only repeat what their parent says. */
function normalize(marks) {
  for (const k of Object.keys(marks).sort((a, b) => depth(a) - depth(b))) {
    const parent = parentOf(k);
    if (marks[k] === (parent === null ? true : isTicked(marks, parent))) delete marks[k];
  }
}

export function setTicked(marks, path, ticked) {
  for (const k of Object.keys(marks)) if (inside(k, path)) delete marks[k];
  marks[path] = ticked;
  normalize(marks);
}

/** "on", "off", or "mixed" for a folder with marks inside that differ from its own state. */
function tickState(marks, keys, path) {
  const ticked = isTicked(marks, path);
  if (isFolder(path) && keys.some((k) => inside(k, path) && marks[k] !== ticked)) return "mixed";
  return ticked ? "on" : "off";
}

/** The selection as the engine takes it: `all`, `none`, or `select: {marks}`. */
export function toSelect(marks) {
  const keys = Object.keys(marks);
  if (!keys.length) return { all: true };
  if (marks[""] === false && !keys.some((k) => marks[k])) return { none: true };
  return { select: { marks: { ...marks } } };
}

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

const plural = (n, word, many = `${word}s`) => `${n.toLocaleString()} ${n === 1 ? word : many}`;
const norm = (item) => (item.dir && !item.path.endsWith("/") ? { ...item, path: `${item.path}/` } : item);

/**
 * `api.list(dir, offset, limit)`, `api.search(query)`, `api.measure(select)` and
 * `api.tickMatches(marks, query, ticked)` answer like the background commands; `onChange(selection)`
 * hears every change (selection as from toSelect, plus `measured` once known). `draft` keeps the
 * marks, folder and search across popup reopens.
 */
export function fileList({ job, draft, features, api, onChange, actions = [], toolbar = null }) {
  const report = job.report;
  const marks = (draft.marks ??= {});
  const st = { dir: draft.dir || "", query: draft.query || "", start: 0, items: [], total: 0, focus: 0 };
  let rootListing = report.root_dirs ? (Array.isArray(report.root_dirs) ? { total: report.root_dirs.length, items: report.root_dirs } : report.root_dirs) : null;

  const summary = h("span", { class: "fl-sum" }, "All files");
  const search = features.search
    ? h("input", { type: "search", class: "fl-search", placeholder: "Filter or *.jpg", "aria-label": "Filter: search file names in the zip, or a pattern like *.jpg", spellcheck: "false" })
    : null;
  if (search) search.value = st.query;
  // One click to every file of a common type: "*.jpg" as the search.
  const types = (report.extensions || []).slice(0, CHIPS);
  const chips =
    search && types.length >= 2
      ? h(
          "div",
          { class: "fl-chips", role: "group", "aria-label": "Find files of one type" },
          ...types.map(({ ext, files }) =>
            h("button", { type: "button", class: "chip-btn", "data-q": `*.${ext}`, title: `${plural(files, `.${ext} file`)}`, "aria-pressed": "false" }, `*.${ext}`),
          ),
        )
      : null;
  const crumbs = h("nav", { class: "fl-crumbs", "aria-label": "Folder" });
  const count = h("span", { class: "fl-count" });
  const allBtn = h("button", { type: "button", class: "link small" }, "Select all");
  const noneBtn = h("button", { type: "button", class: "link small" }, "Select none");
  const earlier = h("button", { type: "button", class: "btn fl-more", hidden: true }, "Show earlier");
  const more = h("button", { type: "button", class: "btn fl-more", hidden: true }, "Show more");
  const rows = h("div", { class: "fl-rows", role: "group", "aria-label": "Files and folders. Arrow keys move, Space ticks, Enter opens a folder, Backspace goes up." });
  const notice = h("p", { class: "notice", hidden: true });
  const totals = h("span", { class: "fl-totals", role: "status", "aria-live": "polite" });
  // Where you are and how many: only needed inside a folder, in search results or across pages.
  const nav = h("div", { class: "fl-nav" }, crumbs, count);
  const box = h(
    "section",
    { class: "fl", "aria-label": "File list" },
    h("div", { class: "fl-head" }, h("h2", {}, "File List ", h("span", {}, "(Select files for extraction)")), search),
    chips,
    toolbar,
    nav,
    notice,
    h("div", { class: "fl-box" }, h("div", { class: "fl-scroll" }, earlier, rows, more)),
    h("div", { class: "fl-foot" }, h("p", {}, summary, " · ", totals), h("span", { class: "fl-actions" }, allBtn, noneBtn, ...actions)),
  );

  // ---- loading ------------------------------------------------------------------------------

  function failed(r) {
    showNotice(r?.error?.message || "LinkUnzip couldn't read the list of files.");
    return null;
  }

  async function listPage(dir, offset, limit) {
    if (dir === "" && offset === 0 && rootListing && limit <= PAGE) return rootListing;
    const r = await api.list(dir, offset, limit);
    return r?.ok ? r.listing : failed(r);
  }

  async function showFolder(dir, offset = 0) {
    const page = await listPage(dir, offset, PAGE);
    if (!page) return;
    Object.assign(st, { dir, query: "", start: offset, items: page.items.map(norm), total: page.total, focus: 0 });
    if (dir === "") rootListing = rootListing || page;
    draft.dir = dir;
    draft.query = "";
    if (search) search.value = "";
    draw();
  }

  async function showMore() {
    const page = await listPage(st.dir, st.start + st.items.length, PAGE);
    if (!page) return;
    const first = st.items.length;
    st.items.push(...page.items.map(norm));
    st.focus = first;
    if (st.items.length > WINDOW) {
      const drop = st.items.length - WINDOW;
      st.items.splice(0, drop);
      st.start += drop;
      st.focus -= drop;
    }
    draw(true);
  }

  async function showEarlier() {
    const from = Math.max(0, st.start - PAGE);
    const page = await listPage(st.dir, from, st.start - from);
    if (!page) return;
    st.items.unshift(...page.items.map(norm));
    st.start = from;
    st.items.length = Math.min(st.items.length, WINDOW);
    st.focus = 0;
    draw(true);
  }

  let searchTimer = null;
  async function runSearch() {
    const query = search.value.trim();
    draft.query = query;
    if (!query) return showFolder(st.dir);
    const r = await api.search(query);
    if (search.value.trim() !== query) return; // a newer search is on its way
    if (!r?.ok) return failed(r);
    Object.assign(st, { query, start: 0, items: r.results.items.map(norm), total: r.results.total, focus: 0 });
    draw();
  }

  // ---- drawing ------------------------------------------------------------------------------

  function crumb(label, dir, current) {
    return h("button", { type: "button", class: "link", "aria-current": current ? "location" : null, onclick: () => showFolder(dir) }, label);
  }

  function draw(keepFocus = false) {
    notice.hidden = true;
    if (st.query) {
      // Search covers the whole zip; the way back leads to the folder that was open.
      const back = st.dir ? st.dir.split("/").filter(Boolean).pop() : "All files";
      crumbs.replaceChildren(crumb(back, st.dir, false), h("span", { class: "sep", "aria-hidden": "true" }, "›"), h("span", {}, "Search results"));
      const matches = plural(st.total, "match", "matches");
      count.textContent = st.total > st.items.length ? `first ${st.items.length.toLocaleString()} of ${matches}` : matches;
    } else {
      const parts = st.dir.split("/").filter(Boolean);
      const nodes = [crumb("All files", "", parts.length === 0)];
      parts.forEach((part, i) => {
        nodes.push(h("span", { class: "sep", "aria-hidden": "true" }, "›"), crumb(part, `${parts.slice(0, i + 1).join("/")}/`, i === parts.length - 1));
      });
      crumbs.replaceChildren(...nodes);
      const shown = st.items.length < st.total ? ` · showing ${(st.start + 1).toLocaleString()}-${(st.start + st.items.length).toLocaleString()}` : "";
      count.textContent = `${plural(st.total, "item")}${shown}`;
    }
    earlier.hidden = Boolean(st.query) || st.start === 0;
    more.hidden = Boolean(st.query) || st.start + st.items.length >= st.total;
    nav.hidden = !st.query && st.dir === "" && st.start === 0 && st.items.length >= st.total;
    const keys = Object.keys(marks);
    rows.replaceChildren(...st.items.map((item, i) => row(item, i, keys)));
    if (!st.items.length) rows.append(h("p", { class: "fl-empty" }, st.query ? "No file names match." : "This folder is empty."));
    if (keepFocus) focusRow(st.focus);
    // In search results, Select all / none cover every match, not only the rows on the page.
    const wide = Boolean(st.query) && features.tickMatches && st.total > 0;
    allBtn.textContent = wide ? `Select all ${st.total.toLocaleString()}` : "Select all";
    allBtn.title = wide ? `Tick every file the search finds (${plural(st.total, "match", "matches")})` : "";
    noneBtn.title = wide ? "Untick every file the search finds" : "";
    if (chips) for (const b of chips.children) b.setAttribute("aria-pressed", String(b.dataset.q === st.query));
  }

  function row(item, i, keys) {
    const state = tickState(marks, keys, item.path);
    const id = `fl-${i}`;
    const cb = h("input", { type: "checkbox", id, "data-i": String(i), tabindex: i === st.focus ? "0" : "-1" });
    cb.checked = state === "on";
    cb.indeterminate = state === "mixed";
    const size = item.dir ? `${plural(item.files ?? 0, "file")} · ${humanBytes(item.size)}` : humanBytes(item.size);
    cb.setAttribute("aria-label", item.dir ? `${item.name}, folder, ${size}` : `${item.name}, ${size}`);
    const name = item.dir
      ? h("button", { type: "button", class: "fl-name dir", tabindex: "-1", title: "Open the folder", onclick: () => showFolder(item.path) }, `${item.name}/`)
      : h("label", { class: "fl-name", for: id }, item.name);
    return h(
      "div",
      { class: `fl-row${state === "off" ? " off" : ""}` },
      cb,
      h("span", { class: `fl-icon${item.dir ? " dir" : ""}`, "aria-hidden": "true" }),
      h(
        "span",
        { class: "fl-main" },
        name,
        st.query ? h("span", { class: "fl-path" }, parentOf(item.path)) : null,
        item.unsupported ? h("span", { class: "fl-tag", title: "LinkUnzip can't extract this file" }, item.unsupported) : null,
      ),
      h("span", { class: "fl-size" }, size),
      !item.dir && features.preview && !item.unsupported
        ? h("button", { type: "button", class: "fl-peek", tabindex: "-1", title: `Preview ${item.name}`, "aria-label": `Preview ${item.name}`, onclick: () => api.preview(item.path) })
        : null,
    );
  }

  /** Update the ticks in place (no rebuild: focus and scroll stay where they are). */
  function refreshTicks() {
    const keys = Object.keys(marks);
    for (const cb of rows.querySelectorAll("input[type=checkbox]")) {
      const state = tickState(marks, keys, st.items[cb.dataset.i].path);
      cb.checked = state === "on";
      cb.indeterminate = state === "mixed";
      cb.closest(".fl-row").classList.toggle("off", state === "off");
    }
  }

  function focusRow(i) {
    const boxes = rows.querySelectorAll("input[type=checkbox]");
    if (!boxes.length) return;
    st.focus = Math.max(0, Math.min(boxes.length - 1, i));
    boxes.forEach((b, j) => (b.tabIndex = j === st.focus ? 0 : -1));
    boxes[st.focus].focus();
    boxes[st.focus].scrollIntoView({ block: "nearest" });
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
  }

  // ---- ticking ------------------------------------------------------------------------------

  function tick(paths, ticked) {
    for (const p of paths) setTicked(marks, p, ticked);
    // Every entry of this folder ticked the same way one by one: say it with the folder itself.
    if (!st.query && st.start === 0 && st.items.length === st.total && st.items.length) {
      const keys = Object.keys(marks);
      const states = new Set(st.items.map((it) => tickState(marks, keys, it.path)));
      if (states.size === 1 && !states.has("mixed")) setTicked(marks, st.dir, states.has("on"));
    }
    refreshTicks();
    changed();
  }

  /** Select all / none in search results: every match, worked out by the engine. */
  async function tickAllMatches(ticked) {
    const query = st.query;
    const r = await api.tickMatches({ ...marks }, query, ticked);
    if (st.query !== query) return;
    if (!r?.ok) return failed(r);
    for (const k of Object.keys(marks)) delete marks[k];
    Object.assign(marks, r.marks);
    refreshTicks();
    changed();
  }

  const selectAll = (ticked) => {
    if (st.query && features.tickMatches) return tickAllMatches(ticked);
    tick(st.query ? st.items.map((it) => it.path) : [st.dir], ticked);
  };

  rows.addEventListener("change", (e) => {
    const i = e.target.dataset?.i;
    if (i !== undefined) {
      st.focus = Number(i);
      tick([st.items[i].path], e.target.checked);
    }
  });

  rows.addEventListener("keydown", (e) => {
    if (e.target.type !== "checkbox") return;
    const i = Number(e.target.dataset.i);
    const item = st.items[i];
    switch (e.key) {
      case "ArrowDown":
        focusRow(i + 1);
        break;
      case "ArrowUp":
        focusRow(i - 1);
        break;
      case "PageDown":
        focusRow(i + 10);
        break;
      case "PageUp":
        focusRow(i - 10);
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(st.items.length - 1);
        break;
      case "Enter":
      case "ArrowRight":
        if (!item.dir) return;
        showFolder(item.path).then(() => focusRow(0));
        break;
      case "Backspace":
      case "ArrowLeft":
        if (st.query || st.dir === "") return;
        showFolder(parentOf(st.dir)).then(() => focusRow(0));
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  allBtn.addEventListener("click", () => selectAll(true));
  noneBtn.addEventListener("click", () => selectAll(false));
  chips?.addEventListener("click", (e) => {
    const q = e.target.closest?.("button")?.dataset.q;
    if (!q) return;
    // The same chip again clears the search.
    search.value = st.query === q ? "" : q;
    clearTimeout(searchTimer);
    runSearch();
  });
  more.addEventListener("click", showMore);
  earlier.addEventListener("click", showEarlier);
  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });
  search?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(0);
    }
  });

  // ---- totals -------------------------------------------------------------------------------

  let measureTimer = null;
  let measuring = false;
  let measureAgain = false;

  function changed() {
    const sel = toSelect(marks);
    summary.textContent = sel.all ? "All files" : sel.none ? "No files" : "Some files";
    onChange(sel);
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measure, 250);
  }

  function showTotals(m) {
    totals.textContent = `${plural(m.files, "file")}, ${humanBytes(m.extracted)} to write, about ${humanBytes(m.compressed)} to download`;
  }

  async function measure() {
    if (measuring) {
      measureAgain = true;
      return;
    }
    const sel = toSelect(marks);
    if (sel.all) {
      showTotals({ files: report.files, extracted: report.extracted, compressed: report.compressed });
      return onChange({ ...sel, measured: null });
    }
    if (sel.none) {
      totals.textContent = "No files ticked.";
      return;
    }
    if (!features.measure) {
      totals.textContent = "";
      return;
    }
    measuring = true;
    const r = await api.measure(sel.select);
    measuring = false;
    if (measureAgain) {
      measureAgain = false;
      return measure();
    }
    if (!r?.ok) {
      totals.textContent = "";
      return;
    }
    if (JSON.stringify(toSelect(marks)) !== JSON.stringify(sel)) return; // ticked meanwhile: its own measure() follows
    // Nothing left under the ticks (Select none inside the zip's only folder): say it with the zip
    // itself, so the totals read "No files" and a file ticked next is sayable as `select`.
    if (r.measured.files === 0) {
      for (const k of Object.keys(marks)) delete marks[k];
      marks[""] = false;
      refreshTicks();
      summary.textContent = "No files";
      totals.textContent = "No files ticked.";
      return onChange(toSelect(marks));
    }
    showTotals(r.measured);
    onChange({ ...sel, measured: r.measured });
  }

  // The list is always shown: open where the user left it (folder or search).
  if (st.query && search) runSearch();
  else showFolder(st.dir);
  changed();

  return { el: box, selection: () => toSelect(marks) };
}
