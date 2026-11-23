// The popup's smaller tools, kept out of popup.js: the Recent list on the start screen, and the
// file list's Sample and Share rows. Each takes what it needs and returns DOM; popup.js
// places it.

import { h } from "./dom.js";
import { fileNameFromUrl, files, hostOf, humanBytes, safeName } from "./fmt.js";
import { num, t } from "./i18n.js";
import { forgetRecentZips, recentZips } from "./recent.js";
import { helperCommand, pythonCommand, remotezipCommand } from "./command.js";
import { encodeSelection, looksTemporary, shareLink } from "./selection.js";

const send = (cmd, data = {}) => chrome.runtime.sendMessage({ cmd, ...data });

/** Shown on the start screen: at most this many. */
const RECENT_SHOWN = 8;

/** The zips opened lately (recent.js), each one click from opening again. null when there are none. */
export async function recentList(open) {
  const list = (await recentZips()).slice(0, RECENT_SHOWN);
  if (!list.length) return null;
  const box = h("div", { class: "card panel links recent" });
  const clear = h(
    "button",
    {
      type: "button",
      class: "link small",
      onclick: async () => {
        await forgetRecentZips();
        box.remove();
      },
    },
    t("Clear"),
  );
  box.append(
    h("div", { class: "row", style: "justify-content:space-between" }, h("h2", {}, t("Recent")), clear),
    ...list.map((z) => {
      const facts = [hostOf(z.url)];
      if (z.size != null) facts.push(humanBytes(z.size));
      if (z.files != null) facts.push(files(z.files));
      if (z.folder) facts.push(z.folder);
      if (looksTemporary(z.url)) facts.push(t("the link may have expired"));
      return h(
        "button",
        { class: "link-item", type: "button", onclick: () => open(z.url) },
        h("span", { class: "l1" }, safeName(z.name || fileNameFromUrl(z.url))),
        h("span", { class: "l2" }, facts.join(" · ")),
      );
    }),
  );
  return box;
}

/** A short fingerprint of a set of ticks: whether the ticks are still the ones a sample set. */
export function marksSignature(marks) {
  const text = JSON.stringify(marks);
  let x = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) x = Math.imul(x ^ text.charCodeAt(i), 0x01000193);
  return `${text.length}:${(x >>> 0).toString(36)}`;
}

/**
 * "Sample...": tick N random files of the folder shown, the search results or the whole zip.
 * The engine draws them from the index (nothing is downloaded); the draw is kept in the draft
 * (`d.sample`) so a share link can carry "100 random files, seed X" instead of 100 names.
 */
export function sampleTool({ job, draft, getList }) {
  const row = h("div", { class: "pattern-row sample-row", hidden: true });
  const count = h("input", { type: "number", min: "1", max: "10000", value: String(draft.sample?.spec.n || 100), class: "sample-n" });
  count.id = `sample-n-${job.id}`;
  const scope = h("select", { "aria-label": t("Pick from") });
  const ext = h("input", { type: "text", placeholder: "jpg", spellcheck: "false", class: "sample-ext", "aria-label": t("Only this file type (optional)") });
  const status = h("span", { class: "muted small", role: "status" });
  const fillScope = () => {
    const where = getList().where();
    const options = [];
    if (where.query) options.push(["query", t("the search results")]);
    if (where.dir) options.push(["dir", t("this folder")]);
    options.push(["all", t("the whole zip")]);
    scope.replaceChildren(...options.map(([value, label]) => h("option", { value }, label)));
  };
  const draw = async (seed) => {
    const where = getList().where();
    const n = Math.max(1, Math.min(10000, Math.round(Number(count.value) || 0)));
    count.value = String(n);
    const spec = {
      n,
      seed,
      scope: scope.value === "dir" ? where.dir : "",
      query: scope.value === "query" ? where.query : "",
      ext: ext.value.trim().replace(/^\*?\./, "").toLowerCase(),
    };
    status.textContent = t("Picking...");
    const r = await send("sample", { id: job.id, ...spec });
    if (!r?.ok) {
      status.textContent = r?.error?.message || t("LinkUnzip couldn't pick files.");
      return;
    }
    if (!r.picked) {
      status.textContent = t("No files match.");
      return;
    }
    getList().setMarks(r.marks);
    draft.sample = { spec: { ...spec, seed: r.seed }, sig: marksSignature(r.marks) };
    status.textContent = t("{picked} of {matched} files ticked.", { picked: num(r.picked), matched: num(r.matched) });
  };
  row.append(
    h("label", { for: count.id }, t("Pick")),
    count,
    h("span", {}, t("random files from")),
    scope,
    ext,
    h("button", { type: "button", class: "btn", onclick: () => draw(undefined) }, t("Pick")),
    status,
  );
  const btn = h(
    "button",
    {
      type: "button",
      class: "link small",
      "aria-expanded": "false",
      onclick: () => {
        const open = row.hidden;
        if (open) fillScope();
        row.hidden = !open;
        btn.setAttribute("aria-expanded", String(open));
        if (open) count.focus();
      },
    },
    t("Sample..."),
  );
  return { btn, row };
}

