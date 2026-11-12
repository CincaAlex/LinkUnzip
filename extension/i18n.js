// The extension's own text in the person's language. The English sentence is the key: the code
// says t("Start Extraction"), and i18n/<lang>.json maps it to the translation. Anything missing
// stays in English. {name} in a sentence is filled in from `vars`.
//
// The language follows the browser's (chrome.i18n.getUILanguage), unless Settings > Language
// chose one. The store name and summary are Chrome's own _locales and follow the browser only.
//
// tools/i18n_check.mjs checks that every sentence the code uses is in every language, with the
// same {placeholders}.

export const LANGUAGES = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  pt_BR: "Português (Brasil)",
  ro: "Română",
};

let lang = "en";
let catalog = {};

/** "de", "pt_BR", ...: what the browser is set to, among the languages there are; else English. */
export function browserLanguage() {
  let ui = "en";
  try {
    ui = chrome.i18n.getUILanguage();
  } catch {
    // Outside the extension (tests): English.
  }
  const code = ui.replace("-", "_");
  if (LANGUAGES[code]) return code;
  const base = code.split("_")[0];
  if (base === "pt") return "pt_BR";
  return LANGUAGES[base] ? base : "en";
}

/** Load the language `choice` ("auto" or a code from LANGUAGES). */
export async function loadLanguage(choice = "auto") {
  const next = choice && choice !== "auto" && LANGUAGES[choice] ? choice : browserLanguage();
  let words = {};
  if (next !== "en") {
    try {
      const resp = await fetch(chrome.runtime.getURL(`i18n/${next}.json`));
      words = await resp.json();
    } catch {
      words = {};
    }
  }
  lang = next;
  catalog = words;
  if (typeof document !== "undefined") document.documentElement.lang = locale();
  return lang;
}

/** The current language: "en", "de", "pt_BR", ... */
export const currentLanguage = () => lang;

/** The current language as a BCP 47 tag for Intl: "en", "pt-BR". */
export const locale = () => lang.replace("_", "-");

const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? String(vars[name]) : all));

/** `text` in the current language, with {placeholders} filled in from `vars`. */
export function t(text, vars = {}) {
  const found = catalog[text];
  return fill(typeof found === "string" && found ? found : text, vars);
}

/**
 * A sentence with a count: tn("{count} file", "{count} files", n). The catalog keeps each
 * language's own plural forms ("one", "few", "many", "other") under "one|other". {count} is the
 * number written the language's way.
 */
export function tn(one, other, count, vars = {}) {
  const forms = catalog[`${one}|${other}`];
  let text;
  if (forms && typeof forms === "object") {
    const kind = new Intl.PluralRules(locale()).select(count);
    text = forms[kind] || forms.other || (count === 1 ? one : other);
  } else {
    text = count === 1 ? one : other;
  }
  return fill(text, { count: num(count), ...vars });
}

/** A number written the language's way: 5,518 / 5.518 / 5 518. */
export const num = (n, digits = 0) =>
  Number(n).toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** "a, b and c" with the language's own "and". */
export function list(words) {
  try {
    return new Intl.ListFormat(locale(), { style: "long", type: "conjunction" }).format(words);
  } catch {
    return words.join(", ");
  }
}

/**
 * Translate a page's fixed text: elements with data-i18n get their text, and data-i18n-title,
 * data-i18n-aria-label and data-i18n-placeholder their attributes. The English stays in the HTML.
 */
export function translatePage(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.dataset.i18nText ??= el.textContent.trim().replace(/\s+/g, " ");
    el.textContent = t(el.dataset.i18nText);
  }
  for (const [attr, key] of [["title", "i18nEnTitle"], ["aria-label", "i18nEnAriaLabel"], ["placeholder", "i18nEnPlaceholder"]]) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) {
      el.dataset[key] ??= el.getAttribute(attr) || "";
      el.setAttribute(attr, t(el.dataset[key]));
    }
  }
}
