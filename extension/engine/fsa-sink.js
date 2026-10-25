// Writing into a folder the user picked (File System Access). Chrome writes each file to a
// temporary `<name>.crswap` next to it and only gives it its name on close(); abort() throws it
// away. That is the same guarantee as the helper's `.part` files: a file that did not check out
// never appears under its real name.
//
// While a job runs, the folder also holds the helper's resume journal (.linkunzip-resume.jsonl,
// same format as src/resume.rs): the archive's identity, then one line per finished file. Resume
// skips the files it lists that are still there, without reading them back; the journal goes
// away when the job finishes.

import { Coded } from "./errors.js";
import { JOURNAL_NAME } from "./plan.js";

const BUFFER = 1 << 20; // fewer, bigger writes: each one is a round trip to the browser
/** Finished files are added to the journal this often (each write is a few round trips). */
const JOURNAL_MS = 2000;

const sameIdentity = (a, b) => a && b && a.size === b.size && (a.etag ?? null) === (b.etag ?? null) && (a.last_modified ?? null) === (b.last_modified ?? null);

function fsError(e, what) {
  const name = e?.name;
  if (name === "QuotaExceededError") return new Coded("disk_full", "The drive is full.", { detail: `${what}: ${e.message}` });
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Coded("folder_permission", "LinkUnzip isn't allowed to write into this folder any more.", { detail: `${what}: ${e.message}` });
  }
  if (name === "NotFoundError") return new Coded("folder_not_writable", "The folder was moved or deleted.", { detail: `${what}: ${e.message}` });
  if (name === "NoModificationAllowedError" || name === "InvalidModificationError") {
    return new Coded("folder_not_writable", `Couldn't write ${what}: the file is in use or read-only.`, { detail: e.message });
  }
  return new Coded("folder_not_writable", `Couldn't write ${what}.`, { detail: `${name || "Error"}: ${e?.message || e}` });
}

/**
 * A sink over `root` (a FileSystemDirectoryHandle with write permission). `label` is what the
 * popup shows for the folder.
 */
