// LinkUnzip preview: shows one file from inside a zip without downloading the zip. The page asks
// the background where the file sits, fetches just that file's bytes and inflates them here.
// Nothing is written to disk; the bytes are let go when you move on or close the tab.
//
// Video, audio and PDFs are streamed instead: the background worker serves them at an address of
// its own, straight from the zip (preview.js), so they have no size limit and a stored video can
// be seeked without downloading what comes before.
//
// Everything in the file is untrusted. Text goes in as text, images through <img> (an SVG there
// can't run scripts), PDFs through Chrome's own viewer, and HTML is shown as source, never run.
//
// viewer.html?job=<id>&grid=<folder>/ shows a folder's images as a grid of small thumbnails
// instead. Each one downloads only its own file, is shrunk to a small WebP and the full picture
// is let go, so a folder of thousands of photos fits in memory. Its tick boxes are the popup's
// ticks for that zip (chrome.storage.session `drafts`), both ways.

import { h } from "./dom.js";
import { checkPassword, decryptorFor, entryBody, entryChunks, seekToData } from "./engine/entry.js";
import { ByteReader, Source } from "./engine/source.js";
import { extensionOf, fileName, humanBytes, parentOf, safeName } from "./fmt.js";
import { loadLanguage, t, tn, translatePage } from "./i18n.js";
import { loadSettings } from "./settings.js";

const TEXT_FIRST = 256 * 1024; // shown at first; Load more adds TEXT_MORE
const TEXT_MORE = 1024 * 1024;
const CSV_ROWS = 1000;
const LIMITS = { image: 50 << 20 };
const STREAMED = new Set(["pdf", "audio", "video"]);
const JSON_COLUMNS = 50; // JSON Lines: columns from the keys of the first JSON_KEY_ROWS rows
const JSON_KEY_ROWS = 100;
const CELL_CHARS = 500; // longer values are cut in a table cell
const NPY_HEAD = 64 * 1024; // .npy: the header and the first values are in here
const NPY_VALUES = 100;
// The image grid
const THUMB = 160; // CSS pixels
const THUMB_MAX = 5 << 20; // bigger images wait for a click on Load
const THUMB_LOADS = 4; // at a time
const LIST_PAGE = 500;
const GRID_BATCH = 200; // cells added to the page at a time, as you scroll

const KINDS = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"],
  pdf: ["pdf"],
  audio: ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "flac"],
  video: ["mp4", "m4v", "webm", "ogv", "mov"],
  csv: ["csv", "tsv"],
  json: ["json"],
  jsonl: ["jsonl", "ndjson"],
  npy: ["npy"],
  text: [
    "txt", "md", "markdown", "log", "xml", "yaml", "yml", "ini", "cfg", "conf", "toml", "env",
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
let around = null; // { path, prev, next }: the files before and after this one in its folder
let asText = false; // JSON and JSON Lines as plain text instead (the toggle in the bar)
let mode = "preview"; // or "grid"

/** The extension, or the whole name for files without one (`Makefile`, `LICENSE`). */
const extOf = (p) => extensionOf(p) || fileName(p).toLowerCase();
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([kind, exts]) => exts.map((ext) => [ext, kind])));
const kindOf = (p) => KIND_OF.get(extOf(p)) || "unknown";

function release() {
  if (!current) return;
  current.ctl.abort();
  if (current.url) URL.revokeObjectURL(current.url);
  clearInterval(current.timer);
  if (current.token) send("previewDone", { token: current.token });
  current = null;
}
addEventListener("pagehide", release);

function card(title, ...body) {
  view.className = "center";
  view.replaceChildren(h("div", { class: "card" }, h("h2", {}, title), ...body));
  announce(title);
}

/** The line under the header. It changes while a file loads, so it is not read out; announce() is. */
function setStats(text) {
  $("stats").textContent = text;
}

// Screen readers hear only when a file starts and finishes loading, and errors: one polite
// status, written a moment later so the same words twice are read again, and only the latest.
let announceTimer = 0;
function announce(text) {
  clearTimeout(announceTimer);
  $("announce").textContent = "";
  if (text) announceTimer = setTimeout(() => ($("announce").textContent = text), 150);
}

/** The file on screen is ready: its name and the line under the header (cards announce themselves). */
function announceDone(name) {
  const stats = $("stats").textContent;
  if (stats) announce(`${name}. ${stats}`);
}

/**
 * A raster copy of an SVG, `widthFor(w, h)` pixels wide for its natural size w x h, so the SVG
 * itself never gets an address that "Open image in new tab" could show as a page of its own.
 * Drawn through <img>, where its scripts don't run.
 */
