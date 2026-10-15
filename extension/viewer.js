// LinkUnzip preview: shows one file from inside a zip without downloading the zip. The page asks
// the background where the file sits, fetches just that file's bytes and inflates them here.
// Nothing is written to disk; the bytes are let go when you move on or close the tab.
//
// Everything in the file is untrusted. Text goes in as text, images through <img> (an SVG there
// can't run scripts), PDFs through Chrome's own viewer, and HTML is shown as source, never run.

import { h } from "./dom.js";
import { crc32 } from "./engine/crc32.js";
import { entryChunks, seekToData } from "./engine/entry.js";
import { ByteReader, Source } from "./engine/source.js";
import { humanBytes } from "./fmt.js";

const TEXT_FIRST = 256 * 1024; // shown at first; Load more adds TEXT_MORE
const TEXT_MORE = 1024 * 1024;
const CSV_ROWS = 1000;
const LIMITS = { image: 50 << 20, pdf: 200 << 20, audio: 200 << 20, video: 200 << 20 };

const KINDS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"],
  pdf: ["pdf"],
  audio: ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"],
  video: ["mp4", "m4v", "webm", "ogv", "mov"],
  csv: ["csv", "tsv"],
  text: [
    "txt", "md", "markdown", "log", "json", "jsonl", "ndjson", "xml", "yaml", "yml", "ini", "cfg", "conf", "toml", "env",
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "java", "kt", "go", "rb", "php",
    "swift", "lua", "pl", "r", "sql", "sh", "bash", "zsh", "bat", "cmd", "ps1", "css", "scss", "less", "html", "htm", "svelte",
    "vue", "gradle", "properties", "gitignore", "gitattributes", "dockerfile", "makefile", "cmake", "tex", "srt", "vtt", "rst",
    "license", "readme", "nfo", "diff", "patch", "glsl", "hlsl", "obj", "mtl", "ply", "pts", "lst",
  ],
};
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  bmp: "image/bmp", ico: "image/x-icon", svg: "image/svg+xml", pdf: "application/pdf", mp3: "audio/mpeg",
  m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav",
  flac: "audio/flac", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/mp4",
};

const params = new URLSearchParams(location.search);
const jobId = params.get("job");
let path = params.get("path");

const $ = (id) => document.getElementById(id);
const view = $("view");
const send = (cmd, data = {}) => chrome.runtime.sendMessage({ cmd, ...data });

let current = null; // { ctl, url } of what is on screen, to let go of it
let siblings = null; // files in the same folder, for Previous / Next

