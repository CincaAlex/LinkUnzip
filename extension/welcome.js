// Setup page, opened when the extension is installed: site access, and where extracted files go
// (Downloads unless the user picks a folder). Both can be changed later in the popup too.

import { getFolder, pickFolder, setFolder } from "./folder.js";
import { loadLanguage, t, translatePage } from "./i18n.js";
import { ALL_SITES, applyTheme, loadSettings } from "./settings.js";

// In the language the popup uses (the browser's, unless Settings chose one).
await loadLanguage((await loadSettings()).language);
translatePage();
document.getElementById("try-text").textContent = t("Right-click any link to a .zip file and choose {menu}. Or click the LinkUnzip icon in the toolbar and paste a link.", { menu: t("Extract with LinkUnzip") });
document.getElementById("helper-text").textContent = `${t("LinkUnzip doesn't need it. Once it is installed, {setting} lets it save straight into Downloads, which is faster for zips with thousands of files, and Open folder opens Explorer there. It also brings the linkunzip command line.", { setting: `${t("Settings")} > ${t("Extract with the Windows helper")}` })} `;

// Light or dark as chosen in the popup (theme.js already applied the last choice), live.
loadSettings().then((s) => applyTheme(s.theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    applyTheme(changes.settings.newValue?.theme);
    load();
  }
});

const $ = (id) => document.getElementById(id);
const sites = $("step-sites");
const tryIt = $("step-try");

function refresh(allSites, folder) {
  sites.dataset.state = allSites ? "done" : "next";
  $("sites-status").textContent = allSites ? t("Allowed on every site.") : "";
  $("allow-all").hidden = allSites;
  $("folder-status").textContent = folder ? t("Extracted files go into {folder}.", { folder: folder.name }) : t("Extracted files go into Downloads.");
  $("folder").textContent = folder ? t("Change...") : t("Choose a folder instead...");
  $("use-downloads").hidden = !folder;
  tryIt.dataset.state = allSites ? "next" : "todo";
}

async function load() {
  const [allSites, handle, settings] = await Promise.all([chrome.permissions.contains(ALL_SITES), getFolder("base"), loadSettings()]);
  refresh(allSites, settings.saveTo === "folder" ? handle : null);
}

async function saveTo(where) {
  const settings = await loadSettings();
  await chrome.storage.local.set({ settings: { ...settings, saveTo: where } });
  await chrome.runtime.sendMessage({ cmd: "baseFolderChanged" });
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
    $("folder-status").textContent = t("Chrome didn't allow that folder: {error}", { error: e.message });
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