async function rasterSvg(blob, widthFor, type, quality) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 300;
    const ht = img.naturalHeight || 150;
    const width = Math.max(1, Math.round(widthFor(w, ht)));
    const canvas = new OffscreenCanvas(width, Math.max(1, Math.round((width * ht) / w)));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return { blob: await canvas.convertToBlob({ type, quality }), w, h: ht };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One file's bytes, from its local header on, as uncompressed chunks; `stats.downloaded` counts. */
async function open(info, ctl, stats) {
  const src = Source.from(info.source, ctl.signal);
  const e = info.entry;
  const resp = await src.openRange(e.offset, e.regionEnd - 1, ctl.signal);
  const reader = new ByteReader(resp.body, e.offset, (n) => (stats.downloaded += n));
  await seekToData(reader, e);
  return { gen: entryChunks(reader, e, () => {}, 0, await decryptorFor(reader, e, info.password)), reader };
}

function downloadedLine(stats, info, extra = "") {
  return `${t("{done} downloaded of a {size} zip", { done: humanBytes(stats.downloaded), size: humanBytes(info.source.size) })}${extra}`;
}

/** The whole file as a Blob of `type`, its size and CRC-32 checked on the way (entryBody). */
async function readAll(info, ctl, stats, type) {
  const src = Source.from(info.source, ctl.signal);
  const onData = (n) => (stats.downloaded += n);
  const body = entryBody(src, info.entry, info.entry.regionEnd, info.password, { signal: ctl.signal, onData });
  const blob = await new Response(body).blob();
  return blob.slice(0, blob.size, type);
}

