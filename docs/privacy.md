# LinkUnzip privacy policy

Effective 5 October 2026. Applies to the LinkUnzip browser extension (Chrome, Edge, Brave and other
Chromium browsers) and the LinkUnzip helper program for Windows (`linkunzip.exe`), version 1.0 and
later.

**In short:** LinkUnzip has no accounts, no analytics, no ads and no servers of its own. It does not
collect, sell or share any data about you. It connects only to the server of the link you chose,
and the files you extract stay on your disk.

## What happens when you extract a zip

1. You choose a link (right-click *Extract with LinkUnzip*, the toolbar popup, or a caught `.zip`
   download).
2. The extension passes that link to the LinkUnzip helper on your own PC through the browser's
   native messaging. Nothing goes to the LinkUnzip project or anyone else.
3. The helper connects to the server in that link and downloads only the parts of the zip it
   needs. If that server redirects the download to another address (download mirrors and CDNs
   often do), the helper follows it, as a browser would.
4. The helper writes the extracted files into the folder you chose. The zip itself is never saved.

Along with the link, the extension may pass the address of the page where you found it and your
browser's name and version (the same `Referer` and `User-Agent` your browser sends for a normal
download), so that servers which check them still work.

## Your browser login (cookies)

Some downloads only work when you are logged in to the site. For those, LinkUnzip can use your
browser's cookies for that one site, **only if you allowed it**:

- LinkUnzip asks the first time a download needs your login on a site (for example *Use my login
  on example.com*). The browser shows its own permission prompt and remembers your answer for
  that site.
- In Settings you can instead allow *Use my login on every site*. It is off unless you turn it on.
- With that permission, the extension reads the cookies for the link's site only, at the moment you
  start, and passes them to the helper on your PC. The helper sends them only to that site, and
  drops them if the download is redirected to a different site.
- Cookies are never stored by LinkUnzip, never written to disk by it, and never sent anywhere else.

Public links need no permission at all: without it, no cookies are read.

## What is stored, and where

- **Settings** (base folder, number of connections, login options, *Catch .zip downloads*): in the
  browser's extension storage on your PC.
- **The state of current jobs** (link, folder, progress, file names) so the popup can show it: in
  the browser's session storage, cleared when the browser closes.
- **Extracted files**: in the folder you chose. They are yours; LinkUnzip never uploads them.
- **Resume information**: while a job is unfinished, the helper keeps a small progress file
  (`.linkunzip-resume.jsonl`) in the destination folder so it can skip finished files next time.
  It is deleted when the job finishes.
- The helper keeps no logs and no history.

## Other things the extension can see

- **ZIP links on the current page**: when you open the toolbar popup, the extension looks at the
  page you are on for links ending in `.zip` and lists them in the popup. Nothing is kept or
  sent.
- **Downloads**: if you turn on *Catch .zip downloads* (off by default), the extension notices when
  the browser starts downloading a `.zip`, cancels that download and offers it to LinkUnzip
  instead. It does not look at other downloads.
- **Copy details**: after an error, this button copies the versions, Windows version, error code,
  HTTP status, the host name and the technical error text to your clipboard. Web addresses are cut
  down to their host name, so the full link is never included; for a disk error, the text can name
  the file or folder on your PC that failed. It is sent nowhere; you decide whether to paste it
  into a bug report.

## The data the store listings name

The Chrome Web Store and Edge Add-ons ask every extension which kinds of user data it handles,
even when the data never leaves the user's PC. By their definitions LinkUnzip handles three kinds,
all of them only on your PC:

- **Authentication information:** a site's cookies, only after you allowed that site (see *Your
  browser login* above). The extension passes them to the helper, which sends them only to that
  site.
- **Web history:** the link you chose and the address of the page it was on, passed to the helper
  so it can download the zip.
- **Website content:** the `.zip` links on the page you are on, read when you open the toolbar
  popup so it can list them.

Where any of it is kept is listed under *What is stored, and where* above. None of it reaches the
LinkUnzip project or anyone else.

## Connections LinkUnzip makes

- The helper connects to the servers of the links you choose (and the addresses they redirect
  to). Nothing else.
- When you click **Download** on the extension's setup page, your browser downloads the helper's
  installer from the project's GitHub releases page
  (<https://github.com/CincaAlex/LinkUnzip/releases>), under GitHub's own privacy policy.
- No analytics, crash reporting, update checks or remote code. Updates to the extension come
  through the browser's extension store.

## Sharing and selling

LinkUnzip does not sell, rent, share or transfer any data, does not use data for advertising or
credit decisions, and has no servers that could receive it.

## Removing everything

1. Remove the extension: `chrome://extensions` (or `edge://extensions`), LinkUnzip, **Remove**.
   This deletes its settings, its job state and the site permissions you granted. (To withdraw
   only the login permissions, turn off *Use my login on every site* in Settings, or remove sites
   under the extension's **Details** page.)
2. Remove the helper: Windows *Settings > Apps > Installed apps*, **LinkUnzip**, **Uninstall**.
   This deletes the program and its browser registrations. If you installed it from the command
   line with `linkunzip host install`, run `linkunzip host uninstall` instead.
3. Extracted files stay where you put them until you delete them.

## Changes

If this policy changes, the new version is published here with a new date, and the change is
visible in the project's public history. A change that would collect or share data in a new way
would be announced in the release notes first.

## Contact

Questions about this policy: open an issue at <https://github.com/CincaAlex/LinkUnzip/issues>.
Security problems: report them privately at
<https://github.com/CincaAlex/LinkUnzip/security/advisories/new>.
