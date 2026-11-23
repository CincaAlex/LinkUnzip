// Welcome page, opened when the extension is installed: what LinkUnzip does, a button that closes
// this tab so the person goes and tries it, and the settings worth a look first: site access and
// where extracted files go (Downloads unless they pick a folder). Both can be changed later in the popup.

import { getFolder, pickFolder, setFolder } from "./folder.js";
import { loadLanguage, t, translatePage } from "./i18n.js";
import { ALL_SITES, applyTheme, loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;

// In the language the popup uses (the browser's, unless Settings chose one).
await loadLanguage((await loadSettings()).language);
translatePage();
const menu = t("Extract with LinkUnzip");
$("try-text").textContent = t("Right-click any link to a .zip file and choose {menu}. Or click the LinkUnzip icon in the toolbar and paste a link.", { menu });
$("way-menu").textContent = t("On any page, then choose {menu}.", { menu });
$("helper-text").textContent = t("LinkUnzip doesn't need it. Once it is installed, {setting} lets it save straight into Downloads, which is faster for zips with thousands of files, and Open folder opens Explorer there. It also brings the linkunzip command line.", { setting: `${t("Settings")} > ${t("Extract with the Windows helper")}` });

// The hero rises in once, now that its words are in the right language. Past the 700ms mark it
// is already showing (welcome-enter.js) and stays still.
if (!root.classList.contains("m-enter-done")) root.classList.add("m-ready");

// Light or dark as chosen in the popup (theme.js already applied the last choice), live.
loadSettings().then((s) => applyTheme(s.theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    applyTheme(changes.settings.newValue?.theme);
    load();
  }
});

// Go try it: this tab has done its job. An extension page can always close its own tab.
$("go").addEventListener("click", async () => {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) return void (await chrome.tabs.remove(tab.id));
  } catch {
    // Not in a tab of its own: fall through.
  }
  window.close();
});

// Ask to pin the icon only when it isn't on the toolbar yet (Chrome 91+; else not at all).
async function pinHint() {
  try {
    const { isOnToolbar } = await chrome.action.getUserSettings();
    $("pin").hidden = isOnToolbar;
  } catch {
    $("pin").hidden = true;
  }
}
$("pin-close").addEventListener("click", () => ($("pin").hidden = true));
pinHint();
// Pinned from the puzzle menu while this page is open: the note goes.
const pinCheck = setInterval(() => ($("pin").hidden ? clearInterval(pinCheck) : pinHint()), 2000);

function refresh(allSites, folder) {
  $("row-sites").dataset.state = allSites ? "done" : "";
  $("sites-status").textContent = allSites ? t("Allowed on every site.") : "";
  $("allow-all").hidden = allSites;
  $("folder-status").textContent = folder ? t("Extracted files go into {folder}.", { folder: folder.name }) : t("Extracted files go into Downloads.");
  $("row-folder").dataset.state = "done";
  $("folder").textContent = folder ? t("Change...") : t("Choose a folder instead...");
  $("use-downloads").hidden = !folder;
}

async function load() {
  const [allSites, handle, settings] = await Promise.all([chrome.permissions.contains(ALL_SITES), getFolder("base"), loadSettings()]);
  refresh(allSites, settings.saveTo === "folder" ? handle : null);
}

async function saveTo(where) {
  const settings = await loadSettings();
  await chrome.storage.local.set({ settings: { ...settings, saveTo: where } });
  await chrome.runtime.sendMessage({ cmd: "folderChanged" });
}

$("allow-all").addEventListener("click", async () => {
  await chrome.permissions.request(ALL_SITES).catch(() => false);
  load();
});

$("folder").addEventListener("click", async () => {
  try {
    const handle = await pickFolder();
    if (!handle) return;
    await setFolder("base", handle);
    await saveTo("folder");
  } catch (e) {
    $("folder-status").textContent = t("{browser} didn't allow that folder: {error}", { error: e.message });
    $("row-folder").dataset.state = "bad";
    return;
  }
  load();
});

$("use-downloads").addEventListener("click", async () => {
  await saveTo("downloads");
  load();
});

chrome.permissions.onAdded.addListener(load);
chrome.permissions.onRemoved.addListener(load);
load();
