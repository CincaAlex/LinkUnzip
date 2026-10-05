// Settings shared by the background worker and the popup: the defaults, and bringing settings
// saved by an older version up to date.

export const DEFAULT_SETTINGS = {
  baseFolder: "", // empty = <Downloads>\LinkUnzip
  connections: 4,
  loginWhenNeeded: true, // offer "Use my login on <host>" when a download needs the user's login
  catchDownloads: false, // intercept .zip downloads and offer to extract instead
  theme: "system", // "system" follows Windows; "light" or "dark" is the user's choice
};

// theme.js reads this before the page paints: chrome.storage cannot be read that early.
const THEME_KEY = "linkunzip-theme";

/** Show a page in `theme` ("system", "light" or "dark") and remember it for theme.js. */
export function applyTheme(theme) {
  const chosen = theme === "light" || theme === "dark" ? theme : null;
  if (chosen) document.documentElement.dataset.theme = chosen;
  else delete document.documentElement.dataset.theme;
  try {
    if (chosen) localStorage.setItem(THEME_KEY, chosen);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    // No storage: the page still switches now, it just can't skip the first-paint flash.
  }
}

/** The theme actually on screen: the choice, or what Windows is set to. */
export function effectiveTheme(theme) {
  if (theme === "light" || theme === "dark") return theme;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// "Use my login on every site" is not stored here: it is Chrome's own grant of this permission.
export const ALL_SITES = { origins: ["<all_urls>"] };

export function migrate(saved = {}) {
  const s = { ...saved };
  // 0.2.0 had one "Use my browser login" switch, backed by permission for every site.
  if ("useLogin" in s) {
    if (!("loginWhenNeeded" in s)) s.loginWhenNeeded = s.useLogin !== false;
    delete s.useLogin;
  }
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  return migrate(settings);
}
