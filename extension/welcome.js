// Setup page, opened when the extension is installed (and from the popup when the helper is
// missing). It keeps asking the background worker for the native host until one answers.
// With ?update=1 (from the popup's "A newer LinkUnzip helper is available") it is about
// installing the new helper over the old one, and waits until the new one answers.

import { DOWNLOAD_URL, MIN_HELPER_PROTOCOL, helperNeedsUpdate } from "./config.js";
import { applyTheme, loadSettings } from "./settings.js";

// Light or dark as chosen in the popup (theme.js already applied the last choice), live.
loadSettings().then((s) => applyTheme(s.theme));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) applyTheme(changes.settings.newValue?.theme);
});

const helper = document.getElementById("step-helper");
const status = document.getElementById("helper-status");
const setup = document.getElementById("helper-setup");
const tryIt = document.getElementById("step-try");
const updateMode = new URLSearchParams(location.search).has("update");

if (updateMode) {
  document.title = "Update LinkUnzip";
  document.getElementById("helper-title").textContent = "Update the LinkUnzip helper";
  document.getElementById("helper-why").textContent =
    "The new helper installs over the old one, just for you (no administrator rights). Your settings and folders stay as they are, and the old helper keeps working until then.";
}

// The Download button fetches the installer with chrome.downloads, then turns into "Open the
// installer" so nobody has to look for the file.
const button = document.getElementById("download");
const LABEL = "Download linkunzip-setup.exe";
let source = DOWNLOAD_URL;
let downloadId = null;

async function setupDownload() {
  if (!source) {
    // Unpacked test copies carry the installer themselves (tools/package.py puts it there).
    const bundled = chrome.runtime.getURL("linkunzip-setup.exe");
    if (await fetch(bundled, { method: "HEAD" }).then((r) => r.ok, () => false)) source = bundled;
  }
  if (!source) {
    document.getElementById("no-download").hidden = false;
    return;
  }
  button.textContent = LABEL;
  button.hidden = false;
  button.addEventListener("click", onDownloadClick);
}

async function onDownloadClick() {
  if (downloadId !== null) {
    chrome.downloads.open(downloadId); // must run inside the click, before any await
    return;
  }
  button.disabled = true;
  button.textContent = "Downloading...";
  try {
    let url = source;
    if (url.startsWith("chrome-extension:")) {
      // The browser's downloader can't read extension files directly: hand it an in-memory copy.
      url = URL.createObjectURL(await (await fetch(url)).blob());
    }
    downloadId = await chrome.downloads.download({ url, filename: "linkunzip-setup.exe", conflictAction: "overwrite" });
  } catch {
    button.disabled = false;
    button.textContent = "Download failed, try again";
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (delta.id !== downloadId || !delta.state) return;
  button.disabled = false;
  if (delta.state.current === "complete") {
    button.textContent = "Open the installer";
  } else if (delta.state.current === "interrupted") {
    downloadId = null;
    button.textContent = "Download failed, try again";
  }
});

setupDownload();

/** Show what the ping found; true once there is nothing left to wait for. */
function show(r) {
  if (r?.ok && r.info) {
    const { version, protocol = 1 } = r.info;
    const old = helperNeedsUpdate(r.info);
    document.getElementById("helper-detail").hidden = true;
    if (updateMode && old) {
      helper.dataset.state = "next";
      status.textContent = `This PC has LinkUnzip ${version}, an older helper. Download the new one and install it over the old one.`;
      status.title = `helper protocol ${protocol}, this extension wants ${MIN_HELPER_PROTOCOL}`;
      setup.hidden = false;
      tryIt.dataset.state = "todo";
      return false;
    }
    // An older helper still works: the step is done, the update is only offered.
    helper.dataset.state = "done";
    status.textContent = `${updateMode ? "Updated" : "Installed"}: LinkUnzip ${version}. You're all set.`;
    document.getElementById("helper-update").hidden = !old;
    setup.hidden = true;
    tryIt.dataset.state = "next";
    return !old;
  }
  helper.dataset.state = "next";
  setup.hidden = false;
  tryIt.dataset.state = "todo";
  const code = r?.error?.code;
  status.textContent =
    code === "host_forbidden"
      ? "The helper on this PC doesn't accept this copy of the extension. Install the helper again."
      : code === "host_missing" || !r
        ? "Not installed on this PC yet."
        : "Couldn't talk to the helper.";
  const detail = document.getElementById("helper-detail");
  detail.textContent = `Browser says: ${r?.error?.detail || r?.error?.message || "no answer from the extension"}`;
  detail.hidden = false;
  return false;
}

async function poll() {
  let r = null;
  try {
    r = await chrome.runtime.sendMessage({ cmd: "ping" });
  } catch {
    // The worker was restarting; try again on the next round.
  }
  // A helper that works but is old: keep looking, more slowly, for the update to land.
  if (!show(r)) setTimeout(poll, r?.ok ? 4000 : 2000);
}

poll();
