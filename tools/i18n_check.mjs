// Checks the extension's translations (extension/i18n/<lang>.json, see extension/i18n.js): every
// English sentence the code and pages use is in every language, with the same {placeholders},
// and nothing is left over. Counted sentences ("one|other") need the language's plural forms.
//
//   node tools/i18n_check.mjs           report, exit code 1 if anything is missing or wrong
//   node tools/i18n_check.mjs --keys    print every sentence as JSON (the list to translate)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, "..", "extension");
const LANGS = ["de", "es", "fr", "it", "ja", "pt_BR", "ro"];
// The plural forms each language needs (Intl.PluralRules categories for counts people see).
const FORMS = { de: ["one", "other"], es: ["one", "many", "other"], fr: ["one", "many", "other"], it: ["one", "many", "other"], ja: ["other"], pt_BR: ["one", "many", "other"], ro: ["one", "few", "other"] };

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const unquote = (s) => JSON.parse(s);

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (!["vendor", "i18n", "_locales", "icons"].includes(d.name)) walk(p);
      } else if (/\.(js|html)$/.test(d.name)) out.push(p);
    }
  };
  walk(EXT);
  return out;
}

export function collect() {
  const single = new Set();
  const plural = new Set();
  for (const file of sources()) {
    const text = fs.readFileSync(file, "utf8");
    if (file.endsWith(".js")) {
      for (const m of text.matchAll(new RegExp(String.raw`\btn\(\s*(${STR})\s*,\s*(${STR})`, "g"))) plural.add(`${unquote(m[1])}|${unquote(m[2])}`);
      for (const m of text.matchAll(new RegExp(String.raw`(?<![\w.])t\(\s*(${STR})`, "g"))) single.add(unquote(m[1]));
      // route.js: the reasons the popup passes to t().
      if (file.endsWith("route.js")) for (const m of text.matchAll(new RegExp(String.raw`why: (${STR})`, "g"))) single.add(unquote(m[1]));
    } else {
      for (const m of text.matchAll(/<(\w+)\b([^>]*\sdata-i18n(?=[\s>])[^>]*)>([^<]*)<\/\1>/g)) single.add(m[3].trim().replace(/\s+/g, " ").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
      for (const attr of ["title", "aria-label", "placeholder"]) {
        for (const m of text.matchAll(new RegExp(`<[^>]*\\sdata-i18n-${attr}\\b[^>]*>`, "g"))) {
          const v = new RegExp(`\\s${attr}="([^"]*)"`).exec(m[0]);
          if (v) single.add(v[1]);
        }
      }
    }
  }
  single.delete("");
  return { single: [...single].sort(), plural: [...plural].sort() };
}

const holes = (s) => [...new Set(String(s).match(/\{\w+\}/g) || [])].sort().join(" ");

function check() {
  const { single, plural } = collect();
  let problems = 0;
  const say = (msg) => {
    problems += 1;
    console.log(msg);
  };
  for (const lang of LANGS) {
    const file = path.join(EXT, "i18n", `${lang}.json`);
    if (!fs.existsSync(file)) {
      say(`${lang}: no ${path.relative(process.cwd(), file)}`);
      continue;
    }
    const cat = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const key of single) {
      const v = cat[key];
      if (typeof v !== "string" || !v.trim()) say(`${lang}: missing ${JSON.stringify(key)}`);
      else if (holes(v) !== holes(key)) say(`${lang}: placeholders differ in ${JSON.stringify(key)}: ${holes(v)} vs ${holes(key)}`);
    }
    for (const key of plural) {
      const v = cat[key];
      if (!v || typeof v !== "object") {
        say(`${lang}: missing plural ${JSON.stringify(key)}`);
        continue;
      }
      const want = holes(key.split("|")[1]);
      for (const form of FORMS[lang]) {
        if (typeof v[form] !== "string" || !v[form].trim()) say(`${lang}: plural ${JSON.stringify(key)} has no "${form}"`);
        // A language may say "one" without the number ("the only row").
        else if (holes(v[form]) !== want && !(form === "one" && holes(v[form]) === want.replace("{count}", "").trim().replace(/\s+/g, " "))) say(`${lang}: placeholders differ in ${JSON.stringify(key)} (${form}): ${holes(v[form])} vs ${want}`);
      }
    }
    const known = new Set([...single, ...plural]);
    for (const key of Object.keys(cat)) if (!known.has(key)) say(`${lang}: not used any more: ${JSON.stringify(key)}`);
  }
  console.log(problems ? `\n${problems} problem(s); ${single.length} sentences and ${plural.length} counted ones` : `all ${LANGS.length} languages complete: ${single.length} sentences and ${plural.length} counted ones`);
  process.exitCode = problems ? 1 : 0;
}

if (process.argv.includes("--keys")) console.log(JSON.stringify(collect(), null, 1));
else check();
