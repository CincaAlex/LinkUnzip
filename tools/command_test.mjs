// Tests for extension/command.js: the Python script it writes is run for real against a local
// Range server (tools/range_server.py), and what it extracts is compared byte for byte with what
// went into the zip.
//
//   node tools/command_test.mjs
//
// Needs `python` (3.8+) on PATH, like tools/engine_test.mjs.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { explicitFiles, helperCommand, includePatterns, pythonCommand, remotezipCommand } from "../extension/command.js";
import { nearestMark } from "../extension/engine/plan.js";
import { bytesOf, makeZip } from "./test_zips.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const made = []; // temp folders, removed at the end
let failures = 0;

function check(ok, what, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${!ok && extra ? `\n      ${extra}` : ""}`);
  if (!ok) failures += 1;
}

/** A port nothing listens on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function waitForServer(base) {
  for (let i = 0; i < 150; i++) {
    try {
      await fetch(`${base}/`, { method: "HEAD" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("the Range server did not start");
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

const FILES = [
  { name: "data/", data: "", method: 0 },
  { name: "data/a.csv", data: bytesOf(1, 3000) },
  { name: "data/big.bin", data: bytesOf(2, 3_500_000) },
  { name: "data/sub/b.csv", data: bytesOf(3, 70_000), method: 0 },
  { name: "data/sub/c.txt", data: Buffer.from("hello\n".repeat(5000)) },
  { name: "data/sub/stored.bin", data: bytesOf(4, 2_200_000), method: 0 },
  { name: "docs/readme.md", data: Buffer.from("# Read me\n") },
  { name: "docs/caf\u00e9 [1].txt", data: Buffer.from("unicode name\n") },
  { name: "top.txt", data: Buffer.from("at the top\n"), descriptor: true },
];

/** Run the script for `marks` in a fresh folder; `{status, out, written, folder}`. */
function runScript(url, marks, name) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `lu-cmd-${name}-`));
  made.push(cwd);
  const { script, bash, powershell } = pythonCommand({ url, marks });
  const r = spawnSync("python", ["-I", "-"], { cwd, input: script, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, cwd, bash, powershell, script };
}

function sameAsZip(dir, files, marks) {
  const want = files.filter((f) => !f.name.endsWith("/") && nearestMark(new Map(Object.entries(marks)), f.name));
  const got = listFiles(dir);
  const bad = [];
  if (got.length !== want.length) bad.push(`wrote ${got.length} files, wanted ${want.length}: ${got.join(", ")}`);
  for (const f of want) {
    const p = path.join(dir, ...f.name.split("/"));
    if (!fs.existsSync(p)) bad.push(`missing ${f.name}`);
    else if (!fs.readFileSync(p).equals(Buffer.from(f.data))) bad.push(`differs: ${f.name}`);
  }
  return { ok: !bad.length, why: bad.join("; "), count: want.length };
}

async function main() {
  const python = spawnSync("python", ["--version"], { encoding: "utf8" });
  if (python.status !== 0) throw new Error("python is not on PATH");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lu-cmd-serve-"));
  made.push(root);
  fs.writeFileSync(path.join(root, "set 1.zip"), makeZip(FILES));
  fs.writeFileSync(path.join(root, "pack.zip"), makeZip([{ name: "pack/", data: "", method: 0 }, { name: "pack/one.txt", data: Buffer.from("one") }, { name: "pack/two/2.txt", data: Buffer.from("two") }]));
  fs.writeFileSync(path.join(root, "evil.zip"), makeZip([{ name: "../evil.txt", data: Buffer.from("x") }, { name: "ok.txt", data: Buffer.from("ok") }]));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn("python", [path.join(here, "range_server.py"), root, String(port)], { stdio: "ignore" });
  try {
    await waitForServer(base);
    const url = `${base}/set%201.zip`;
    const cases = {
      everything: {},
      "one folder": { "": false, "data/sub/": true },
      "a few files": { "": false, "data/a.csv": true, "docs/caf\u00e9 [1].txt": true, "top.txt": true },
      "nearest mark": { "data/": false, "data/sub/": true, "data/sub/c.txt": false, "docs/readme.md": false },
    };
    for (const [name, marks] of Object.entries(cases)) {
      const r = runScript(url, marks, name.replace(/ /g, "-"));
      const same = sameAsZip(path.join(r.cwd, "set 1"), FILES, marks);
      check(r.status === 0 && same.ok, `python script, ${name}: ${same.count} files byte for byte`, `${same.why}\n      ${r.out.slice(-600)}`);
      if (name === "everything") {
        check(/^[\x00-\x7f]*$/.test(r.script), "the script is plain ASCII (survives any shell or code page)");
        check(r.bash.startsWith("python3 - <<'EOF'\n") && r.bash.endsWith("\nEOF\n") && r.powershell.startsWith("@'\n") && r.powershell.includes("\n'@ | python -"), "bash and PowerShell wrappers");
      }
    }

    const packed = runScript(`${base}/pack.zip`, {}, "pack");
    const packFiles = listFiles(path.join(packed.cwd, "pack")).sort();
    check(packed.status === 0 && packFiles.join(",") === "one.txt,two/2.txt", `a zip holding its own folder goes straight into it (${packFiles.join(", ")})`, packed.out);

    const evil = runScript(`${base}/evil.zip`, {}, "evil");
    check(evil.status === 1 && !fs.existsSync(path.join(evil.cwd, "evil.txt")) && listFiles(path.join(evil.cwd, "evil")).join() === "ok.txt" && /unsafe/.test(evil.out), "a .. path is refused, the rest extracts, exit code 1", evil.out);
  } finally {
    server.kill();
    await new Promise((r) => (server.exitCode !== null ? r() : server.once("exit", r)));
    for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  }

  // The one-line commands.
  const u = "https://example.com/x/set%201.zip?sig=a'b";
  check(remotezipCommand({ url: u, paths: ["a b.txt", "c'.txt"] }) === "pip install remotezip\nremotezip 'https://example.com/x/set%201.zip?sig=a'\\''b' 'a b.txt' 'c'\\''.txt'\n", "remotezip: quoted for a POSIX shell");
  check(remotezipCommand({ url: u, marks: { "": false, "a/": true } }) === null && remotezipCommand({ url: u, paths: Array.from({ length: 51 }, (_, i) => `${i}`) }) === null, "remotezip: none for a folder or more than 50 files");
  check(JSON.stringify(explicitFiles({ "": false, "a.txt": true, "b.txt": false })) === '["a.txt"]' && explicitFiles({ "a.txt": true }) === null, "explicitFiles: only files picked one by one");
  check(JSON.stringify(includePatterns({})) === "[]" && JSON.stringify(includePatterns({ "": false, "a/": true, "a/b/": true, "x[1].txt": true })) === '["a/*","x[[]1].txt"]', "includePatterns: everything, folders and files, patterns escaped");
  check(includePatterns({ "a/": false }) === null && includePatterns({ "": false, "a/": true, "a/b.txt": false }) === null && includePatterns({ "": false }) === null, "includePatterns: none for an untick inside a tick, or nothing ticked");
  check(helperCommand({ url: "https://example.com/data.zip", marks: { "": false, "logs/": true } }) === 'linkunzip extract "https://example.com/data.zip" -o "data" --include "logs/*"', "helper: whole folders as --include");
  check(helperCommand({ url: "https://example.com/d.zip?a=$x", marks: {} }) === "linkunzip extract 'https://example.com/d.zip?a=$x' -o \"d\"", "helper: single quotes when PowerShell would expand $");
  check(helperCommand({ url: u, marks: { "a/": false } }) === null, "helper: none when patterns can't say it");
}

main().then(
  () => {
    console.log(failures ? `\n${failures} FAILED` : "\nall passed");
    process.exit(failures ? 1 : 0);
  },
  (e) => {
    console.log(`\nthe tests stopped: ${e?.stack || e}`);
    process.exit(1);
  },
);
