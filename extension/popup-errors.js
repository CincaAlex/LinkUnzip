// What each error looks like in the popup: a title, a sentence or two, and the buttons to offer.
// Kept apart from popup.js: it is a table of messages, and it only needs the job and Settings.

import { isEdge } from "./config.js";
import { files, hostOf, sitePattern } from "./fmt.js";
import { t } from "./i18n.js";

// What using a login means, said before it is used (store policy: disclose first).
export const loginUse = (host) =>
  t("your browser sends its cookies for {host} with LinkUnzip's requests to {host}, and only there. Nothing goes to LinkUnzip itself.", { host });

export const accessRefused = () => t("No problem. Without access to this site LinkUnzip can't read the zip, but you can still download it normally.");

/**
 * What each error code looks like: a title, a sentence or two, and what to offer (the first
 * action is the main button). Codes this version does not know get the helper's own message.
 */
export function describeError(job, e, settings) {
  const host = hostOf(job.url);
  const status = e.http_status ? ` (HTTP ${e.http_status})` : "";
  // A login only helps if none was sent; the user can turn the offer off in Settings.
  const offerLogin = !job.loginSent && settings.loginWhenNeeded && Boolean(sitePattern(job.url));
  switch (e.code) {
    case "site_access":
      return {
        title: t("Allow LinkUnzip to read {host}", { host }),
        text: t("To read the zip without downloading all of it, LinkUnzip needs {browser}'s permission to fetch files from {host}. It only connects there when you give it a link.", { host }),
        more: t("Tip: Settings > Read zip links on every site saves you this step for every new site."),
        actions: ["access", "download"],
      };
    case "ask_where":
      return {
        title: t("{browser} asks where to save each download"),
        text: t("{browser} is set to ask where to save every file, so it would ask once for each file in this zip."),
        // Edge names the setting differently, so it is described there instead of quoted.
        more: isEdge()
          ? t("In Edge's download settings, turn off the option that asks what to do with each download, then try again, or choose a folder for LinkUnzip instead.")
          : t("Turn off \"Ask where to save each file before downloading\" in Chrome's download settings and try again, or choose a folder for LinkUnzip instead."),
        folder: true,
        actions: ["chromeSettings", "extractHere"],
      };
    case "folder_permission":
      return { title: t("LinkUnzip needs to write into the folder again"), text: t("{browser} needs your OK again to let LinkUnzip write into this folder."), more: t("{browser} asks again after the browser restarts. Click Extract here and choose Allow."), folder: true, actions: ["extractHere"] };
    case "no_folder":
      return { title: t("Choose a folder"), text: t("Pick the folder LinkUnzip should extract into."), folder: true, actions: ["extractHere"] };
    case "too_big":
      return { title: t("This zip's index is too big for the browser"), text: e.message, actions: ["download"] };
    case "host_missing":
    case "host_forbidden":
      return { title: t("This needs the LinkUnzip helper for Windows"), text: e.message, actions: ["setup", "download"] };
    case "host":
    case "host_silent":
      return { title: t("LinkUnzip stopped"), text: e.message, actions: ["retry", "download"] };
    case "no_range":
      return {
        title: t("This server sends the zip only from the start"),
        text: t("It can't send parts of the file (like GitHub's Download ZIP, which builds the zip while it sends it), so there is no file list first. LinkUnzip can still extract all of it in one pass."),
        more: t("One connection, no size before it starts, and the zip is still never saved. Every file is checked as it arrives."),
        folder: true,
        actions: ["stream", "download"],
      };
    case "inner_compressed":
      return {
        title: t("This zip inside the zip can only be read in one pass"),
        text: t("It is compressed inside the outer zip, so LinkUnzip can't read just its index first."),
        more: t("One pass reads it from its first byte to its last, through the outer zip. Every file is checked as it arrives."),
        folder: true,
        actions: ["stream"],
      };
    case "password_needed":
      return { title: t("This zip is password-protected"), text: t("Type its password to extract the protected files."), password: true, folder: true, actions: ["withPassword"] };
    case "password_wrong":
      return { title: t("That password doesn't fit"), text: t("LinkUnzip checked it on the first protected file before writing anything. Try again."), password: true, folder: true, actions: ["withPassword"] };
    case "html_page":
      return {
        title: t("This link opens a web page, not the file"),
        text: t("The link answered with a web page instead of the zip. Sites like Google Drive or Dropbox show a page first: open the link, then right-click the page's own download button and choose Extract with LinkUnzip."),
        more: offerLogin ? t("If that page asks you to sign in, LinkUnzip can use your login on {host}: {how}", { host, how: loginUse(host) }) : null,
        actions: offerLogin ? ["login", "open", "download"] : ["open", "download"],
      };
    case "needs_login":
      if (offerLogin) {
        return {
          title: t("This download needs your login on {host}", { host }),
          text: t("The site says you need to be signed in. LinkUnzip can use your login on {host}: {how} It starts again right away.", { host, how: loginUse(host) }),
          actions: ["login", "download"],
        };
      }
      return {
        title: t("This download needs your login on {host}", { host }),
        text: job.loginSent
          ? t("LinkUnzip sent your login, but the site still says no. Open the link, sign in on the page, then try again.")
          : t("The site says you need to be signed in. Turn on 'Use my login when a site needs it' in Settings, or download the file normally."),
        actions: job.loginSent ? ["open", "retry", "download"] : ["download"],
      };
    case "link_expired":
      return {
        title: t("This link has expired"),
        text: t("Links like this one only work for a while{status}. Go back to the page, get a fresh link and right-click it again.", { status }),
        actions: job.pageUrl ? ["page"] : [],
      };
    case "not_found":
      return {
        title: t("The file is gone from the server"),
        text: t("{host} says there is nothing at this link{status}. It may be old, moved, or mistyped.", { host, status }),
        actions: ["open"],
      };
    case "not_zip":
      return {
        title: t("This file isn't a ZIP"),
        text: t("LinkUnzip only reads .zip archives, and this link gives something else. You can still download it normally."),
        actions: ["download"],
      };
    case "server_error":
      return {
        title: t("{host} had a problem", { host }),
        text: t("The server kept answering with an error{status}. This is usually temporary: try again in a minute.", { status }),
        actions: ["retry", "download"],
      };
    case "redirect_access":
      if (job.allSites !== true) {
        return {
          title: t("{host} sends the download on to another site", { host }),
          text: t("The link redirects to another server, as many download links do, and LinkUnzip may only read the sites you allowed. Allow every site so it can follow the link."),
          more: t("LinkUnzip still only connects to the sites your links lead to."),
          actions: ["accessAll", "download"],
        };
      }
    // falls through: with every site allowed, it really was the connection
    case "network":
      if (job.allSites === false) {
        return {
          title: t("Can't read from {host}", { host }),
          text: t("Check your internet connection (or VPN or proxy), then try again."),
          more: t("If the link sends the download on to another site (many download links do), LinkUnzip needs permission to read there too. Allowing every site covers that."),
          actions: ["accessAll", "retry"],
        };
      }
      return {
        title: t("Can't reach {host}", { host }),
        text: t("Check your internet connection (or VPN or proxy), then try again."),
        actions: ["retry"],
      };
    case "disk_full":
      return {
        title: t("Not enough free space"),
        text: t("The drive is full."),
        more: t("Choose a folder on a drive with more room."),
        folder: true,
        actions: ["extractHere"],
      };
    case "folder_not_writable":
      if (job.target?.key === "downloads") {
        return {
          title: t("Couldn't save into Downloads"),
          text: e.message,
          more: t("Try again, or choose a folder for LinkUnzip instead."),
          folder: true,
          actions: ["extractHere"],
        };
      }
      return {
        title: t("Can't write to this folder"),
        text: t("Your computer didn't let LinkUnzip create files there (no permission, or the path is too long). Choose another folder."),
        more: e.message,
        folder: true,
        actions: ["extractHere"],
      };
    case "unsupported_entries":
      return { title: t("LinkUnzip can't read these files"), text: e.message, actions: ["download"] };
    case "internal":
      return {
        title: t("LinkUnzip hit a bug"),
        text: t("Nothing more was written. Report it so it can be fixed: LinkUnzip copies the details and opens a new issue on GitHub, where you paste them."),
        actions: ["report", "retry"],
      };
    default:
      return { title: t("Couldn't extract this"), text: e.message || t("Something went wrong."), actions: ["download"] };
  }
}
