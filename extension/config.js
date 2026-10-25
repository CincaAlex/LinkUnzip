// Where people download the Windows helper (dist/linkunzip-setup.exe, built by tools/package.py).
// Empty until it is published somewhere; the welcome page then says so instead of linking.
export const DOWNLOAD_URL = "https://github.com/CincaAlex/LinkUnzip/releases/latest/download/linkunzip-setup.exe";

// The helper this extension is built for: `hello.protocol` (helpers that don't send one speak
// protocol 1) and `hello.version`. An older helper keeps working with fewer features (no Browse...,
// no file list, no Resume); the popup and the setup page offer the update.
export const MIN_HELPER_PROTOCOL = 2;
export const MIN_HELPER_VERSION = "0.2.0";

function olderVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

// The store's reviews page, offered once on the Done screen after RATE_AFTER extractions in
// which every file was verified. The count stays on this PC, in chrome.storage.local.
export const REVIEW_URL = "https://chromewebstore.google.com/detail/dapeiljhjlaelolngnoagobeojcpkica/reviews";
export const RATE_AFTER = 3;

// Chrome opens this page when LinkUnzip is removed, with `?v=<version>` and nothing else. It asks
// why, and only what the person sends from it reaches the project (docs/privacy.md).
export const UNINSTALL_URL = "https://linkunzip.app/uninstalled";

/**
 * Counts one finished extraction. `rate` is what chrome.storage.local holds ({ good, asked }, or
 * nothing yet); returns what to store next and whether this job's Done screen asks.
 */
export function rateCheck(rate, result) {
  const good = rate?.good || 0;
  const asked = Boolean(rate?.asked);
  // verified_files also counts files a resumed run found already in place, so it can be larger.
  const verified = result?.files > 0 && result.verified_files >= result.files;
  if (!verified) return { rate: { good, asked }, ask: false };
  const ask = !asked && good + 1 >= RATE_AFTER;
  return { rate: { good: good + 1, asked: asked || ask }, ask };
}

/** Whether this helper (`hello` reply) is older than the extension wants. */
export function helperNeedsUpdate(info) {
  if (!info) return false;
  return (info.protocol ?? 1) < MIN_HELPER_PROTOCOL || olderVersion(info.version, MIN_HELPER_VERSION);
}
