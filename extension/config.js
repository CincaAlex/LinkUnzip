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

/** Whether this helper (`hello` reply) is older than the extension wants. */
export function helperNeedsUpdate(info) {
  if (!info) return false;
  return (info.protocol ?? 1) < MIN_HELPER_PROTOCOL || olderVersion(info.version, MIN_HELPER_VERSION);
}
