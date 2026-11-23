// The zips opened lately, for the popup's start screen: link, name, size and where the files
// went. Kept on this PC only (chrome.storage.local), at most MAX, newest first, and only while
// Settings > Remember recent zips is on. The background writes it; the popup reads and clears it.

const KEY = "recent";
const MAX = 20;

/** The list, newest first (empty when there is none or it was cleared). */
export async function recentZips() {
  const { [KEY]: list } = await chrome.storage.local.get(KEY);
  return Array.isArray(list) ? list : [];
}

/** Add or update one zip (by its link) and move it to the top. */
export async function rememberZip(entry) {
  const list = await recentZips();
  const before = list.find((z) => z.url === entry.url);
  const next = [{ ...before, ...entry, at: Date.now() }, ...list.filter((z) => z.url !== entry.url)];
  await chrome.storage.local.set({ [KEY]: next.slice(0, MAX) });
}

export const forgetRecentZips = () => chrome.storage.local.remove(KEY);
