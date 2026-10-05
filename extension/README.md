# LinkUnzip for Chrome

Right-click a link to a `.zip`, then **Extract with LinkUnzip**. The extension hands the link to the
`linkunzip` program on your PC, which reads the zip's index, shows what it would cost, and then
streams every file into a folder. The zip itself is never saved.

```
 Chrome --(native messaging, JSON)--> linkunzip.exe --(HTTP Range, or one pass)--> the server
   popup, right-click menu               extracts into a folder, reports progress
```

## Install (Windows; Chrome, Edge or Brave)

1. **The helper program.** Run `dist\linkunzip-setup.exe` (built by `python tools/package.py`) and
   click **Install**. It installs for the current user only (no admin prompt) into
   `%LOCALAPPDATA%\Programs\linkunzip\`, registers the native-messaging host for Chrome, Edge, Brave
   and Chromium under `HKCU`, and adds a normal entry to *Settings > Apps > Installed apps* that
   removes all of it. Silent install for scripts: `linkunzip-setup.exe /VERYSILENT /SUPPRESSMSGBOXES`.
   Rebuilt the program? Run `tools/package.py` and the new setup again; it closes a running helper
   process (not the browser) and replaces it.

   Developers can skip the installer: `linkunzip host install` copies the binary to
   `%LOCALAPPDATA%\linkunzip\` and writes the same registry values (last one wins);
   `linkunzip host status` shows where they point.

2. **The extension.** Until it is in the Chrome Web Store: open `chrome://extensions`, switch on
   **Developer mode**, click **Load unpacked** and pick the `extension` folder of this project. It has
   a fixed id (`mgmhodmhlmedihmpiofacdffdekaehhk`, from the `key` in `manifest.json`), which is the id
   the host manifest allows. On first install it opens a setup page that shows whether the helper is
   installed (with the browser's exact error when it isn't) and turns green by itself once it is.
   Its *Download* button fetches `DOWNLOAD_URL` from `config.js`; while that is empty it offers the
   copy of `linkunzip-setup.exe` that `tools/package.py` places in this folder (never in the store
   zip). Once downloaded, the button becomes *Open the installer*.

`tools/package.py` also writes `dist/linkunzip-extension-<version>.zip`, the extension without the
`key` field, as the Chrome Web Store wants it. The store assigns its own id: add it to the host
manifest with `LINKUNZIP_EXTRA_IDS=<store id> python tools/package.py`.

## Using it

- **Right-click a link** to a zip, then *Extract with LinkUnzip*. The popup opens and reads the index.
- **Toolbar icon**: paste a URL, or pick one of the `.zip` links found on the current page.
- The popup shows **Cost Analysis** for this archive: what
  LinkUnzip writes, the zip it never saves, a normal download-then-extract, your free space. Then
  the **File List**, the folder (**Browse...** opens the Windows folder picker), and the buttons
  **Start Extraction (N files, size)**, **Download Normal ZIP (Fallback)** and **Cancel**, with a
  status bar under them. Nothing is written before Start Extraction.
- **File List** (always open): open folders with breadcrumbs, tick or untick files and folders,
  search every name with *Filter*, and see live totals ("1,204 files, 2.1 GB to write, about 800 MB
  to download"). Big folders come 500 entries at a time (*Show more*). Keyboard: arrows move, Space
  ticks, Enter opens a folder, Backspace goes up. **Pattern...** opens one line for a pattern filter
  (`*.dll, docs/*`); its clear button removes it. Older helpers (before protocol 2) show just the pattern field.
- **Light or dark:** follows Windows until you pick one with the sun/moon button in the header or
  *Settings › Appearance* (`theme.js` applies the choice before the page paints).
- **Servers without Range support** (GitHub's *Download ZIP*) get a **Stream it anyway** button:
  one connection, no preview, still no zip on disk.
- **Links that need your login**: public links need no site permission at all (the helper downloads
  them, not the browser). When a site answers "sign in first" (or with a web page, often a sign-in
  page), the popup offers **Use my login on <site>**: Chrome asks once for that one site, then the
  job runs again with the browser's cookies for it.
- **Settings** (gear): base folder, parallel connections, *Use my login when a site needs it* (the
  offer above; on by default), *Use my login on every site* (off; one Chrome prompt for all sites,
  turning it off removes the permission again) and *Catch .zip downloads*, which cancels Chrome's
  own download of a `.zip` and shows the popup instead (off by default).
- Closing the popup does not stop an extraction; the toolbar badge shows the percentage and a
  notification appears when it finishes (click it to open the folder).

## What it can't do

- `blob:` / `data:` downloads that only exist inside a page (WhatsApp Web, many web apps).
- Links that need more than cookies (a one-time token that was already used up, POST downloads).
- It needs the `linkunzip` program installed on the PC; it is not a standalone extension.

## Permissions, and why

| Permission | Why |
|---|---|
| `nativeMessaging` | talk to the local `linkunzip` program |
| `contextMenus` | the right-click entry |
| `storage` | settings, and job state for the popup |
| `notifications` | "finished" / "failed" |
| `downloads` | *Catch .zip downloads*, *Download Normal ZIP* / *Download normally*, and downloading the helper's installer on the setup page |
| `downloads.open` | the setup page's *Open the installer* button |
| `cookies` | read the cookies for the zip's site, only on sites you allowed (next row) |
| sites, optional (`optional_host_permissions: <all_urls>`) | nothing at install. Asked for one site when you click *Use my login on <site>*, or for every site when you turn on *Use my login on every site* |
| `scripting` + `activeTab` | list the `.zip` links on the page you are looking at |

The install prompt only mentions downloads and communicating with a native application: no "read
and change all your data on all websites". Without a site permission the extension hands the helper
no cookies, no browser `User-Agent` and no `Referer` for that site. (A right-click or toolbar click grants `activeTab`
for the page's site, but Chrome's cookie API still answers nothing without the site permission, so
it does not replace the prompt.)

Everything stays on your machine: the extension only talks to the local program, and the program only
talks to the server of the zip you chose.

## Testing

`node tools/e2e/extension.mjs` drives a throwaway headless Chrome with this extension and the real
native host against local servers (see the header of that file). It checks the extension id, the host
connection, the setup page, inspect, extract + SHA-256 verification, choosing files, Stop and Resume,
a server without Range support, stream mode and download interception; with stubbed helper replies
it checks every error screen, Browse..., the file list on a 118k-file folder, the update card and the
theme switch, and screenshots 30 screens in light and dark with an automatic WCAG AA contrast and
no-sideways-scroll check. `--stubs-only` runs just the stubbed part (no local servers needed).

Icons and the header line art come from the logo (`logo/linkunzip-logo.png`):
`python tools/make_icons.py` regenerates them (and the helper's `.ico` and the installer images).