/** The first `limit` bytes of the file, or all of it (then size and CRC-32 checked) when smaller. */
async function readHead(info, ctl, stats, limit) {
  const src = Source.from(info.source, ctl.signal);
  const onData = (n) => (stats.downloaded += n);
  const body = entryBody(src, info.entry, info.entry.regionEnd, info.password, { limit, signal: ctl.signal, onData });
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** The JSON/text toggle in the bar, labelled with what it switches to. */
function offerToggle(label) {
  $("raw").textContent = label;
  $("raw").hidden = false;
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
    setStats(`${all ? t("Whole file") : t("First {shown} of {size}", { shown: humanBytes(shown), size: humanBytes(info.entry.usize) })} · ${downloadedLine(stats, info)}`);
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
    announce($("stats").textContent);
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
  showTable(header, body);
  const all = done && body.length < CSV_ROWS;
  setStats(`${rowsLine(all, body.length)} · ${downloadedLine(stats, info)}`);
  return true;
}

function showTable(header, body) {
  const table = h(
    "table",
    { class: "csv" },
    h("thead", {}, h("tr", {}, ...header.map((c) => h("th", { title: c }, c)))),
    h("tbody", {}, ...body.map((r) => h("tr", {}, ...r.map((c) => h("td", { title: c }, c))))),
  );
  view.className = "";
  view.replaceChildren(table);
}

const rowsLine = (all, n) => (all ? tn("All {count} row", "All {count} rows", n) : tn("First {count} row", "First {count} rows", n));

/** Text shown as numbered lines, like showText does. */
function showLines(text) {
  const pre = h("pre", { class: `text${$("wrap").checked ? " wrap" : ""}` });
  const frag = document.createDocumentFragment();
  for (const line of text.split("\n")) frag.append(h("span", { class: "ln" }, `${line}\n`));
  pre.append(frag);
  view.className = "";
  view.replaceChildren(pre);
  $("wrap-box").hidden = false;
}

// Numbers keep the digits they were written with (JSON.parse would round 12345678901234567890).
const keepNumbers = typeof JSON.rawJSON === "function" ? (key, value, ctx) => (typeof value === "number" && ctx?.source ? JSON.rawJSON(ctx.source) : value) : undefined;
const parseJson = (text) => JSON.parse(text, keepNumbers);

/** .json: pretty-printed when it is small enough to show whole; false to show it as text. */
async function showJson(info, ctl, stats) {
  if (info.entry.usize > TEXT_FIRST) return false;
  const text = await (await readAll(info, ctl, stats, "application/json")).text();
  let pretty;
  try {
    pretty = JSON.stringify(parseJson(text), null, 2); // Blob.text() drops a byte order mark
  } catch {
    return false;
  }
  showLines(pretty);
  setStats(`${t("Whole file, CRC-32 checked")} · ${downloadedLine(stats, info)}`);
  offerToggle(t("Show as text"));
  return true;
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !JSON.isRawJSON?.(v);

/** A JSON value as a table cell: strings as they are, the rest as compact JSON. */
function cellText(v) {
  if (v === undefined) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS)}...` : s;
}

/**
 * .jsonl / .ndjson: the first rows (from the first TEXT_FIRST bytes) as a table, columns from
 * the keys of the first rows. False when nothing in it is JSON, to show it as text.
 */
async function showJsonl(info, ctl, stats) {
  const bytes = await readHead(info, ctl, stats, TEXT_FIRST);
  if (bytes.subarray(0, 8192).includes(0)) return false;
  const whole = bytes.length >= info.entry.usize;
  const lines = new TextDecoder("utf-8").decode(bytes, { stream: !whole }).split("\n");
  if (!whole) lines.pop(); // cut off midway
  const rows = [];
  let bad = 0;
  let more = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (rows.length === CSV_ROWS) {
      more = true;
      break;
    }
    try {
      rows.push(parseJson(line));
    } catch {
      bad += 1;
    }
  }
  if (!rows.length) return false;
  const columns = new Set();
  for (const row of rows.slice(0, JSON_KEY_ROWS)) {
    if (!isRecord(row)) continue;
    for (const k of Object.keys(row)) if (columns.size < JSON_COLUMNS) columns.add(k);
  }
  const keys = [...columns];
  // Rows that aren't objects (numbers, arrays) go in a column of their own.
  const plain = rows.some((r) => !isRecord(r));
  const header = plain ? [...keys, t("Value")] : keys;
  const body = rows.map((r) => {
    const cells = keys.map((k) => (isRecord(r) && Object.hasOwn(r, k) ? cellText(r[k]) : ""));
    if (plain) cells.push(isRecord(r) ? "" : cellText(r));
    return cells;
  });
  showTable(header, body);
  const notJson = bad ? ` · ${tn("{count} line isn't JSON", "{count} lines aren't JSON", bad)}` : "";
  setStats(`${rowsLine(whole && !more, rows.length)}${notJson} · ${downloadedLine(stats, info)}`);
  offerToggle(t("Show as text"));
  return true;
}

// .npy dtypes whose values are shown: the DataView getter and the size of one value.
const NPY_TYPES = {
  f4: ["getFloat32", 4], f8: ["getFloat64", 8],
  i1: ["getInt8", 1], i2: ["getInt16", 2], i4: ["getInt32", 4], i8: ["getBigInt64", 8],
  u1: ["getUint8", 1], u2: ["getUint16", 2], u4: ["getUint32", 4], u8: ["getBigUint64", 8],
  b1: ["getUint8", 1],
};

/** A .npy file's header (format 1.0 to 3.0), or null when the bytes aren't one. */
function parseNpy(bytes) {
  const magic = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]; // \x93NUMPY
  if (bytes.length < 12 || magic.some((b, i) => bytes[i] !== b)) return null;
  const [major, minor] = [bytes[6], bytes[7]];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = major >= 2 ? 12 : 10;
  const len = major >= 2 ? dv.getUint32(8, true) : dv.getUint16(8, true);
  if (start + len > bytes.length) return null;
  const header = new TextDecoder(major >= 3 ? "utf-8" : "latin1").decode(bytes.subarray(start, start + len)).trim();
  if (!header.startsWith("{")) return null;
  const shape = header.match(/'shape'\s*:\s*\(([^)]*)\)/)?.[1];
  return {
    version: `${major}.${minor}`,
    header,
    descr: header.match(/'descr'\s*:\s*'([^']*)'/)?.[1] ?? null,
    fortran: /'fortran_order'\s*:\s*True/.test(header),
    shape: shape == null ? null : shape.split(",").map((s) => s.trim()).filter(Boolean).map(Number),
    dataStart: start + len,
  };
}

/** The shortest digits that read back as the same float32, as NumPy prints them (1.3333334). */
function float32Text(v) {
  if (!Number.isFinite(v)) return String(v);
  for (let p = 1; p < 9; p++) {
    const s = Number(v.toPrecision(p));
    if (Math.fround(s) === v) return String(s);
  }
  return String(Number(v.toPrecision(9)));
}

/** The first `max` values of a plain number or bool array, as text; null for other dtypes. */
function npyValues(bytes, npy, max) {
  const m = /^([<>|=])([fiub])(\d+)$/.exec(npy.descr || "");
  const type = m && NPY_TYPES[m[2] + m[3]];
  if (!type || !npy.shape || npy.shape.some((n) => !Number.isInteger(n))) return null;
  const [getter, size] = type;
  const little = m[1] !== ">";
  const count = npy.shape.reduce((a, b) => a * b, 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset + npy.dataStart, bytes.length - npy.dataStart);
  const values = [];
  for (let i = 0; i < Math.min(max, count, Math.floor(dv.byteLength / size)); i++) {
    const v = dv[getter](i * size, little);
    if (m[2] === "b") values.push(v ? "True" : "False");
    else if (size === 4 && m[2] === "f") values.push(float32Text(v));
    else values.push(String(v));
  }
  return { values, count };
}

/** .npy: shape, dtype and order from the header, and the first values for the common dtypes. */
async function showNpy(info, ctl, stats) {
  const bytes = await readHead(info, ctl, stats, NPY_HEAD);
  const npy = parseNpy(bytes);
  if (!npy) return showDetails(info, t("This isn't a NumPy .npy file"));
  const vals = npyValues(bytes, npy, NPY_VALUES);
  const shape = npy.shape ? `(${npy.shape.join(", ")}${npy.shape.length === 1 ? "," : ""})` : "?";
  const all = vals && vals.values.length === vals.count;
  view.className = "";
  view.replaceChildren(
    h(
      "div",
      { class: "npy" },
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, t("Shape")),
        h("dd", {}, shape),
        h("dt", {}, t("Data type")),
        h("dd", {}, npy.descr ?? "?"),
        h("dt", {}, t("Order")),
        h("dd", {}, npy.fortran ? t("Fortran (column by column)") : t("C (row by row)")),
        h("dt", {}, t("Format")),
        h("dd", {}, `NPY ${npy.version}`),
        h("dt", {}, t("Header")),
        h("dd", { class: "mono" }, npy.header),
      ),
      vals
        ? [
            h("h2", {}, all ? tn("All {count} value", "All {count} values", vals.count) : tn("First {count} value", "First {count} values", vals.values.length)),
            npy.fortran && vals.count > 1 ? h("p", { class: "muted" }, t("In the order they are stored: column by column.")) : null,
            h("pre", { class: "text wrap values" }, vals.values.join(", ")),
          ]
        : h("p", { class: "muted" }, t("Values are shown for number and true/false arrays only.")),
    ),
  );
  const whole = bytes.length >= info.entry.usize;
  setStats(`${whole ? t("Whole file") : t("First {shown} of {size}", { shown: humanBytes(bytes.length), size: humanBytes(info.entry.usize) })} · ${downloadedLine(stats, info)}`);
  return true;
}

async function showBlob(info, ctl, stats, kind) {
  const limit = LIMITS[kind];
  if (info.entry.usize > limit && !current?.force) {
    card(
      t("This file is {size}", { size: humanBytes(info.entry.usize) }),
      h("p", { class: "muted" }, t("A preview holds the whole file in memory. For a file this big, extracting it is usually better.")),
      h("p", {}, h("button", { class: "btn", type: "button", onclick: () => show(true) }, t("Preview anyway"))),
    );
    setStats("");
    return true;
  }
  view.className = "center";
  view.replaceChildren(h("div", { class: "spinner", role: "img", "aria-label": t("Loading") }));
  setStats(t("Loading {size}...", { size: humanBytes(info.entry.usize) }));
  const timer = setInterval(() => setStats(t("Loading: {done} of ~{size}", { done: humanBytes(stats.downloaded), size: humanBytes(info.entry.csize) })), 300);
  let blob;
  try {
    blob = await readAll(info, ctl, stats, MIME[extensionOf(path)] || "application/octet-stream");
  } finally {
    clearInterval(timer);
  }
  let size = null; // an SVG's natural size, to show its raster copy as big as the SVG would be
  if (extensionOf(path) === "svg") {
    // Sharp when zoomed in a little, at most 4096 pixels on its longer side.
    const scale = Math.max(1, devicePixelRatio || 1) * 2;
    const r = await rasterSvg(blob, (w, ht) => Math.min(w * scale, 4096 * Math.min(1, w / ht)), "image/png");
    blob = r.blob;
    size = r;
  }
  if (current?.ctl !== ctl) return true;
  const url = URL.createObjectURL(blob);
  current.url = url;
  const img = h("img", { class: "image", src: url, alt: safeName(fileName(path)) });
  if (size) {
    img.style.maxWidth = `min(100%, ${size.w}px)`;
    img.style.maxHeight = `min(calc(100vh - 140px), ${size.h}px)`;
  }
  view.replaceChildren(img);
  setStats(`${t("Whole file, CRC-32 checked")} · ${downloadedLine(stats, info)}`);
  return true;
}

/**
 * Video, audio and PDFs: played from an address the background worker answers straight from the
 * zip, so nothing is held here and any size works. A stored file can be seeked (only the part
 * the player asks for is downloaded); a compressed one plays from its start.
 */
async function showStreamed(info, kind) {
  const r = await send("previewStream", { source: info.source, entry: info.entry, mime: MIME[extOf(path)] || "application/octet-stream", password: info.password });
  if (!r?.ok) throw new Error(r?.error || "the preview couldn't start");
  const mine = current;
  mine.token = r.token;
  const name = safeName(fileName(path));
  let el;
  if (kind === "pdf") {
    view.className = "";
    el = h("iframe", { class: "pdf", src: r.url, title: name });
  } else {
    el = h(kind, { src: r.url, controls: true, preload: "metadata" });
    el.addEventListener("error", () => {
      if (current !== mine) return;
      card(t("Can't play this file here"), h("p", { class: "muted" }, t("{browser} can't play this format, or the data didn't come through right (it is checked as it plays). Extract it to open it in another player.")));
    });
  }
  view.replaceChildren(el);
  const seekable = info.entry.method === 0 && !info.encrypted;
  const how = seekable ? t("Streamed from the zip, seeking downloads only the part it needs") : t("Streamed from the zip, compressed in it, so it plays from its start");
  const update = async () => {
    const s = await send("previewStats", { token: r.token });
    if (current === mine) setStats(`${how} · ${t("{done} downloaded of a {size} zip", { done: humanBytes(s?.downloaded || 0), size: humanBytes(info.source.size) })}`);
  };
  setStats(how);
  mine.timer = setInterval(update, 1000);
  update();
  return true;
}

/** An encrypted file and no password yet for this zip: ask, and keep it for the zip. */
function askPassword(info, wrong) {
  return new Promise((resolve) => {
    const input = h("input", { type: "password", autocomplete: "off", spellcheck: "false", "aria-label": t("Password") });
    const go = async () => {
      if (!input.value) return input.focus();
      await send("setPassword", { id: jobId, password: input.value });
      resolve(input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!e.isComposing) go(); // Enter that confirms an IME candidate doesn't submit
    });
    card(
      wrong ? t("That password doesn't fit") : t("This file is password-protected"),
      h("p", { class: "muted" }, t("Type the zip's password to see it. LinkUnzip keeps it only while the zip is open, never saved.")),
      h("p", { class: "row" }, input, h("button", { class: "btn primary", type: "button", onclick: go }, t("Show"))),
    );
    setStats("");
    input.focus();
  });
}

function showDetails(info, why) {
  const e = info.entry;
  card(
    why,
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, t("Size")),
      h("dd", {}, humanBytes(e.usize)),
      h("dt", {}, t("In the zip")),
      h("dd", {}, `${humanBytes(e.csize)} (${e.method === 0 ? t("stored") : e.method === 8 ? "deflate" : t("method {n}", { n: e.method })})`),
      h("dt", {}, "CRC-32"),
      h("dd", {}, e.crc.toString(16).padStart(8, "0")),
      h("dt", {}, t("Path")),
      h("dd", {}, safeName(path)),
    ),
    h("p", { class: "muted" }, t("Tick it in LinkUnzip's file list to extract it.")),
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
  $("raw").hidden = true;
  const name = safeName(fileName(path));
  document.title = t("{name} - LinkUnzip preview", { name });
  $("name").textContent = name;
  view.className = "center";
  view.replaceChildren(h("div", { class: "spinner", role: "img", "aria-label": t("Loading") }));
  setStats("");
  announce(t("Loading"));

  const r = await send("entry", { id: jobId, path });
  if (!r?.ok) {
    card(t("Can't show this file"), h("p", { class: "muted" }, r?.error?.message || t("That zip is no longer open in LinkUnzip. Open it again from the popup.")));
    return;
  }
  $("where").textContent = `${safeName(r.name)} · ${parentOf(path) ? safeName(parentOf(path)) : t("top folder")}`;
  updateNav();
  if (r.unsupported) return showDetails(r, t("LinkUnzip can't read this file ({reason})", { reason: r.unsupported }));
  if (r.encrypted && !r.password) {
    r.password = await askPassword(r, false);
    if (current?.ctl !== ctl) return;
  }
  const stats = { downloaded: 0 };
  try {
    await render(r, ctl, stats);
    if (current?.ctl === ctl) announceDone(name);
  } catch (e) {
    if (ctl.signal.aborted) return;
    if (e?.code === "password_wrong") {
      await askPassword(r, true);
      if (current?.ctl === ctl) show(force);
      return;
    }
    const why = e?.message || String(e);
    card(t("Couldn't load this file"), h("p", { class: "bad" }, why));
    announce(`${t("Couldn't load this file")}: ${why}`);
  }
}

/** The file of `r` on screen, by its kind. */
async function render(r, ctl, stats) {
  const kind = kindOf(path);
  // The password is checked on this file's own header first (a streamed one fails quietly).
  if (r.encrypted) await checkPassword(Source.from(r.source, ctl.signal), r.entry, r.password);
  if (STREAMED.has(kind)) return showStreamed(r, kind);
  if (kind === "image") return showBlob(r, ctl, stats, kind);
  if (kind === "csv") return showText(r, ctl, stats, { csv: true });
  if (kind === "npy") return showNpy(r, ctl, stats);
  if (kind === "json" || kind === "jsonl") {
    if (!asText && (await (kind === "json" ? showJson : showJsonl)(r, ctl, stats))) return;
    if (!(await showText(r, ctl, stats))) return showDetails(r, t("This file isn't text"));
    if (asText) offerToggle(kind === "json" ? t("Show formatted") : t("Show as table"));
    return;
  }
  if (kind === "text") {
    if (!(await showText(r, ctl, stats))) showDetails(r, t("This file isn't text"));
    return;
  }
  // Unknown type: show it if it turns out to be text.
  if (r.entry.usize === 0) return showDetails(r, t("This file is empty"));
  if (!(await showText(r, ctl, stats, { sniffOnly: true }))) showDetails(r, t("No preview for .{ext} files", { ext: safeName(extOf(path)) }));
}

// The engine knows each file's place in its folder, so this is one small question per file,
// however many files the folder holds.
async function updateNav() {
  const asked = path;
  const r = await send("neighbors", { id: jobId, path });
  if (asked !== path) return;
  around = r?.ok ? { path, prev: r.prev, next: r.next } : null;
  $("prev").disabled = !around?.prev;
  $("next").disabled = !around?.next;
}

/** This page's address for a file (null: the grid itself), keeping the grid it came from. */
function urlFor(p) {
  let url = `viewer.html?job=${encodeURIComponent(jobId)}`;
  if (grid.dir !== null) url += `&grid=${encodeURIComponent(grid.dir)}`;
  if (p != null) url += `&path=${encodeURIComponent(p)}`;
  return url;
}

function go(step) {
  if (mode !== "preview" || !around || around.path !== path) return;
  const next = step < 0 ? around.prev : around.next;
  if (!next) return;
  path = next;
  asText = false;
  history.replaceState(history.state, "", urlFor(path));
  show();
}

// ---------------------------------------------------------------------------------------
// The image grid
// ---------------------------------------------------------------------------------------

const gridEl = $("grid");
const grid = {
  dir: params.get("grid"), // the folder, "" or "train/"; null when this page is a single preview
  name: "", // the zip's
  images: [], // the folder's image files, as the file list gives them
  cells: [], // those on the page so far: { item, li, open, box, state, near, ctl }
  listed: false,
  downloaded: 0,
  marks: {}, // the popup's ticks for this zip
  wanted: new Set(), // cells near the view, waiting for their thumbnail
  active: new Set(), // cells loading theirs now
  urls: [],
  list: null,
  sentinel: null,
  opener: null, // the cell whose preview is open, for the way back
};
if (grid.dir !== null && grid.dir !== "" && !grid.dir.endsWith("/")) grid.dir += "/";
const cellOf = new WeakMap();

/** The nearest mark wins: the file's own, then its folders' up to the whole zip (""), as in filelist.js. */
function isTicked(marks, p) {
  for (let q = p; q !== null; q = parentOf(q)) {
    if (typeof marks[q] === "boolean") return marks[q];
  }
  return true;
}

function applyTicks() {
  for (const c of grid.cells) c.box.checked = isTicked(grid.marks, c.item.path);
}

// One write at a time, each on the latest drafts, so the popup's other fields and other zips stay.
let writing = Promise.resolve();
function setMark(p, ticked) {
  writing = writing
    .then(async () => {
      const { drafts = {} } = await chrome.storage.session.get("drafts");
      const draft = (drafts[jobId] ??= {});
      const marks = (draft.marks = isRecord(draft.marks) ? draft.marks : {});
      delete marks[p];
      // A mark that only repeats its folder's is left out, as the file list does.
      if (isTicked(marks, p) !== ticked) marks[p] = ticked;
      grid.marks = marks;
      await chrome.storage.session.set({ drafts });
    })
    .catch(() => applyTicks());
}

// Ticks made in the popup meanwhile.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "session" || !changes.drafts || grid.dir === null) return;
  const marks = changes.drafts.newValue?.[jobId]?.marks;
  grid.marks = isRecord(marks) ? marks : {};
  applyTicks();
});

function updateGridLine() {
  if (mode !== "grid") return;
  const count = tn("{count} image", "{count} images", grid.images.length);
  setStats(`${count}${grid.listed ? "" : "..."} · ${t("Previews downloaded: {size}", { size: humanBytes(grid.downloaded) })}`);
}

function gridMessage(title, text) {
  gridEl.replaceChildren(h("div", { class: "card" }, h("h2", {}, title), h("p", { class: "muted" }, text)));
  gridEl.classList.add("center");
  announce(`${title}. ${text}`);
}

function thumbNote(cell, state, text) {
  cell.state = state;
  cell.open.replaceChildren(h("span", { class: "note" }, text));
}

const nearObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const cell = cellOf.get(e.target);
      cell.near = e.isIntersecting;
      if (cell.near && cell.state === "idle") grid.wanted.add(cell);
      else grid.wanted.delete(cell);
    }
    pump();
  },
  { root: gridEl, rootMargin: "300px 0px" },
);

// More cells when the end of the list comes near.
const moreObserver = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && renderMore(), { root: gridEl, rootMargin: "600px 0px" });

function makeCell(item) {
  const i = grid.cells.length;
  const cell = { item, state: item.size > THUMB_MAX ? "big" : "idle", near: false, ctl: null };
  const name = safeName(item.name);
  cell.open = h("button", { class: "open", type: "button", "aria-label": t("Preview {name}", { name }), onclick: () => openPreview(cell) });
  cell.box = h("input", { type: "checkbox", id: `tick-${i}`, onchange: () => setMark(item.path, cell.box.checked) });
  cell.box.checked = isTicked(grid.marks, item.path);
  const thumb = h("div", { class: "thumb" }, cell.open);
  if (cell.state === "big") {
    cell.open.append(h("span", { class: "note" }, humanBytes(item.size)));
    // Named by its visible text; which image it loads is its description.
    const load = h("button", { class: "btn load", type: "button", "aria-describedby": `name-${i}` }, t("Load"));
    load.addEventListener("click", () => {
      load.remove();
      cell.open.focus();
      cell.state = "idle";
      grid.wanted.add(cell);
      pump();
    });
    thumb.append(load);
  } else if (item.locked) {
    cell.open.append(h("span", { class: "note" }, t("Password-protected")));
  }
  cell.li = h("li", { class: "cell" }, thumb, h("div", { class: "cap" }, cell.box, h("label", { for: `tick-${i}`, id: `name-${i}`, title: safeName(item.path) }, name)));
  cellOf.set(cell.li, cell);
  grid.cells.push(cell);
  nearObserver.observe(cell.li);
  return cell.li;
}

function renderMore() {
  const from = grid.cells.length;
  const to = Math.min(grid.images.length, from + GRID_BATCH);
  if (to <= from) return;
  const frag = document.createDocumentFragment();
  for (let k = from; k < to; k++) frag.append(makeCell(grid.images[k]));
  grid.list.append(frag);
  recheckMore();
}

/** Still in view after these? Observing again makes the observer answer once more. */
function recheckMore() {
  moreObserver.unobserve(grid.sentinel);
  moreObserver.observe(grid.sentinel);
}

/** Start thumbnails for the cells near the view, THUMB_LOADS at a time, in page order. */
function pump() {
  if (mode !== "grid" || document.hidden) return;
  for (const cell of grid.wanted) {
    if (grid.active.size >= THUMB_LOADS) break;
    grid.wanted.delete(cell);
    if (cell.state === "idle") loadThumb(cell);
  }
}

/** Stop the thumbnails on their way (the page is hidden, or a preview is open); they start over later. */
function pauseThumbs() {
  for (const cell of grid.active) cell.ctl.abort();
}

/** A small WebP of the image, so the full picture can be let go. SVGs too, drawn the same way. */
async function thumbBlob(blob, ext) {
  const width = Math.round(THUMB * Math.min(devicePixelRatio || 1, 2));
  if (ext === "svg") return (await rasterSvg(blob, () => width, "image/webp", 0.8)).blob;
  const bmp = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: "medium" });
  try {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    canvas.getContext("2d").drawImage(bmp, 0, 0);
    return await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  } finally {
    bmp.close();
  }
}

async function loadThumb(cell) {
  const ctl = new AbortController();
  const stats = { downloaded: 0 };
  cell.ctl = ctl;
  cell.state = "loading";
  grid.active.add(cell);
  cell.open.replaceChildren(h("span", { class: "spinner", "aria-hidden": "true" }));
  try {
    const r = await send("entry", { id: jobId, path: cell.item.path });
    if (ctl.signal.aborted) throw new DOMException("Paused", "AbortError");
    if (!r?.ok || r.unsupported) return thumbNote(cell, "failed", t("No preview"));
    if (r.encrypted && !r.password) return thumbNote(cell, "locked", t("Password-protected"));
    const ext = extOf(cell.item.path);
    let blob = await readAll(r, ctl, stats, MIME[ext] || "application/octet-stream");
    const small = await thumbBlob(blob, ext);
    blob = null;
    const url = URL.createObjectURL(small);
    grid.urls.push(url);
    cell.open.replaceChildren(h("img", { src: url, alt: "", decoding: "async" }));
    cell.state = "done";
    nearObserver.unobserve(cell.li);
  } catch {
    if (ctl.signal.aborted) {
      cell.state = "idle";
      cell.open.replaceChildren();
      if (cell.near) grid.wanted.add(cell);
    } else {
      thumbNote(cell, "failed", t("Can't show this image"));
    }
  } finally {
    grid.downloaded += stats.downloaded;
    grid.active.delete(cell);
    updateGridLine();
    pump();
  }
}

async function listImages() {
  for (let offset = 0; ; ) {
    const r = await send("list", { id: jobId, dir: grid.dir, offset, limit: LIST_PAGE });
    if (!r?.ok) {
      if (!grid.images.length) gridMessage(t("Can't show this folder"), r?.error?.message || t("That zip is no longer open in LinkUnzip. Open it again from the popup."));
      break;
    }
    const { items, total } = r.listing;
    for (const it of items) if (!it.dir && kindOf(it.path) === "image") grid.images.push(it);
    offset += items.length;
    if (grid.cells.length < GRID_BATCH) renderMore();
    else recheckMore();
    updateGridLine();
    if (!items.length || offset >= total) break;
  }
  grid.listed = true;
  updateGridLine();
  if (grid.images.length && mode === "grid") announce(tn("{count} image", "{count} images", grid.images.length));
  if (!grid.images.length && grid.list.isConnected) gridMessage(t("No images in this folder"), t("The grid shows PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG files."));
}

async function startGrid() {
  const s = await chrome.storage.session.get(["drafts", "jobs"]);
  const marks = s.drafts?.[jobId]?.marks;
  grid.marks = isRecord(marks) ? marks : {};
  grid.name = s.jobs?.[jobId]?.name || "";
  grid.list = h("ul", { class: "cells", "aria-label": t("Images") });
  grid.sentinel = h("div", { class: "sentinel" });
  // How it works, once at the top: what a thumbnail costs, and that nothing is kept.
  const note = h("p", { class: "grid-note muted" }, t("Each preview downloads only its own image, as you scroll. Nothing is saved: the previews are gone when you close this tab."));
  gridEl.replaceChildren(note, grid.list, grid.sentinel);
  enterGrid(false);
  listImages();
}

function enterGrid(focus = true) {
  release();
  announce("");
  mode = "grid";
  path = null;
  view.hidden = true;
  view.replaceChildren();
  gridEl.hidden = false;
  for (const id of ["back", "prev", "next", "more", "wrap-box", "raw"]) $(id).hidden = true;
  const name = safeName(grid.dir ? fileName(grid.dir.slice(0, -1)) : grid.name || t("Images"));
  document.title = t("{name} - LinkUnzip preview", { name });
  $("name").textContent = name;
  $("where").textContent = `${safeName(grid.name)}${grid.name ? " · " : ""}${grid.dir ? safeName(grid.dir) : t("top folder")}`;
  // A password typed in a preview meanwhile opens the locked ones.
  for (const c of grid.cells) {
    if (c.state !== "locked") continue;
    c.state = "idle";
    if (c.near) grid.wanted.add(c);
  }
  updateGridLine();
  pump();
  if (focus) (grid.opener?.open || gridEl).focus();
}

function enterPreview(p) {
  mode = "preview";
  pauseThumbs();
  path = p;
  asText = false;
  gridEl.hidden = true;
  view.hidden = false;
  $("prev").hidden = false;
  $("next").hidden = false;
  $("back").hidden = grid.dir === null;
  show();
  view.focus();
}

function openPreview(cell) {
  grid.opener = cell;
  history.pushState({ fromGrid: true }, "", urlFor(cell.item.path));
  enterPreview(cell.item.path);
}

function backToGrid() {
  if (history.state?.fromGrid) return history.back(); // popstate does the rest
  history.replaceState(null, "", urlFor(null));
  enterGrid();
}

addEventListener("popstate", () => {
  if (grid.dir === null) return;
  const p = new URLSearchParams(location.search).get("path");
  if (p) enterPreview(p);
  else enterGrid();
});
addEventListener("pagehide", () => {
  pauseThumbs();
  for (const url of grid.urls) URL.revokeObjectURL(url);
});
document.addEventListener("visibilitychange", () => (document.hidden ? pauseThumbs() : pump()));

// ---------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------

$("prev").addEventListener("click", () => go(-1));
$("next").addEventListener("click", () => go(1));
$("back").addEventListener("click", backToGrid);
$("raw").addEventListener("click", () => {
  asText = !asText;
  show();
});
/** Elements that use the arrow keys themselves: fields, players (seeking), embedded pages. */
const OWN_ARROWS = "input, textarea, select, video, audio, iframe, embed, object, [contenteditable]";

/** Left/Right belong to the focused element when it, or a box around it, scrolls sideways. */
function scrollsSideways(el) {
  for (; el && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth && /auto|scroll/.test(getComputedStyle(el).overflowX)) return true;
  }
  return false;
}

addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key === "Escape") {
    if (mode === "preview" && grid.dir !== null && !e.target.closest?.("input, textarea, select")) backToGrid();
    return;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  if (e.target.closest?.(OWN_ARROWS) || scrollsSideways(e.target)) return;
  go(e.key === "ArrowLeft" ? -1 : 1);
});
$("wrap").addEventListener("change", () => view.querySelector("pre.text")?.classList.toggle("wrap", $("wrap").checked));
// The viewer is reused for the next preview: the background loads a new address into this tab.
await loadLanguage((await loadSettings()).language);
translatePage();
if (grid.dir === null) show();
else {
  await startGrid();
  if (path) enterPreview(path);
}
