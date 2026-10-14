# LinkUnzip privacy policy

Effective 14 October 2026. Applies to the LinkUnzip browser extension (Chrome, Edge, Brave and other
Chromium browsers) and the optional LinkUnzip helper program for Windows (`linkunzip.exe`). Since
version 1.1.0 the extension works on its own; the helper is only used if you install it.

**In short:** LinkUnzip has no accounts, no analytics, no ads and no servers of its own. It does not
collect, sell or share any data about you. It connects only to the server of the link you chose,
and the files you extract stay on your PC.

## What happens when you extract a zip

1. You choose a link (right-click *Extract with LinkUnzip*, the toolbar popup, or a caught `.zip`
   download).
2. LinkUnzip, inside your browser, connects to the server in that link and downloads only the parts
   of the zip it needs: the index first, then the files you ticked. It can only read sites you
   allowed: Chrome asks the first time you use a link on a new site, unless you allowed every site
   at once. If the server redirects the download to another address (download mirrors and CDNs
   often do), the browser follows it, as for any download.
3. Each file is checked and saved on your PC: into your Downloads folder through Chrome's own
   downloads, or into a folder you chose. The zip itself is never saved.

The requests go out from your browser with its usual headers, so the server sees them like a
download from your browser, made by the LinkUnzip extension. Nothing goes to the LinkUnzip project
or anyone else.

**Preview** works the same way: only that one file is downloaded and shown in a LinkUnzip tab on
your PC. LinkUnzip keeps nothing from it after you close the tab.

**With the optional helper:** for servers that can only send a file from start to end (and in
extension versions before 1.1.0), the extension passes the link to the helper on your own PC
through the browser's native messaging, with the address of the page where you found it and your
browser's name and version (the same `Referer` and `User-Agent` your browser sends for a normal
download), so that servers which check them still work. The helper connects to that server,
follows redirects as a browser would, and writes the extracted files into a folder on your PC.

## Your browser login (cookies)

Some downloads only work when you are logged in to the site. For those, LinkUnzip can use your
login for that one site, **only if you allowed it**:

- LinkUnzip asks the first time a download needs your login on a site (for example *Use my login
  on example.com*) and remembers your answer for that site.
- In Settings you can instead allow *Use my login on every site*. It is off unless you turn it on.
- With that permission, your browser sends its own cookies for that site with LinkUnzip's requests
  to it, as it does when you click a download link. LinkUnzip itself does not read them. If the
  download is redirected to another site, the browser sends that site only its own cookies, if it
  has any, following its usual rules.
- With the optional helper only, the extension reads the cookies for the link's site at the moment
  you start and passes them to the helper on your PC. The helper sends them only to that site, and
  drops them if the download is redirected to a different site.
- Cookies are never stored by LinkUnzip, never written to disk by it, and never sent anywhere else.

Without that permission, LinkUnzip's requests carry no cookies at all.

## What is stored, and where

- **Settings** (where files go, number of connections, login options, *Catch .zip downloads*,
  light or dark theme): in the browser's extension storage on your PC.
- **The sites where you allowed your login**, and **a count of finished extractions** (for a
  one-time question asking for a store rating): in the same storage.
- **The folder you chose**, if any: the browser keeps a reference to it in the extension's storage,
  and Chrome decides when to ask you again for permission to write there.
- **The state of current jobs** (link, page address, folder, progress, file names, what you ticked)
  so the popup can show it: in the browser's session storage, cleared when the browser closes.
- **Extracted files**: in your Downloads folder or the folder you chose. They are yours; LinkUnzip
  never uploads them. While a file is being handed to Chrome's downloads, the browser holds it
  briefly (in memory, or in its own temporary storage for large files) until it is saved.
- **Chrome's download list**: LinkUnzip removes its own entries as soon as each file is saved.
  Files Chrome holds back (such as `.dll` files) stay in the list until you keep or remove them.