const extOf = (p) => {
  const name = p.slice(p.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : name;
};
const kindOf = (p) => Object.keys(KINDS).find((k) => KINDS[k].includes(extOf(p))) || "unknown";
const parentOf = (p) => p.slice(0, p.lastIndexOf("/") + 1);

function release() {
  if (!current) return;
  current.ctl.abort();
  if (current.url) URL.revokeObjectURL(current.url);
  current = null;
}
addEventListener("pagehide", release);

function card(title, ...body) {
  view.className = "center";
  view.replaceChildren(h("div", { class: "card" }, h("h2", {}, title), ...body));
}

function setStats(text) {
  $("stats").textContent = text;
}

/** One file's bytes, from its local header on, as uncompressed chunks; `stats.downloaded` counts. */
async function open(info, ctl, stats) {
  const src = Source.from(info.source, ctl.signal);
  const e = info.entry;
  const resp = await src.openRange(e.offset, e.regionEnd - 1, ctl.signal);
  const reader = new ByteReader(resp.body, e.offset, (n) => (stats.downloaded += n));
  await seekToData(reader, e);
  return { gen: entryChunks(reader, e), reader };
}

function downloadedLine(stats, info, extra = "") {
  return `${humanBytes(stats.downloaded)} downloaded of a ${humanBytes(info.source.size)} zip${extra}`;
}

async function readAll(info, ctl, stats) {
  const { gen } = await open(info, ctl, stats);
  const parts = [];
  let crc = 0;
  let n = 0;
  for await (const chunk of gen) {
    const copy = chunk.slice();
    parts.push(copy);
    crc = crc32(crc, copy);
    n += copy.length;
    if (n > info.entry.usize) throw new Error("the data expands beyond its declared size");
  }
  if (n !== info.entry.usize || crc !== info.entry.crc) throw new Error("the file's CRC-32 check failed: the data is corrupt");
  return parts;
}

// ---------------------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------------------

async function showText(info, ctl, stats, { csv = false, sniffOnly = false } = {}) {
  const { gen, reader } = await open(info, ctl, stats);
  const decoder = new TextDecoder("utf-8");
  let shown = 0;
  let done = false;
  const pre = h("pre", { class: `text${$("wrap").checked ? " wrap" : ""}` });
  let pending = ""; // the start of a line that hasn't ended yet
  const appendLines = (s, last) => {
    const lines = (pending + s).split("\n");
    pending = last ? "" : lines.pop();
    const frag = document.createDocumentFragment();
    for (const line of lines) frag.append(h("span", { class: "ln" }, `${line.replace(/\r$/, "")}\n`));
    pre.append(frag);
  };

  // The first bytes decide whether this is text at all.
  let firstBytes = 0;
  const head = [];
  while (firstBytes < Math.min(8192, info.entry.usize) && !done) {
    const r = await gen.next();
    if (r.done) {
      done = true;
      break;
    }
    head.push(r.value.slice());
    firstBytes += r.value.length;
  }
  const headBytes = new Uint8Array(firstBytes);
  let at = 0;
  for (const p of head) {
    headBytes.set(p, at);
    at += p.length;
  }
  if (headBytes.subarray(0, 8192).includes(0)) {
    reader.cancel();
    return false; // binary
  }
  if (sniffOnly && !headBytes.length) return false;
  shown = firstBytes;
  const first = decoder.decode(headBytes, { stream: !done });

  if (csv) return showCsv(info, ctl, stats, first, gen, done, decoder);

  view.className = "";
  view.replaceChildren(pre);
  $("wrap-box").hidden = false;
  appendLines(first, done);
  const more = $("more");
  const update = () => {
    const all = shown >= info.entry.usize || done;
    setStats(`${all ? "Whole file" : `First ${humanBytes(shown)} of ${humanBytes(info.entry.usize)}`} · ${downloadedLine(stats, info)}`);
    more.hidden = all;
  };
  const load = async (budget) => {
    let got = 0;
    while (got < budget && !done) {
      const r = await gen.next();
      if (r.done) {
        done = true;
        break;
      }
      got += r.value.length;
      shown += r.value.length;
      appendLines(decoder.decode(r.value, { stream: true }), false);
    }
    if (done) appendLines(decoder.decode(), true);
    update();
  };
  await load(TEXT_FIRST - shown);
  more.onclick = async () => {
    more.disabled = true;
    await load(TEXT_MORE);
    more.disabled = false;
  };
  return true;
}

function parseCsvRows(text, sep, max) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  return rows;
}

async function showCsv(info, ctl, stats, first, gen, done, decoder) {
  let text = first;
  // Enough text for the rows shown (or the whole file, if it is smaller).
  while (!done && text.split("\n").length <= CSV_ROWS + 1 && text.length < 8 << 20) {
    const r = await gen.next();
    if (r.done) {
      done = true;
      break;
    }
    text += decoder.decode(r.value, { stream: true });
  }
  if (done) text += decoder.decode();
  if (!text.endsWith("\n")) text += "\n";
  const sep = extOf(path) === "tsv" ? "\t" : text.split("\n")[0].split(";").length > text.split("\n")[0].split(",").length ? ";" : ",";
  const rows = parseCsvRows(text, sep, CSV_ROWS + 1);
  const [header = [], ...body] = rows;
  const table = h(
    "table",
    { class: "csv" },
    h("thead", {}, h("tr", {}, ...header.map((c) => h("th", { title: c }, c)))),
    h("tbody", {}, ...body.map((r) => h("tr", {}, ...r.map((c) => h("td", { title: c }, c))))),
  );
  view.className = "";
  view.replaceChildren(table);
  const all = done && body.length < CSV_ROWS;
  setStats(`${all ? `All ${body.length.toLocaleString()} rows` : `First ${body.length.toLocaleString()} rows`} · ${downloadedLine(stats, info)}`);
  return true;
}

