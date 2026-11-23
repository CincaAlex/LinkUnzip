// A selection in a link: the file list's ticks (`{marks}`), a random sample (`{sample}`) or
// everything (null), packed small enough for a URL fragment. Used by the share link and by the
// command for another machine. Whatever comes back from a link is checked before use: it was
// typed or pasted by someone else.

import { isSigned } from "./engine/source.js";

export const SHARE_PAGE = "https://linkunzip.app/open";
export const MAX_ENCODED = 8192;
export const MAX_JSON = 256 * 1024;
export const MAX_MARKS = 20_000;
export const MAX_KEY = 4096;
export const MAX_FRAGMENT = 12_000;
const MAX_SAMPLE = 10_000;

// Uint8Array.toBase64 / fromBase64 are new (not in Chrome 116 or Node 22): use them when there,
// else btoa / atob.
function toBase64url(bytes) {
  if (bytes.toBase64) return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text, { alphabet: "base64url" });
  const s = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** `sel` as text for a link: JSON, deflate-raw, base64url. "" for everything. */
export async function encodeSelection(sel) {
  if (!sel) return "";
  const body = sel.sample ? { sample: sel.sample } : { marks: sel.marks || {} };
  const stream = new Blob([JSON.stringify(body)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const text = toBase64url(new Uint8Array(await new Response(stream).arrayBuffer()));
  if (text.length > MAX_ENCODED) throw new Error("the selection is too large for a link");
  return text;
}

/** Inflate, stopping as soon as the result passes MAX_JSON (a small link can unpack huge). */
async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_JSON) {
        reader.cancel().catch(() => {});
        throw new Error("the selection unpacks too large");
      }
      parts.push(value);
    }
  } catch (e) {
    throw e instanceof Error && e.message.startsWith("the selection") ? e : new Error("the selection is damaged");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const isText = (v, max) => typeof v === "string" && v.length <= max;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** The selection a link carries: `{marks}`, `{sample}` or null for everything. Throws on anything else. */
export async function decodeSelection(text) {
  if (text == null || text === "") return null;
  if (!isText(text, MAX_ENCODED) || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("the selection is not valid");
  let body;
  try {
    const bytes = await inflate(fromBase64url(text));
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (e) {
    throw e instanceof Error && e.message.startsWith("the selection") ? e : new Error("the selection is damaged");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("the selection is not valid");
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "marks") {
    const m = body.marks;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("the selection is not valid");
    const entries = Object.entries(m);
    if (entries.length > MAX_MARKS) throw new Error("the selection has too many marks");
    const marks = {};
    for (const [k, v] of entries) {
      if (k.length > MAX_KEY || typeof v !== "boolean") throw new Error("the selection is not valid");
      marks[k] = v;
    }
    return { marks };
  }
  if (keys.length === 1 && keys[0] === "sample") {
    const s = body.sample;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("the selection is not valid");
    const { n, seed, scope = "", query = "", ext = "" } = s;
    const ok =
      isInt(n, 1, MAX_SAMPLE) &&
      isInt(seed, 0, 0xffffffff) &&
      isText(scope, MAX_KEY) &&
      (scope === "" || scope.endsWith("/")) &&
      isText(query, 1024) &&
      isText(ext, 32) &&
      !ext.includes("/");
    if (!ok) throw new Error("the selection is not valid");
    return { sample: { n, seed, scope, query, ext } };
  }
  throw new Error("the selection is not valid");
}

/** The share link: the zip's link, the selection and its totals, all after the `#`. */
export function shareLink({ url, selection = "", files = null, bytes = null }) {
  const parts = [`v=1`, `u=${encodeURIComponent(url)}`];
  if (selection) parts.push(`s=${selection}`);
  if (Number.isSafeInteger(files) && files >= 0) parts.push(`n=${files}`);
  if (Number.isSafeInteger(bytes) && bytes >= 0) parts.push(`b=${bytes}`);
  const fragment = parts.join("&");
  if (fragment.length > MAX_FRAGMENT) throw new Error("the selection is too large for a link");
  return `${SHARE_PAGE}#${fragment}`;
}

/** `{v, url, s, n, b}` from a share link's `#...`; throws if it isn't one LinkUnzip made. */
export function parseShareFragment(hash) {
  const text = String(hash ?? "").replace(/^#/, "");
  if (text.length > MAX_FRAGMENT) throw new Error("the link is too long");
  const p = new URLSearchParams(text);
  if (p.get("v") !== "1") throw new Error("the link is from another version");
  const url = p.get("u") || "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("the link has no valid zip address");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("the link has no valid zip address");
  const count = (name) => {
    const v = p.get(name);
    if (v == null) return null;
    if (!/^\d{1,16}$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error("the link is not valid");
    return Number(v);
  };
  const s = p.get("s");
  if (s != null && (s.length > MAX_ENCODED || !/^[A-Za-z0-9_-]*$/.test(s))) throw new Error("the link is not valid");
  return { v: 1, url, s: s || null, n: count("n"), b: count("b") };
}

/** A link that carries a signature or an expiry, so it may stop working before someone opens it. */
export const looksTemporary = (url) => isSigned(url);
