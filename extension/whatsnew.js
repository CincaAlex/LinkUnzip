// What a version added, shown once in the popup after the extension updates to it, never after
// a fresh install (that gets the welcome page). On update, background.js stores what there is to
// show in chrome.storage.local under "whatsNew":
//
//   { version: "1.4.1", dots: ["paste", "sample", "share"], card: true, link: true }
//
// card: the card at the top of the popup; dots: the buttons marked as new (data-new in popup.js),
// each until it is first clicked; link: "What's new" in the popup's footer. The popup clears each
// part as it is clicked, and removes the key once nothing is left.
//
// Only a version with an entry here shows anything: an update to a version without one (a small
// fix, say) stores nothing.

import { t } from "./i18n.js";

export const CHANGELOG_URL = "https://linkunzip.app/changelog";

export const WHATS_NEW = {
  "1.4.1": {
    // A feature's name and what it does, as functions so they come out in the language the
    // popup is set to when it draws the card.
    lines: [
      () => [t("Recent zips"), t("open a zip you used before in one click")],
      () => [t("Sample"), t("tick random files without downloading")],
      () => [t("Share"), t("a link or command for the same files")],
    ],
    dots: ["paste", "sample", "share"],
  },
};

/** What to store after an update from `previous` to `current`; null when there is nothing to show. */
export function whatsNewState(previous, current) {
  const entry = WHATS_NEW[current];
  if (!entry || !previous || previous === current) return null;
  return { version: current, dots: [...entry.dots], card: true, link: true };
}

/** The stored state if it still belongs to a version with an entry, else null. */
export function validWhatsNew(saved) {
  return saved && WHATS_NEW[saved.version] ? saved : null;
}
