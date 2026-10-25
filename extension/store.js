// What LinkUnzip keeps between sessions in the browser's own storage (IndexedDB), all on this PC:
//
// * Zip indexes: the central directories of the last few zips opened, so opening one again (or
//   the engine reading it again after its page was closed while idle) downloads nothing more than
//   one byte. Keyed by link, size and ETag / Last-Modified, so a changed file is read afresh. At
//   most MAX_INDEXES and MAX_INDEX_BYTES, none older than INDEX_DAYS.
// * Saved runs: the files an unfinished extraction into Downloads already saved, so Resume skips
//   them even after the engine's page closed. Removed when that extraction finishes, and after
//   RUN_DAYS otherwise.
//
// The folder handles live in their own database (folder.js).

const DB = "linkunzip-cache";
const MAX_INDEXES = 12;
const MAX_INDEX_BYTES = 128 << 20;
const DAY = 24 * 60 * 60 * 1000;
const INDEX_DAYS = 7;
const RUN_DAYS = 30;
/** Saved files are written in batches, this often. */
const RUN_FLUSH_MS = 1000;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("index_info", { keyPath: "key" }); // {key, url, size, bytes, at}
      db.createObjectStore("index_bytes", { keyPath: "key" }); // {key, cd, count, offset}
      db.createObjectStore("runs", { keyPath: "run" }); // {run, sub, at}
      db.createObjectStore("saved", { keyPath: ["run", "path"] }); // {run, path, sig}
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** Run `fn(stores)` in one transaction over `names`; resolves with its result once committed. */
async function tx(names, mode, fn) {
  const db = await open();
  try {
    const t = db.transaction(names, mode);
    const finished = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let result;
    try {
      result = await fn(stores);
    } catch (e) {
      finished.catch(() => {});
      try {
        t.abort();
      } catch {
        // Already finished.
      }
      throw e;
    }
    await finished;
    return result;
  } finally {
    db.close();
  }
}

/** Every saved file of one run: [run] sorts before [run, anything], and arrays after strings. */
const runRange = (run) => IDBKeyRange.bound([run], [run, []]);

// ---------------------------------------------------------------------------------------
// Zip indexes
// ---------------------------------------------------------------------------------------

export const indexCache = {
  /** The raw index for `key` ({cd, count, offset}), or null. */
  async get(key) {
    return tx(["index_info", "index_bytes"], "readwrite", async ({ index_info, index_bytes }) => {
      const info = await done(index_info.get(key));
      if (!info || Date.now() - info.at > INDEX_DAYS * DAY) return null;
      const raw = await done(index_bytes.get(key));
      if (!raw) return null;
      index_info.put({ ...info, at: Date.now() });
      return { cd: raw.cd, count: raw.count, offset: raw.offset };
    });
  },

  async put(key, raw, { url, size }) {
    const bytes = raw.cd.byteLength;
    if (bytes > MAX_INDEX_BYTES) return;
    await tx(["index_info", "index_bytes"], "readwrite", async ({ index_info, index_bytes }) => {
      index_bytes.put({ key, cd: raw.cd, count: raw.count, offset: raw.offset });
      index_info.put({ key, url, size, bytes, at: Date.now() });
      // Keep the newest ones within the limits.
      const all = (await done(index_info.getAll())).sort((a, b) => b.at - a.at);
      let total = 0;
      all.forEach((info, i) => {
        total += info.bytes;
        const old = Date.now() - info.at > INDEX_DAYS * DAY;
        if (i >= MAX_INDEXES || total > MAX_INDEX_BYTES || old) {
          index_info.delete(info.key);
          index_bytes.delete(info.key);
        }
      });
    });
  },

  async clear() {
    await tx(["index_info", "index_bytes"], "readwrite", async ({ index_info, index_bytes }) => {
      index_info.clear();
      index_bytes.clear();
    });
  },
};

// ---------------------------------------------------------------------------------------
// Saved runs (Downloads)
// ---------------------------------------------------------------------------------------

/** How many files an unfinished run into Downloads already saved (0 when there is none). */
export async function savedCount(run) {
  return tx(["runs", "saved"], "readonly", async ({ runs, saved }) => {
    const info = await done(runs.get(run));
    if (!info || Date.now() - info.at > RUN_DAYS * DAY) return 0;
    return done(saved.count(runRange(run)));
  });
}

export const runStore = {
  /** One run's record: load() its saved files, add() more, flush(), clear() it for good. */
  async openRun(run, { sub }) {
    let pending = [];
    let timer = null;
    let writing = Promise.resolve();
    const flush = () => {
      clearTimeout(timer);
      timer = null;
      if (!pending.length) return writing;
      const batch = pending;
      pending = [];
      writing = writing.then(() =>
        tx(["runs", "saved"], "readwrite", async ({ runs, saved }) => {
          runs.put({ run, sub, at: Date.now() });
          for (const [path, sig] of batch) saved.put({ run, path, sig });
        }).catch(() => {}),
      );
      return writing;
    };
    // Old runs nobody resumed: gone after a month.
    tx(["runs", "saved"], "readwrite", async ({ runs, saved }) => {
      for (const info of await done(runs.getAll())) {
        if (Date.now() - info.at > RUN_DAYS * DAY) {
          runs.delete(info.run);
          saved.delete(runRange(info.run));
        }
      }
    }).catch(() => {});
    return {
      async load() {
        const rows = await tx(["saved"], "readonly", ({ saved }) => done(saved.getAll(runRange(run))));
        return rows.map((r) => [r.path, r.sig]);
      },
      add(path, sig) {
        pending.push([path, sig]);
        timer ??= setTimeout(flush, RUN_FLUSH_MS);
      },
      flush,
      async clear() {
        clearTimeout(timer);
        timer = null;
        pending = [];
        await writing;
        await tx(["runs", "saved"], "readwrite", async ({ runs, saved }) => {
          runs.delete(run);
          saved.delete(runRange(run));
        }).catch(() => {});
      },
    };
  },
};
