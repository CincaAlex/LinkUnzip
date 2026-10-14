// Setup page, opened when the extension is installed: site access, and where extracted files go
// (Downloads unless the user picks a folder). Both can be changed later in the popup too.

import { getFolder, pickFolder, setFolder } from "./folder.js";
import { ALL_SITES, applyTheme, loadSettings } from "./settings.js";

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
  $("sites-status").textContent = allSites ? "Allowed on every site." : "";
  $("allow-all").hidden = allSites;
  $("folder-status").textContent = folder ? `Extracted files go into ${folder.name}.` : "Extracted files go into Downloads.";
  $("folder").textContent = folder ? "Change..." : "Choose a folder instead...";
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
    $("folder-status").textContent = `Chrome didn't allow that folder: ${e.message}`;
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
