// Big previews straight from the zip. The viewer's <video>, <audio> or PDF frame asks this worker
// for /preview/<token>/<name>, and the worker answers from the remote zip: nothing is held in
// memory, so there is no size limit.
//
// * A stored file is seekable: each range the player asks for is that range of the zip (one
//   Range request each, with If-Range like every other request).
// * A compressed or encrypted file is inflated (and decrypted) on the way from its first byte; a
//   player that asks to start further in gets there after reading up to that point.
//
// A file read to its end is checked (size and CRC-32); a mismatch breaks the stream, so the
// player stops instead of showing changed data. Tokens are kept in chrome.storage.session
// (without the password), so a restarted worker still knows them; a password only in memory.

import { dataStartOf, entryBody } from "./engine/entry.js";
import { Source } from "./engine/source.js";
import { isEncrypted } from "./engine/zip.js";

const PREFIX = "/preview/";
/** Tokens older than this are forgotten. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const tokens = new Map(); // token -> { source, entry, mime, dataStart, downloaded, created }
const secrets = new Map(); // token -> the zip's password

async function save() {
  const now = Date.now();
  for (const [t, info] of tokens) if (now - info.created > MAX_AGE_MS) tokens.delete(t);
  const plain = Object.fromEntries([...tokens].map(([t, { source, entry, mime, created }]) => [t, { source, entry, mime, created }]));
  await chrome.storage.session.set({ previewTokens: plain }).catch(() => {});
}

async function lookup(token) {
  if (tokens.has(token)) return tokens.get(token);
  const { previewTokens = {} } = await chrome.storage.session.get("previewTokens").catch(() => ({}));
  const saved = previewTokens[token];
  if (!saved) return null;
  const info = { ...saved, downloaded: 0 };
  tokens.set(token, info);
  return info;
}

/** A file of the viewer's, served at the address this returns. */
export async function registerPreview({ source, entry, mime, password }) {
  const token = crypto.randomUUID();
  tokens.set(token, { source, entry, mime, downloaded: 0, created: Date.now() });
  if (password) secrets.set(token, password);
  await save();
  const name = encodeURIComponent(entry.name.slice(entry.name.lastIndexOf("/") + 1));
  return { token, url: chrome.runtime.getURL(`${PREFIX.slice(1)}${token}/${name}`) };
}

/** How much this preview has downloaded so far. */
export const previewStats = (token) => ({ downloaded: tokens.get(token)?.downloaded ?? 0 });

/** The viewer moved on: the token goes. */
export async function dropPreview(token) {
  tokens.delete(token);
  secrets.delete(token);
  await save();
}

/** `bytes=a-b` / `bytes=a-` for a file of `size` bytes: [start, end], null for none, "bad" if outside. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "bad" : [start, end];
}

/** Counts what passes through, into `info.downloaded`. */
const counted = (body, info) =>
  body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        info.downloaded += chunk.length;
        controller.enqueue(chunk);
      },
    }),
  );

/** The worker's fetch handler: answers the preview addresses, leaves everything else alone. */
export function handlePreviewFetch(event) {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  event.respondWith(answer(event.request, url.pathname.slice(PREFIX.length).split("/")[0]));
}

async function answer(request, token) {
  const info = await lookup(token);
  if (!info) return new Response("This preview is no longer open. Open it again from LinkUnzip.", { status: 404 });
  const { entry } = info;
  const headers = { "Content-Type": info.mime, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
  const range = parseRange(request.headers.get("range"), entry.usize);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${entry.usize}` } });
  const [start, end] = range || [0, entry.usize - 1];
  const length = Math.max(0, end - start + 1);
  const part = range ? { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${entry.usize}`, "Content-Length": String(length) } } : { status: 200, headers: { ...headers, "Content-Length": String(length) } };
  if (!length) return new Response(new Uint8Array(0), part);
  try {
    const src = Source.from(info.source);
    if (entry.method === 0 && !isEncrypted(entry)) {
      info.dataStart ??= await dataStartOf(src, entry);
      const resp = await src.openRange(info.dataStart + start, info.dataStart + end);
      return new Response(counted(resp.body, info), part);
    }
    const body = entryBody(src, entry, entry.regionEnd, secrets.get(token) ?? null, {
      skip: start,
      limit: length,
      onData: (n) => (info.downloaded += n),
    });
    return new Response(body, part);
  } catch (e) {
    return new Response(`LinkUnzip couldn't read this file from the zip: ${e?.message || e}`, { status: 502 });
  }
}
