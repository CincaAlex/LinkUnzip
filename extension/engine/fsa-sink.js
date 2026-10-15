// Writing into a folder the user picked (File System Access). Chrome writes each file to a
// temporary `<name>.crswap` next to it and only gives it its name on close(); abort() throws it
// away. That is the same guarantee as the helper's `.part` files: a file that did not check out
// never appears under its real name.

import { Coded } from "./errors.js";

const BUFFER = 1 << 20; // fewer, bigger writes: each one is a round trip to the browser

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

  return {
    label,
    renames,

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