/**
 * "Share...": a link that opens LinkUnzip with this zip and these ticks (linkunzip.app/open), or
 * a command that fetches the same files on another machine (command.js). `totals()` gives the
 * ticked files and bytes as the popup knows them, shown on the page the link opens.
 */
export function shareTool({ job, draft, getList, totals }) {
  const row = h("div", { class: "pattern-row share-row", hidden: true });
  const status = h("p", { class: "muted small", role: "status" });
  const kind = h(
    "select",
    { "aria-label": t("Command for") },
    h("option", { value: "bash" }, t("Python (Linux, Mac)")),
    h("option", { value: "powershell" }, t("Python (Windows PowerShell)")),
    h("option", { value: "remotezip" }, "remotezip"),
    h("option", { value: "helper" }, t("LinkUnzip helper (Windows)")),
  );
  /** The ticks as marks, or null for everything. */
  const marks = () => {
    const sel = getList().selection();
    return sel.select?.marks || (sel.none ? { "": false } : null);
  };
  const copy = async (text, done) => {
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = done;
    } catch {
      status.textContent = t("Copying didn't work. Try again.");
    }
  };
  // Said before copying, so the person knows what the receiver gets.
  const caveats = () => {
    const out = [];
    if (looksTemporary(job.url)) out.push(t("This link looks temporary: others may not be able to use it."));
    if (job.loginSent) out.push(t("This zip needed your login: others will need their own."));
    return out.join(" ");
  };
  const copyLink = async () => {
    const m = marks();
    // A sample the ticks still match travels as "n files, seed X" instead of every name.
    const sample = m && draft.sample?.sig === marksSignature(m) ? { sample: draft.sample.spec } : null;
    let encoded;
    try {
      encoded = await encodeSelection(sample || (m ? { marks: m } : null));
    } catch {
      status.textContent = t("Too many single ticks for a link. Tick whole folders, or use Sample, and try again.");
      return;
    }
    const { files: n, bytes } = totals();
    await copy(shareLink({ url: job.url, selection: encoded, files: n, bytes }), `${t("Share link copied.")} ${caveats()}`.trim());
  };
  const copyCommand = async () => {
    const m = marks();
    const folder = job.output?.split(" > ").pop() || undefined;
    let text = null;
    if (kind.value === "bash" || kind.value === "powershell") text = pythonCommand({ url: job.url, marks: m, folder })[kind.value];
    else if (kind.value === "remotezip") text = remotezipCommand({ url: job.url, marks: m });
    else text = helperCommand({ url: job.url, marks: m, folder });
    if (!text) {
      status.textContent = kind.value === "remotezip" ? t("remotezip takes up to 50 single files: pick Python for this selection.") : t("The helper takes whole folders or single files only: pick Python for this selection.");
      return;
    }
    await copy(text, `${t("Command copied.")} ${caveats()}`.trim());
  };
  // The link on its own line; the command's format next to the button that copies it.
  row.append(
    h("button", { type: "button", class: "btn share-link", onclick: copyLink }, t("Copy share link")),
    kind,
    h("button", { type: "button", class: "btn", onclick: copyCommand }, t("Copy as command")),
    status,
  );
  const btn = h(
    "button",
    {
      type: "button",
      class: "link small",
      "aria-expanded": "false",
      onclick: () => {
        row.hidden = !row.hidden;
        btn.setAttribute("aria-expanded", String(!row.hidden));
        status.textContent = "";
        if (!row.hidden) row.querySelector("button")?.focus();
      },
    },
    t("Share..."),
  );
  return { btn, row };
}
