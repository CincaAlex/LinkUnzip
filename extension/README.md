# LinkUnzip for Chrome

Right-click a link to a `.zip`, then **Extract with LinkUnzip**. The extension reads the zip's index
from the end of the file, shows what is inside and what it would cost, then downloads only the parts
it needs, checks every file and saves it into Downloads or a folder you choose. The zip itself is
never saved. Everything runs inside the browser: it works in Chrome 116 or newer, Edge, Brave and
Chromium, and is tested in Google Chrome on Windows, macOS and Linux.

```
 popup, right-click menu --> background.js --> engine/ in offscreen.html --(HTTP Range, or one pass)--> the server
                                    |                 reads the index, extracts, checks every file
                                    +--(optional, Windows)--> linkunzip.exe, the helper
```

`engine/` runs in a hidden offscreen page, so an extraction carries on after the popup closes.

## Run it from source

Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), switch on
**Developer mode**, click **Load unpacked** and pick this `extension` folder. It has a fixed id
(`mgmhodmhlmedihmpiofacdffdekaehhk`, from the `key` in `manifest.json`). On first install it opens a
**Set up LinkUnzip** page, where you can let it read zip links on every site at once and choose
where extracted files go.

`tools/package.py` writes `dist/linkunzip-extension-<version>.zip`, the extension without the `key`
field, as the Chrome Web Store wants it.

### The optional helper (Windows)

Nothing needs it. Once installed and turned on in **Settings > Extract with the Windows helper**, it
saves straight into the Windows Downloads folder (faster for zips with thousands of small files),
**Open folder** opens that folder in Explorer, and it brings the `linkunzip` command line. Password
zips, zips inside zips and links that need your login stay in the browser.

Run `dist\linkunzip-setup.exe` (built by `python tools/package.py`) and click **Install**: it
installs for the current user only into `%LOCALAPPDATA%\Programs\LinkUnzip` and registers the
native-messaging host for Chrome, Edge, Brave and Chromium. Developers can skip the installer:
`linkunzip host install` registers the binary directly, `linkunzip host status` shows where it
points. The store assigns its own extension id: add it with
`LINKUNZIP_EXTRA_IDS=<store id> python tools/package.py` so the helper accepts it.

## Using it

- **Right-click a link** to a zip, then *Extract with LinkUnzip*, or click the toolbar icon and
  paste a link (the popup also lists the `.zip` links on the page you are on).
- **Cost Analysis**: what LinkUnzip writes, the zip it never saves, a normal download-then-extract,
  and what it will download. (Browsers don't tell extensions the free space; with the helper it is
  shown too.)
- **File List**: folders with breadcrumbs, tick any mix of files and folders, search every name
  with *Filter* or a type with `*.jpg`, and tick every result at once. Files left out are never
  downloaded. The eye on a row previews that one file in a tab (text, CSV, images, PDF, audio,
  video). Keyboard: arrows move, Space ticks, Enter opens a folder, Backspace goes up.
  **Pattern...** takes rules like `*.dll, docs/*`.
- **Servers without Range support**, like GitHub's *Download ZIP*: **Extract everything (one pass)**
  reads the zip once, in the browser, still without saving it.
- **Password-protected zips** (ZipCrypto, WinZip AES): a password field under the file list. The
  password is checked on the first protected file before anything is written and kept in memory
  only.
- **Zips inside zips**: *Open* on a zip in the file list shows its own files, read through the
  outer zip.
- **Downloads or a folder you choose** (Settings): Downloads needs no setup; a folder you choose is
  much faster for zips with thousands of files.
- **Links that need your login**: LinkUnzip asks Chrome for that one site, and the browser then
  sends its own cookies for it with LinkUnzip's requests.
- **Stop** and **Resume**, notifications when a job ends, light and dark (follows the system, or
  the sun/moon button).

## What it can't do

- `blob:` / `data:` downloads that only exist inside a page (WhatsApp Web, many web apps).
- Links that need more than cookies (a one-time token that was already used up, POST downloads).
- RAR, 7z, or compression other than stored and deflate.

## Permissions, and why

| Permission | Why |
|---|---|
| `offscreen` | the hidden page where the engine runs, so a job outlives the popup |
| `contextMenus` | the right-click entry |
| `storage` | settings, and job state for the popup |
| `notifications` | "finished" / "failed" |
| `downloads` | saving into Downloads, *Catch .zip downloads*, *Download normally*, and downloading the helper's installer on the setup page |
| `downloads.ui` | hides Chrome's download bubble while a job saves many files into Downloads (it would pop up for every file) |
| `scripting` + `activeTab` | list the `.zip` links on the page you are looking at |
| `nativeMessaging` | talk to the optional helper, if it is installed |
| sites, optional (`optional_host_permissions: <all_urls>`) | nothing at install. Chrome asks for a site the first time you use a link there, or once for every site if you allow that on the setup page or in Settings |

Everything stays on your machine: the extension talks only to the server of the zip you chose (and
to the helper, if you turned it on).

## Testing

See [CONTRIBUTING.md](../CONTRIBUTING.md). In short: `node tools/engine_test.mjs` tests the engine
under Node; `tools/e2e/browser_engine.mjs` and `tools/e2e/extension.mjs` drive a throwaway headless
Chrome with this extension against local servers; `tools/e2e/real_hosts.mjs` measures it on real
servers.

Icons and the header line art come from the logo (`logo/linkunzip-logo.png`):
`python tools/make_icons.py` regenerates them (and the helper's `.ico` and the installer images).