export function folderSink(root, label) {
  const dirs = new Map([["", root]]);
  const renames = [];

  async function dir(parts, create = true) {
    let path = "";
    let handle = root;
    for (const part of parts) {
      const next = path ? `${path}/${part}` : part;
      let h = dirs.get(next);
      if (!h) {
        h = await childDir(handle, part, create, next);
        dirs.set(next, h);
      }
      handle = h;
      path = next;
    }
    return handle;
  }

  // Chrome refuses some names Windows itself would take (for example `.lnk` and `.local` files):
  // then the name gets a `_` at the end and the rename is reported.
  async function childDir(parent, name, create, path) {
    try {
      return await parent.getDirectoryHandle(name, { create });
    } catch (e) {
      if (e?.name === "TypeError" && create) {
        renames.push([path, `${path}_`]);
        return parent.getDirectoryHandle(`${name}_`, { create });
      }
      throw fsError(e, `the folder ${path}`);
    }
  }

  async function fileHandle(parts, create) {
    const parent = await dir(parts.slice(0, -1), create);
    const name = parts[parts.length - 1];
    try {
      return await parent.getFileHandle(name, { create });
    } catch (e) {
      if (e?.name !== "TypeError" || !create) throw e;
      renames.push([parts.join("/"), `${parts.join("/")}_`]);
      return parent.getFileHandle(`${name}_`, { create });
    }
  }

  // ---- the resume journal ----
  const journal = { known: new Map(), pending: [], size: 0, timer: null, writing: Promise.resolve(), on: false };

  async function journalText() {
    try {
      return await (await (await root.getFileHandle(JOURNAL_NAME)).getFile()).text();
    } catch {
      return null;
    }
  }

  /** Append `text` (or start the file afresh with it). Best effort: Resume can read files instead. */
  function journalWrite(text, fresh = false) {
    journal.writing = journal.writing.then(async () => {
      try {
        const handle = await root.getFileHandle(JOURNAL_NAME, { create: true });
        const w = await handle.createWritable({ keepExistingData: !fresh });
        if (!fresh) await w.seek(journal.size);
        await w.write(text);
        await w.close();
        journal.size = (fresh ? 0 : journal.size) + new TextEncoder().encode(text).length;
      } catch {
        journal.on = false;
      }
    });
    return journal.writing;
  }

  function journalFlush() {
    clearTimeout(journal.timer);
    journal.timer = null;
    if (!journal.on || !journal.pending.length) return journal.writing;
    const text = journal.pending.join("");
    journal.pending = [];
    return journalWrite(text);
  }

  // Which names are in a folder, read once per folder: one listing instead of a lookup per file.
  const listed = new Map();
  async function namesIn(parts) {
    const key = parts.join("/");
    if (!listed.has(key)) {
      listed.set(
        key,
        (async () => {
          const names = new Set();
          try {
            const d = await dir(parts, false);
            for await (const [name, handle] of d.entries()) if (handle.kind === "file") names.add(name);
          } catch {
            // No such folder: nothing in it.
          }
          return names;
        })(),
      );
    }
    return listed.get(key);
  }

  return {
    label,
    renames,

    /**
     * Start the journal, or carry on with the one an earlier, unfinished run of this same archive
     * left (also when the job was started afresh: its job may have been closed meanwhile).
     * Answers `{earlier}`: how many finished files that journal lists.
     */
    async begin({ identity }) {
      journal.on = true;
      const text = await journalText();
      const lines = text ? text.split("\n") : [];
      let earlier = null;
      try {
        earlier = lines.length ? JSON.parse(lines[0]) : null;
      } catch {
        earlier = null;
      }
      if (sameIdentity(earlier, identity)) {
        for (const line of lines.slice(1)) {
          try {
            const f = JSON.parse(line);
            if (typeof f.path === "string") journal.known.set(f.path, `${f.size}:${f.crc32}`);
          } catch {
            // A line cut short (the disk filled up mid-write): ignored, like the helper does.
          }
        }
        journal.size = new TextEncoder().encode(text).length;
        if (!text.endsWith("\n")) journal.pending.push("\n");
        return { earlier: journal.known.size };
      }
      await journalWrite(`${JSON.stringify(identity)}\n`, true);
      return { earlier: 0 };
    },

    journaled(entry) {
      return journal.known.get(entry.name) === `${entry.usize}:${entry.crc}`;
    },

    async exists(parts) {
      return (await namesIn(parts.slice(0, -1))).has(parts[parts.length - 1]);
    },

    finished(file) {
      if (!journal.on) return;
      journal.pending.push(`${JSON.stringify({ path: file.entry.name, size: file.entry.usize, crc32: file.entry.crc })}\n`);
      journal.timer ??= setTimeout(journalFlush, JOURNAL_MS);
    },

    /** Done: the journal goes. Stopped or failed: what it knows is written, for Resume. */
    async end(ok) {
      if (!ok) return journalFlush();
      clearTimeout(journal.timer);
      journal.pending = [];
      journal.on = false;
      await journal.writing;
      await root.removeEntry(JOURNAL_NAME).catch(() => {});
    },

    async mkdir(parts) {
      try {
        await dir(parts);
      } catch (e) {
        throw e instanceof Coded ? e : fsError(e, `the folder ${parts.join("/")}`);
      }
    },

    async create(parts) {
      const what = parts.join("/");
      let writable;
      try {
        const handle = await fileHandle(parts, true);
        writable = await handle.createWritable({ keepExistingData: false });
      } catch (e) {
        throw e instanceof Coded ? e : fsError(e, what);
      }
      let buf = new Uint8Array(BUFFER);
      let used = 0;
      const flush = async () => {
        if (!used) return;
        const out = buf.subarray(0, used);
        buf = new Uint8Array(BUFFER);
        used = 0;
        await writable.write(out);
      };
      return {
        async write(chunk) {
          try {
            if (chunk.length >= BUFFER) {
              await flush();
              await writable.write(chunk.slice());
              return;
            }
            if (used + chunk.length > BUFFER) await flush();
            buf.set(chunk, used);
            used += chunk.length;
          } catch (e) {
            throw fsError(e, what);
          }
        },
        async close() {
          try {
            await flush();
            await writable.close();
          } catch (e) {
            throw fsError(e, what);
          }
        },
        async abort() {
          await writable.abort().catch(() => {});
        },
      };
    },

    async stat(parts) {
      try {
        const handle = await fileHandle(parts, false);
        return (await handle.getFile()).size;
      } catch {
        return null;
      }
    },

    async *read(parts) {
      const handle = await fileHandle(parts, false);
      const reader = (await handle.getFile()).stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    },
  };
}