async function showBlob(info, ctl, stats, kind) {
  const limit = LIMITS[kind];
  if (info.entry.usize > limit && !current?.force) {
    card(
      `This file is ${humanBytes(info.entry.usize)}`,
      h("p", { class: "muted" }, "A preview holds the whole file in memory. For a file this big, extracting it is usually better."),
      h("p", {}, h("button", { class: "btn", type: "button", onclick: () => show(true) }, "Preview anyway")),
    );
    setStats("");
    return true;
  }
  view.className = "center";
  view.replaceChildren(h("div", { class: "spinner", role: "img", "aria-label": "Loading" }));
  setStats(`Loading ${humanBytes(info.entry.usize)}...`);
  const timer = setInterval(() => setStats(`Loading: ${humanBytes(stats.downloaded)} of ~${humanBytes(info.entry.csize)}`), 300);
  let parts;
  try {
    parts = await readAll(info, ctl, stats);
  } finally {
    clearInterval(timer);
  }
  const blob = new Blob(parts, { type: MIME[extOf(path)] || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  current.url = url;
  const name = path.slice(path.lastIndexOf("/") + 1);
  let el;
  if (kind === "image") el = h("img", { class: "image", src: url, alt: name });
  else if (kind === "pdf") {
    view.className = "";
    el = h("iframe", { class: "pdf", src: url, title: name });
  } else if (kind === "audio") el = h("audio", { src: url, controls: true });
  else el = h("video", { src: url, controls: true });
  view.replaceChildren(el);
  setStats(`Whole file, CRC-32 checked · ${downloadedLine(stats, info)}`);
  return true;
}

function showDetails(info, why) {
  const e = info.entry;
  card(
    why,
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "Size"),
      h("dd", {}, humanBytes(e.usize)),
      h("dt", {}, "In the zip"),
      h("dd", {}, `${humanBytes(e.csize)} (${e.method === 0 ? "stored" : e.method === 8 ? "deflate" : `method ${e.method}`})`),
      h("dt", {}, "CRC-32"),
      h("dd", {}, e.crc.toString(16).padStart(8, "0")),
      h("dt", {}, "Path"),
      h("dd", {}, path),
    ),
    h("p", { class: "muted" }, "Tick it in LinkUnzip's file list to extract it."),
  );
  setStats("");
}

// ---------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------

async function show(force = false) {
  release();
  const ctl = new AbortController();
  current = { ctl, url: null, force };
  $("more").hidden = true;
  $("wrap-box").hidden = true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  document.title = `${name} - LinkUnzip preview`;
  $("name").textContent = name;
  view.className = "center";
  view.replaceChildren(h("div", { class: "spinner", role: "img", "aria-label": "Loading" }));
  setStats("");

  const r = await send("entry", { id: jobId, path });
  if (!r?.ok) {
    card("Can't show this file", h("p", { class: "muted" }, r?.error?.message || "That zip is no longer open in LinkUnzip. Open it again from the popup."));
    return;
  }
  $("where").textContent = `${r.name} · ${parentOf(path) || "top folder"}`;
  updateNav();
  if (r.unsupported) return showDetails(r, `LinkUnzip can't read this file (${r.unsupported})`);
  const stats = { downloaded: 0 };
  const kind = kindOf(path);
  try {
    if (kind === "image" || kind === "pdf" || kind === "audio" || kind === "video") return await showBlob(r, ctl, stats, kind);
    if (kind === "csv") return await showText(r, ctl, stats, { csv: true });
    if (kind === "text") {
      if (!(await showText(r, ctl, stats))) showDetails(r, "This file isn't text");
      return;
    }
    // Unknown type: show it if it turns out to be text.
    if (r.entry.usize === 0) return showDetails(r, "This file is empty");
    if (!(await showText(r, ctl, stats, { sniffOnly: true }))) showDetails(r, `No preview for .${extOf(path)} files`);
  } catch (e) {
    if (ctl.signal.aborted) return;
    card("Couldn't load this file", h("p", { class: "bad" }, e?.message || String(e)));
  }
}

async function loadSiblings() {
  const dir = parentOf(path);
  const files = [];
  for (let offset = 0; ; ) {
    const r = await send("list", { id: jobId, dir, offset, limit: 2000 });
    if (!r?.ok) break;
    files.push(...r.listing.items.filter((i) => !i.dir && !i.unsupported).map((i) => i.path));
    offset += r.listing.items.length;
    if (offset >= r.listing.total || !r.listing.items.length || files.length > 20000) break;
  }
  return { dir, files };
}

async function updateNav() {
  if (!siblings || siblings.dir !== parentOf(path)) siblings = await loadSiblings();
  const i = siblings.files.indexOf(path);
  $("prev").disabled = i <= 0;
  $("next").disabled = i < 0 || i >= siblings.files.length - 1;
}

function go(step) {
  if (!siblings) return;
  const i = siblings.files.indexOf(path);
  const next = siblings.files[i + step];
  if (i < 0 || !next) return;
  path = next;
  history.replaceState(null, "", `viewer.html?job=${encodeURIComponent(jobId)}&path=${encodeURIComponent(path)}`);
  show();
}

$("prev").addEventListener("click", () => go(-1));
$("next").addEventListener("click", () => go(1));
addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea") || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowLeft") go(-1);
  if (e.key === "ArrowRight") go(1);
});
$("wrap").addEventListener("change", () => view.querySelector("pre.text")?.classList.toggle("wrap", $("wrap").checked));
// The viewer is reused for the next preview: the background loads a new address into this tab.
show();
