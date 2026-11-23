// "Choose files" in the ready view: the zip as a tree whose folders open in place, a tick on every
// file and folder, search by name or pattern (`*.jpg`), a filter by type and live totals.
//
// The selection is kept as marks: path -> ticked or not, where a path is a file, a folder ending
// in "/", or "" for the whole zip, and every entry follows its nearest marked parent. The engine
// gets the marks as they are (`select: {marks}`) and applies the same rule, so any mix of ticks
// can be said, however big the folders.
//
// Folders can hold 100,000+ files (COCO), so a folder's contents come a page at a time, and only
// the folders that are open are on the page.

import { h } from "./dom.js";
import { extensionOf, humanBytes, parentOf, safeName } from "./fmt.js";
import { num, t, tn } from "./i18n.js";

const PAGE = 500;

/** What a file is, by its type: the mark before its name, and the filter's kinds. */
const TYPES = {
  image: "jpg jpeg png gif webp bmp tif tiff svg heic avif ico",
  video: "mp4 mov mkv webm avi m4v",
  audio: "mp3 wav flac ogg m4a aac",
  pdf: "pdf",
  doc: "txt md doc docx odt rtf epub tex rst log html htm ppt pptx odp",
  data: "csv tsv json jsonl ndjson xml yaml yml parquet npy npz h5 hdf5 sqlite db arrow feather pkl xls xlsx ods tfrecord",
  code: "js mjs ts jsx tsx py rs go c h cpp hpp java cs rb php sh ps1 bat css kt swift lua",
  archive: "zip 7z rar tar gz tgz bz2 xz zst jar apk whl",
  app: "exe dll msi so dylib",
};
const typeByExt = new Map(Object.entries(TYPES).flatMap(([type, exts]) => exts.split(" ").map((e) => [e, type])));
const typeOf = (path) => typeByExt.get(extensionOf(path)) || "file";
const extsOf = (...types) => types.flatMap((type) => TYPES[type].split(" "));

/** The type filter. A kind is offered when one of the zip's most common types is in it. */
const KINDS = [
  { key: "media", label: () => t("Media"), exts: extsOf("image", "video", "audio") },
  { key: "docs", label: () => t("Docs"), exts: extsOf("pdf", "doc") },
  { key: "data", label: () => t("Data"), exts: extsOf("data") },
];

// ---------------------------------------------------------------------------------------
// The selection
// ---------------------------------------------------------------------------------------

const isFolder = (path) => path === "" || path.endsWith("/");
const depth = (path) => path.split("/").filter(Boolean).length;

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

const fileCount = (n) => tn("{count} file", "{count} files", n);
const matchCount = (n) => tn("{count} match", "{count} matches", n);
const norm = (item) => (item.dir && !item.path.endsWith("/") ? { ...item, path: `${item.path}/` } : item);
const ARIA_CHECKED = { on: "true", off: "false", mixed: "mixed" };

/**
 * `api.list(dir, offset, limit)`, `api.search(query)`, `api.measure(select)` and
 * `api.tickMatches(marks, query, ticked)` answer like the background commands; `onChange(selection)`
 * hears every change (selection as from toSelect, plus `measured` once known). `draft` keeps the
 * marks, the open folders and the search across popup reopens (`save()` after it changes).
 * `announce(text)` tells screen readers about a problem shown in the list's notice.
 */
