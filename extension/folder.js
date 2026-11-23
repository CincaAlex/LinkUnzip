// Folders the user chose with Chrome's folder picker. The handles are kept in IndexedDB (the only
// place they can be stored), so a choice survives closing the popup and restarting the browser.
// Chrome may still ask again for permission to write there after a restart.
//
// Keys: "base" is the folder from Settings (every job goes into a subfolder of it); "job:<id>" is
// a folder picked for one job; "recent:<n>" are the last folders picked (rememberFolder).

const DB = "linkunzip";
const STORE = "folders";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const getFolder = (key) => tx("readonly", (s) => s.get(key)).catch(() => null);
export const setFolder = (key, handle) => tx("readwrite", (s) => s.put(handle, key));
export const removeFolder = (key) => tx("readwrite", (s) => s.delete(key)).catch(() => {});

/** "granted", "prompt" or "denied" for writing into `handle`. */
export async function folderPermission(handle) {
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

/** Ask Chrome for write access (needs a click on the page). True when it's granted. */
export async function askFolderPermission(handle) {
  if ((await folderPermission(handle)) === "granted") return true;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch {
    return false;
  }
}

/** Chrome's folder picker (needs a click). The handle, or null when the user cancelled. */
export async function pickFolder() {
  try {
    return await showDirectoryPicker({ id: "linkunzip", mode: "readwrite", startIn: "downloads" });
  } catch (e) {
    if (e?.name === "AbortError") return null;
    throw e;
  }
}

// The last folders picked, newest first, under "recent:0" to "recent:<RECENT - 1>".
const RECENT = 5;

/** Remember a folder the user just picked (once: Chrome tells whether two handles are the same folder). */
export async function rememberFolder(handle) {
  const list = [handle];
  for (let i = 0; i < RECENT; i++) {
    const known = await getFolder(`recent:${i}`);
    if (!known) continue;
    let dup = false;
    for (const h of list) dup ||= await h.isSameEntry(known).catch(() => false);
    if (!dup) list.push(known);
  }
  for (let i = 0; i < RECENT; i++) {
    if (list[i]) await setFolder(`recent:${i}`, list[i]);
    else await removeFolder(`recent:${i}`);
  }
}

/** `[{key, name}]` of the folders picked lately, newest first. */
export async function recentFolders() {
  const out = [];
  for (let i = 0; i < RECENT; i++) {
    const h = await getFolder(`recent:${i}`);
    if (h) out.push({ key: `recent:${i}`, name: h.name });
  }
  return out;
}

/** `blender-4.2.0` inside `LinkUnzip`: what the popup shows for where files go. */
export const folderLabel = (base, sub) => (sub ? `${base} > ${sub}` : base);
