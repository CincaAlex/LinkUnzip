// The hidden page the background opens while LinkUnzip works. It runs the extraction engine, so
// a job keeps going when the popup closes. It talks to the background over one port, with the
// same messages the native helper uses.

import { downloadsSink } from "./engine/dl-sink.js";
import { createEngine } from "./engine/engine.js";
import { Coded } from "./engine/errors.js";
import { folderSink } from "./engine/fsa-sink.js";
import { folderLabel, folderPermission, getFolder } from "./folder.js";

// What each job saved through Chrome's downloads (path -> "crc:size"), so Resume can skip it:
// those files can't be read back. Kept while this page runs.
const savedByJob = new Map();

/**
 * `{key, sub}`: the saved folder `key` ("downloads" for Chrome's own downloads), and a subfolder
 * of it to create (or "" for none). `job` is the job's id.
 */
async function openSink(target, job) {
  if (target?.key === "downloads") {
    if (!savedByJob.has(job)) savedByJob.set(job, new Map());
    return downloadsSink({
      sub: target.sub,
      label: folderLabel("Downloads", target.sub),
      saved: savedByJob.get(job),
      save: (m) => saveFile({ cmd: "saveFile", job, ...m }),
    });
  }
  const root = target?.key ? await getFolder(target.key) : null;
  if (!root) throw new Coded("no_folder", "Choose a folder to extract into.");
  if ((await folderPermission(root)) !== "granted") {
    throw new Coded("folder_permission", `LinkUnzip needs your permission again to write into ${root.name}.`);
  }
  let dir = root;
  if (target.sub) {
    try {
      dir = await root.getDirectoryHandle(target.sub, { create: true });
    } catch (e) {
      throw new Coded("folder_not_writable", `Couldn't create the folder ${target.sub} in ${root.name}.`, { detail: `${e?.name}: ${e?.message}` });
    }
  }
  return folderSink(dir, folderLabel(root.name, target.sub));
}

// Offscreen pages have no chrome.downloads: the background saves the blob. If Chrome restarts the
// background meanwhile, the answer is lost: ask again (the file is simply saved over).
async function saveFile(message) {
  let error = "no answer from the background";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await chrome.runtime.sendMessage(message);
      if (r) return r;
    } catch (e) {
      error = String(e?.message || e);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ok: false, code: "failed", error };
}

let port = null;

// Chrome stops the background worker when nothing happens for a while, which cuts this port.
// With a job running, connect again at once (that wakes the worker up) so its progress keeps
// arriving; an idle page stays quiet and the background starts a fresh one when it needs it.
function connect() {
  port = chrome.runtime.connect({ name: "engine" });
  port.onMessage.addListener((m) => engine.handle(m));
  port.onDisconnect.addListener(() => {
    port = null;
    if (engine.busy) connect();
  });
}

// Offscreen pages only get part of chrome.runtime (no getManifest): the background fills in the
// version.
const engine = createEngine({
  post: (m) => {
    if (!port) connect();
    port.postMessage(m);
  },
  openSink,
});

connect();