export function fileList({ job, draft, features, api, onChange, save = () => {}, actions = [], toolbar = null, announce = () => {} }) {
  const report = job.report;
  const marks = (draft.marks ??= {});
  const open = new Set(draft.open || []);
  const kinds = KINDS.filter((k) => (report.extensions || []).some((e) => k.exts.includes(e.ext)));
  const st = { kind: kinds.some((k) => k.key === draft.kind) ? draft.kind : "", results: null, focus: null };
  // Each folder's entries as far as loaded: dir -> { items, total }. The root's first page comes
  // with the report.
  const loaded = new Map();
  const root = report.root_dirs;
  if (root) {
    const listing = Array.isArray(root) ? { total: root.length, items: root } : root;
    loaded.set("", { total: listing.total, items: listing.items.map(norm) });
  }
  const itemOf = new WeakMap(); // tree row -> its entry

  const summary = h("span", { class: "fl-sum" }, t("All files"));
  const totals = h("span", { class: "fl-totals", role: "status", "aria-live": "polite" });
  const search = features.search
    ? h("input", { type: "search", class: "fl-search", placeholder: t("Filter or *.jpg"), "aria-label": t("Filter: search file names in the zip, or a pattern like *.jpg"), spellcheck: "false" })
    : null;
  if (search) search.value = draft.query || "";
  // All, Media, Docs, Data: one at a time, so a radio group.
  const kindBtns = kinds.length
    ? [{ key: "", label: () => t("All") }, ...kinds].map((k) =>
        h("button", { type: "button", role: "radio", "data-kind": k.key, "aria-checked": String(st.kind === k.key), tabindex: st.kind === k.key ? "0" : "-1" }, k.label()),
      )
    : [];
  const kindGroup = kindBtns.length ? h("div", { class: "fl-kinds", role: "radiogroup", "aria-label": t("Find files of one type") }, ...kindBtns) : null;
  const zipSize = h("span", { class: "fl-zip" }, `${fileCount(report.files)} · ${humanBytes(report.extracted)}`);
  const count = h("span", { class: "fl-count" });
  const allBtn = h("button", { type: "button", class: "link small" }, t("Select all"));
  const noneBtn = h("button", { type: "button", class: "link small" }, t("Select none"));
  const helpId = `fl-help-${job.id}`;
  const help = h(
    "p",
    { id: helpId, class: "sr-only" },
    features.preview || features.inner
      ? t("Arrow keys move, Right opens a folder and Left closes it, Space ticks, Enter opens a zip in the zip, Enter or P previews a file.")
      : t("Arrow keys move, Right opens a folder and Left closes it, Space ticks."),
  );
  const tree = h("div", { class: "fl-tree", role: "tree", "aria-label": t("File List"), "aria-describedby": helpId });
  const notice = h("p", { class: "notice", hidden: true });
  // Search results: how many, and Select all / none for every match.
  const nav = h("div", { class: "fl-nav", hidden: true }, count, h("span", { class: "fl-actions" }, allBtn, noneBtn));
  const box = h(
    "section",
    { class: "fl", "aria-label": t("File List") },
    search ? h("div", { class: "fl-head" }, search) : null,
    h("div", { class: "fl-bar" }, kindGroup, zipSize),
    toolbar,
    nav,
    notice,
    help,
    h("div", { class: "fl-box" }, h("div", { class: "fl-scroll" }, tree)),
    h("div", { class: "fl-foot" }, h("p", { class: "fl-sel" }, summary, totals), h("span", { class: "fl-actions" }, ...actions)),
  );

  // ---- loading ------------------------------------------------------------------------------

  function failed(r) {
    showNotice(r?.error?.message || t("LinkUnzip couldn't read the list of files."));
    return null;
  }

  async function listPage(dir, offset) {
    const r = await api.list(dir, offset, PAGE);
    return r?.ok ? { total: r.listing.total, items: r.listing.items.map(norm) } : failed(r);
  }

  /** Fill a folder's rows (`li` null: the top of the zip), then the folders open inside it. */
  async function fill(li, dir, level) {
    let page = loaded.get(dir);
    if (!page) {
      page = await listPage(dir, 0);
      if (!page) return;
      loaded.set(dir, page);
    }
    const kids = li ? li.querySelector(":scope > .fl-kids") : tree;
    kids.replaceChildren(...page.items.map((item) => node(item, level)));
    if (!page.items.length) kids.append(h("p", { class: "fl-empty" }, t("This folder is empty.")));
    moreButton(kids, dir, page, level);
    refreshTicks(kids);
    if (!st.focus || !st.focus.isConnected) setFocus(kids.querySelector("[role=treeitem]"), false);
    for (const child of kids.children) {
      const item = itemOf.get(child);
      if (item?.dir && open.has(item.path)) {
        child.setAttribute("aria-expanded", "true");
        await fill(child, item.path, level + 1);
      }
    }
  }

  /** "Show more" at the end of a folder that has more than one page. */
  function moreButton(kids, dir, page, level) {
    if (page.items.length >= page.total) return;
    const btn = h("button", { type: "button", class: "btn fl-more" }, t("Show more"));
    btn.addEventListener("click", async () => {
      const next = await listPage(dir, page.items.length);
      if (!next) return;
      page.items.push(...next.items);
      const rows = next.items.map((item) => node(item, level));
      btn.before(...rows);
      if (page.items.length >= page.total) btn.remove();
      refreshTicks(kids);
      setFocus(rows[0]);
    });
    kids.append(btn);
  }

  // ---- drawing ------------------------------------------------------------------------------

  function node(item, level) {
    const name = safeName(item.name);
    const size = item.dir ? `${fileCount(item.files ?? 0)} · ${humanBytes(item.size)}` : humanBytes(item.size);
    const row = h(
      "div",
      { class: `fl-row${item.dir ? " dir" : ""}` },
      item.dir && !st.results ? h("span", { class: "fl-twist", "aria-hidden": "true" }) : null,
      h("span", { class: "fl-tick", "aria-hidden": "true" }),
      h("span", { class: "fl-type", "data-type": item.dir ? "folder" : typeOf(item.path), "aria-hidden": "true" }),
      h(
        "span",
        { class: "fl-main" },
        h("span", { class: "fl-name" }, name),
        st.results ? h("span", { class: "fl-path" }, safeName(parentOf(item.path))) : null,
        item.unsupported ? h("span", { class: "fl-tag", title: t("LinkUnzip can't extract this file") }, item.unsupported) : null,
        item.locked ? h("span", { class: "fl-tag quiet", title: t("Password-protected: LinkUnzip asks for the password before it extracts") }, t("password")) : null,
      ),
      item.dir ? h("span", { class: "fl-n", "aria-hidden": "true" }, num(item.files ?? 0)) : null,
      h("span", { class: "fl-size", "aria-hidden": "true" }, humanBytes(item.size)),
      rowAction(item),
    );
    const li = h(
      "div",
      {
        class: "fl-node",
        role: "treeitem",
        tabindex: "-1",
        "aria-level": String(level),
        "aria-label": item.dir ? t("{name}, folder, {size}", { name, size }) : `${name}, ${size}`,
      },
      row,
    );
    if (item.dir && !st.results) {
      li.setAttribute("aria-expanded", "false");
      li.append(h("div", { class: "fl-kids", role: "group" }));
    }
    itemOf.set(li, item);
    return li;
  }

  /** What a file row offers: "open" for a zip inside the zip, "preview", or null. */
  function actionOf(item) {
    if (item.dir || item.unsupported) return null;
    if (features.inner && /\.zip$/i.test(item.name)) return "open";
    return features.preview ? "preview" : null;
  }

  /** The button at the end of a file row: Open for a zip inside the zip, else Preview. */
  function rowAction(item) {
    const action = actionOf(item);
    const name = safeName(item.name);
    if (action === "open") {
      return h("button", { type: "button", class: "fl-open", tabindex: "-1", title: t("Open {name}: its own file list", { name }), "aria-label": t("Open {name}", { name }), onclick: () => api.open(item.path) });
    }
    if (action !== "preview") return null;
    return h("button", { type: "button", class: "fl-peek", tabindex: "-1", title: t("Preview {name}", { name }), "aria-label": t("Preview {name}", { name }), onclick: () => api.preview(item.path) });
  }

  /** Every row on the page in reading order, skipping those inside closed folders. */
  function visibleRows() {
    const out = [];
    const walk = (parent) => {
      for (const li of parent.children) {
        if (li.getAttribute("role") !== "treeitem") continue;
        out.push(li);
        if (li.getAttribute("aria-expanded") === "true") walk(li.querySelector(":scope > .fl-kids"));
      }
    };
    walk(tree);
    return out;
  }

  /** The one row Tab lands on (roving focus); `move` also focuses it. */
  function setFocus(li, move = true) {
    if (!li) return;
    if (st.focus && st.focus !== li) st.focus.tabIndex = -1;
    st.focus = li;
    li.tabIndex = 0;
    if (move) {
      li.focus({ preventScroll: true });
      li.querySelector(":scope > .fl-row").scrollIntoView({ block: "nearest" });
    }
  }

  async function setOpen(li, want) {
    const item = itemOf.get(li);
    if (!item?.dir || st.results) return;
    li.setAttribute("aria-expanded", String(want));
    if (want) open.add(item.path);
    else open.delete(item.path);
    draft.open = [...open];
    save();
    const kids = li.querySelector(":scope > .fl-kids");
    if (want && !kids.childElementCount) await fill(li, item.path, Number(li.getAttribute("aria-level")) + 1);
  }

  /** Ticks drawn again in place (no rebuild: focus and scroll stay where they are). */
  function refreshTicks(scope = tree) {
    const keys = Object.keys(marks);
    for (const li of scope.querySelectorAll("[role=treeitem]")) {
      const state = tickState(marks, keys, itemOf.get(li).path);
      li.setAttribute("aria-checked", ARIA_CHECKED[state]);
      li.classList.toggle("off", state === "off");
    }
  }

  /** The tree of the zip again, as it was left (after a search is cleared). */
  async function showTree() {
    st.results = null;
    tree.classList.remove("flat");
    nav.hidden = true;
    tree.replaceChildren();
    st.focus = null;
    await fill(null, "", 1);
  }

  function showResults() {
    const { items, total } = st.results;
    tree.classList.add("flat");
    st.focus = null;
    tree.replaceChildren(...items.map((item) => node(item, 1)));
    if (!items.length) tree.append(h("p", { class: "fl-empty" }, t("No file names match.")));
    refreshTicks();
    setFocus(tree.querySelector("[role=treeitem]"), false);
    nav.hidden = false;
    const matches = matchCount(total);
    count.textContent = total > items.length ? t("first {shown} of {matches}", { shown: num(items.length), matches }) : matches;
    // Select all / none cover every match, not only the rows on the page.
    const wide = features.tickMatches && total > 0;
    allBtn.textContent = wide ? t("Select all {count}", { count: num(total) }) : t("Select all");
    allBtn.title = wide ? t("Tick every file the search finds ({matches})", { matches }) : "";
    noneBtn.title = wide ? t("Untick every file the search finds") : "";
  }

  function showNotice(text) {
    notice.textContent = text;
    notice.hidden = false;
    announce(text);
  }

  // ---- search -------------------------------------------------------------------------------

  /** The search as the engine takes it: the type filter first (`ext:jpg,png`), then the words. */
  function query() {
    const words = search ? search.value.trim() : "";
    const kind = kinds.find((k) => k.key === st.kind);
    return kind ? `ext:${kind.exts.join(",")} ${words}`.trim() : words;
  }

  let searchTimer = null;
  async function runSearch() {
    notice.hidden = true;
    const q = query();
    draft.query = search ? search.value.trim() : "";
    draft.kind = st.kind;
    save();
    if (!q) return showTree();
    const r = await api.search(q);
    if (query() !== q) return; // a newer search is on its way
    if (!r?.ok) return failed(r);
    st.results = { query: q, total: r.results.total, items: r.results.items.map(norm) };
    showResults();
  }

  function chooseKind(btn, move = false) {
    st.kind = btn.dataset.kind;
    for (const b of kindBtns) {
      const on = b === btn;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (move) btn.focus();
    clearTimeout(searchTimer);
    runSearch();
  }

  // ---- ticking ------------------------------------------------------------------------------

  function tick(paths, ticked) {
    for (const p of paths) setTicked(marks, p, ticked);
    // A folder whose entries are now all ticked the same way says it with the folder itself.
    if (!st.results) for (const p of paths) settle(parentOf(p));
    refreshTicks();
    changed();
  }

  function settle(dir) {
    const keys = Object.keys(marks);
    for (; dir !== null; dir = parentOf(dir)) {
      const page = loaded.get(dir);
      if (!page || !page.items.length || page.items.length < page.total) return;
      const states = new Set(page.items.map((it) => tickState(marks, keys, it.path)));
      if (states.size !== 1 || states.has("mixed")) return;
      setTicked(marks, dir, states.has("on"));
    }
  }

  function toggle(li) {
    tick([itemOf.get(li).path], li.getAttribute("aria-checked") !== "true");
  }

  /** Select all / none in search results: every match, worked out by the engine. */
  async function tickAllMatches(ticked) {
    const q = st.results.query;
    const r = await api.tickMatches({ ...marks }, q, ticked);
    if (st.results?.query !== q) return;
    if (!r?.ok) return failed(r);
    for (const k of Object.keys(marks)) delete marks[k];
    Object.assign(marks, r.marks);
    refreshTicks();
    changed();
  }

  /** Every file of the zip, or every match while searching. */
  function selectAll(ticked) {
    if (st.results && features.tickMatches) return tickAllMatches(ticked);
    tick(st.results ? st.results.items.map((it) => it.path) : [""], ticked);
  }

  // ---- events -------------------------------------------------------------------------------

  tree.addEventListener("click", (e) => {
    const li = e.target.closest("[role=treeitem]");
    if (!li || e.target.closest("button")) return;
    setFocus(li, false);
    li.focus({ preventScroll: true });
    // A folder's row opens it; its tick box, and anywhere on a file's row, ticks.
    if (li.hasAttribute("aria-expanded") && !e.target.closest(".fl-tick")) setOpen(li, li.getAttribute("aria-expanded") !== "true");
    else toggle(li);
  });

  tree.addEventListener("keydown", (e) => {
    const li = e.target;
    if (li.getAttribute?.("role") !== "treeitem") return;
    const item = itemOf.get(li);
    const rows = visibleRows();
    const i = rows.indexOf(li);
    const expanded = li.getAttribute("aria-expanded") === "true";
    switch (e.key) {
      case "ArrowDown":
        setFocus(rows[i + 1] || li);
        break;
      case "ArrowUp":
        setFocus(rows[i - 1] || li);
        break;
      case "PageDown":
        setFocus(rows[Math.min(rows.length - 1, i + 10)]);
        break;
      case "PageUp":
        setFocus(rows[Math.max(0, i - 10)]);
        break;
      case "Home":
        setFocus(rows[0]);
        break;
      case "End":
        setFocus(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (!li.hasAttribute("aria-expanded")) return;
        if (!expanded) setOpen(li, true);
        else setFocus(li.querySelector(":scope > .fl-kids > [role=treeitem]"));
        break;
      case "ArrowLeft":
      case "Backspace":
        if (expanded && e.key === "ArrowLeft") setOpen(li, false);
        else {
          const up = li.parentElement.closest("[role=treeitem]");
          if (!up) return;
          setFocus(up);
        }
        break;
      case " ":
        toggle(li);
        break;
      case "Enter":
        if (e.isComposing) return;
        if (li.hasAttribute("aria-expanded")) setOpen(li, !expanded);
        else if (actionOf(item) === "open") api.open(item.path);
        else if (actionOf(item) === "preview") api.preview(item.path);
        else return;
        break;
      case "p":
      case "P":
        if (e.ctrlKey || e.metaKey || e.altKey || actionOf(item) !== "preview") return;
        api.preview(item.path);
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // The folder whose rows the pointer or focus is in: its line darkens, so you see where it ends.
  let hot = null;
  const heat = (target) => {
    const li = target?.closest?.("[role=treeitem]");
    const folder = !li ? null : li.hasAttribute("aria-expanded") ? li : li.parentElement.closest("[role=treeitem]");
    if (folder === hot) return;
    hot?.classList.remove("hot");
    hot = folder;
    hot?.classList.add("hot");
  };
  tree.addEventListener("mouseover", (e) => heat(e.target));
  tree.addEventListener("mouseleave", () => heat(st.focus && tree.contains(document.activeElement) ? document.activeElement : null));
  tree.addEventListener("focusin", (e) => {
    if (e.target.getAttribute?.("role") === "treeitem") setFocus(e.target, false);
    heat(e.target);
  });
  tree.addEventListener("focusout", (e) => !tree.contains(e.relatedTarget) && heat(null));

  allBtn.addEventListener("click", () => selectAll(true));
  noneBtn.addEventListener("click", () => selectAll(false));
  kindGroup?.addEventListener("click", (e) => {
    const btn = e.target.closest("[role=radio]");
    if (btn) chooseKind(btn);
  });
  kindGroup?.addEventListener("keydown", (e) => {
    const i = kindBtns.indexOf(e.target);
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (i < 0 || !step) return;
    e.preventDefault();
    chooseKind(kindBtns[(i + step + kindBtns.length) % kindBtns.length], true);
  });
  search?.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300);
  });
  search?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus(st.focus || visibleRows()[0]);
    }
  });

  // ---- totals -------------------------------------------------------------------------------

  let measureTimer = null;
  let measuring = false;
  let measureAgain = false;

  function changed() {
    const sel = toSelect(marks);
    summary.textContent = sel.all ? t("All files") : sel.none ? t("No files") : t("Some files");
    onChange(sel);
    clearTimeout(measureTimer);
    measureTimer = setTimeout(measure, 250);
  }

  function showTotals(m) {
    totals.textContent = t("{files}, {write} to write, about {download} to download", { files: fileCount(m.files), write: humanBytes(m.extracted), download: humanBytes(m.compressed) });
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
      totals.textContent = t("No files ticked.");
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
    // Nothing left under the ticks (every file of the zip's only folder unticked): say it with the
    // zip itself, so the totals read "No files" and a file ticked next is sayable as `select`.
    if (r.measured.files === 0) {
      for (const k of Object.keys(marks)) delete marks[k];
      marks[""] = false;
      refreshTicks();
      summary.textContent = t("No files");
      totals.textContent = t("No files ticked.");
      return onChange(toSelect(marks));
    }
    showTotals(r.measured);
    onChange({ ...sel, measured: r.measured });
  }

  // The list is always shown: open where the user left it (open folders, or the search).
  if (query()) runSearch();
  else showTree();
  changed();

  return {
    el: box,
    selection: () => toSelect(marks),
    /** Every file of the zip ticked or unticked (every match while searching). */
    selectAll,
    /** Where the list is: the folder of the focused row, and the search (for Sample and the image grid). */
    where: () => {
      const item = !st.results && st.focus ? itemOf.get(st.focus) : null;
      return { dir: !item ? "" : item.dir ? item.path : parentOf(item.path), query: st.results?.query || "" };
    },
    /** Ticks set from elsewhere (a random sample, a shared link): replace them all. */
    setMarks(next) {
      for (const k of Object.keys(marks)) delete marks[k];
      Object.assign(marks, next);
      refreshTicks();
      changed();
    },
  };
}