- **Resume information**: in a folder you chose, Resume checks the files that are already there.
  For Downloads, LinkUnzip remembers in memory which files it saved, until its background page
  closes. The helper, for its own jobs, keeps a small progress file (`.linkunzip-resume.jsonl`) in
  the destination folder while a job is unfinished, and deletes it when the job finishes.
- LinkUnzip and the helper keep no logs and no history.

## Other things the extension can see

- **ZIP links on the current page**: when you open the toolbar popup, the extension looks at the
  page you are on for links ending in `.zip` and lists them in the popup. Nothing is kept or
  sent.
- **Downloads**: LinkUnzip saves extracted files through Chrome's downloads. While it does, it hides
  Chrome's download bubble (so it doesn't pop up once per file) and shows it again when the job
  ends. If you turn on *Catch .zip downloads* (off by default), the extension notices when the
  browser starts downloading a `.zip`, cancels that download and offers it to LinkUnzip instead.
  Your other downloads are ignored.
- **Copy details**: after an error, this button copies the versions, your operating system and
  browser version, which engine was used (the browser or the helper), the error code, HTTP status,
  the host name and the technical error text to your clipboard. Web addresses are cut down to their
  host name, so the full link is never included; for a disk error, the text can name the file or
  folder on your PC that failed. It is sent nowhere; you decide whether to paste it into a bug
  report.

## The data the store listings name

The Chrome Web Store and Edge Add-ons ask every extension which kinds of user data it handles,
even when the data never leaves the user's PC. By their definitions LinkUnzip handles three kinds,
all of them only on your PC:

- **Authentication information:** a site's cookies, only after you allowed that site (see *Your
  browser login* above). Your browser sends them only to that site; with the optional helper, the
  extension passes them to the helper, which sends them only to that site.
- **Web history:** the link you chose and the address of the page it was on, kept in the job state
  on your PC. The page address is only passed on to the helper, if you use it.
- **Website content:** the `.zip` links on the page you are on, read when you open the toolbar
  popup so it can list them, and the files of the zip you extract or preview, which are saved or
  shown only on your PC.

Where any of it is kept is listed under *What is stored, and where* above. None of it reaches the
LinkUnzip project or anyone else.

## Connections LinkUnzip makes

- The extension connects to the servers of the links you choose (and the addresses they redirect
  to), and only on sites you allowed. Nothing else.
- The optional helper, if you installed it, connects to those same servers for the jobs it does.
- The setup page links to the helper's installer on the project's GitHub releases page
  (<https://github.com/CincaAlex/LinkUnzip/releases>). If you download it, that happens under
  GitHub's own privacy policy.
- No analytics, crash reporting, update checks or remote code. Updates to the extension come
  through the browser's extension store.

## Sharing and selling

LinkUnzip does not sell, rent, share or transfer any data, does not use data for advertising or
credit decisions, and has no servers that could receive it.

## Removing everything

1. Remove the extension: `chrome://extensions` (or `edge://extensions`), LinkUnzip, **Remove**.
   This deletes its settings, its job state, the folders you chose, the sites where you allowed
   your login and the site permissions you granted. (To withdraw access to one site only, remove
   it under *Site access* on the extension's **Details** page: without access, LinkUnzip can't
   contact that site at all. To stop using your login everywhere, turn off *Use my login on every
   site* in Settings.)
2. If you installed the helper: Windows *Settings > Apps > Installed apps*, **LinkUnzip**,
   **Uninstall**. This deletes the program and its browser registrations. If you installed it from
   the command line with `linkunzip host install`, run `linkunzip host uninstall` instead.
3. Extracted files stay where you put them until you delete them.

## Changes

If this policy changes, the new version is published here with a new date, and the change is
visible in the project's public history. A change that would collect or share data in a new way
would be announced in the release notes first.

## Contact

Questions about this policy: open an issue at <https://github.com/CincaAlex/LinkUnzip/issues>.
Security problems: report them privately at
<https://github.com/CincaAlex/LinkUnzip/security/advisories/new>.
