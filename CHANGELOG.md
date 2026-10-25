# Changelog

All notable changes to LinkUnzip. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/). The helper (`linkunzip.exe`) and
the extension share one version number; an update to the extension alone skips the helper, which
keeps its older version until the next full release.

## 1.1.1 - Unreleased (extension only)

### Added
- **Search by type**: chips with the zip's most common file types (`*.jpg`, `*.json`), patterns
  like `*.jpg` in the search box, and **Select all N** in search results, which ticks every match,
  not only the rows on screen.
- **Progress while a big index downloads** (COCO's is about 12 MB).
- **Zips open faster the second time**: the index of the last 12 zips is kept on your PC for a week
  (Settings > Forget them). Also used when LinkUnzip reads an index again after its background
  page was closed.
- When you remove LinkUnzip, Chrome opens a short page on linkunzip.app that asks why. The address
  carries only the version number, and an answer reaches the project only if you send one (see the
  privacy policy).

### Changed
- **Any mix of ticks works**: a file ticked inside an unticked folder stays ticked, however many
  files the folder holds. Before, folders with more than 5,000 entries refused it with a hint.
- **Resume without starting over**: in a folder you chose, LinkUnzip keeps the helper's progress
  file (`.linkunzip-resume.jsonl`) while a job runs, and Resume skips the files it lists without
  reading them back. Into Downloads, Resume still knows what was saved after LinkUnzip's background
  page closed, and the popup offers to resume an earlier unfinished extraction of the same zip.
- **A dropped connection no longer restarts a stored file**: it carries on from the byte where it
  stopped. Compressed files still start again.
- **Faster on big zips**: the totals of a selection add up whole folders (70,000 files: 0.4 ms
  instead of 26 ms per change), the preview finds its file directly, and Previous / Next ask only
  for the neighbours (no more 20,000-file limit).
- **Caught .zip downloads are paused, not cancelled**, so a link that only works once isn't lost:
  Continue Download lets Chrome carry on; after an extraction the paused download goes.
- **The cookies permission is optional**: LinkUnzip asks for it only when the Windows helper's
  one-pass mode needs your login.
- Finished jobs are put away after a day (at most 10 kept), and job progress is saved less often.
- The toolbar icon's lines are lighter and thicker at 16 and 32 px, so it reads that small.
- The store name says "unzip", in each language's own word.

### Fixed
- Select none inside a folder that holds everything in the zip (COCO's `train2017/`) left Start
  Filtered Extraction clickable with 0 files. The list now says No files, the button is greyed
  out, and a file ticked next stays ticked.

## 1.1.0 - 2026-10-15 (extension only)

### Added
- LinkUnzip works without the helper: the extension reads the index, downloads only the parts it
  needs, inflates, checks every file (size and CRC-32) and saves it. Same rules as the helper for
  unsafe names, renames, zip bombs and resume. Works wherever Chrome does, not only on Windows.
- **Downloads by default**: files go into Downloads/<zip name> through Chrome's own downloads,
  with nothing to pick or allow, straight from the toolbar popup. Chrome's download list stays
  quiet while LinkUnzip works and keeps no entries. Chrome saves about 6 to 10 files a second this
  way, so for zips with thousands of files the popup suggests a folder you choose instead
  (Settings > Save extracted files to > A folder I choose), which is much faster. Names Chrome's
  downloads refuse (`.gitignore`, names with `~`, `desktop.ini`, `.lnk`) get a `_` and are listed.
- **Preview**: the eye at the end of a file row opens the file in a LinkUnzip tab without
  extracting it: text and code (the first 256 KB, then Load more), CSV as a table (first 1,000
  rows), images, PDF, audio and video. HTML is shown as source. Previous / Next (or the arrow keys)
  walk the folder.
- Settings: **Read zip links on every site** (one Chrome permission instead of one per site).

### Changed
- A folder you choose (welcome page, Settings, or Change... next to the folder) works for every
  zip or for one: each zip goes into its own subfolder of it. Chrome doesn't let extensions pick
  Downloads, Desktop or Documents themselves, only folders inside them. The popup shows the
  folder's name; Chrome doesn't tell extensions the full path.
- Logins: the browser sends its own cookies for the zip's site, only when you allowed it for that
  site (or in Settings for every site). They no longer go to a helper program.
- A link that sends the download on to another site (GitHub's "Download ZIP" goes on to
  codeload.github.com) while LinkUnzip may only read the first one now says so, with Allow every
  site, instead of retrying like a lost connection.
- The helper is optional: it is still used for servers that can't send parts of a file (stream
  mode) and for Open folder on its own jobs.

### Not in the browser version yet
- Free space on the drive (browsers don't tell extensions); a full disk still ends with the "Not
  enough free space" screen.
- Open folder after an extraction into a folder you chose (into Downloads, Open Downloads opens
  the Downloads folder).
- Servers without Range support (GitHub's "Download ZIP") without the helper.

## 1.0.1 - 2026-10-10 (extension only)

### Added
- The store name and summary in German, Spanish, French, Italian, Japanese, Brazilian Portuguese
  and Romanian. The extension itself is still in English.
- After the third extraction in which every file was verified, the Done screen asks once for a
  store rating. "Rate it" or "No thanks" removes it for good. The count stays on your PC.

## 1.0.0 - 2026-10-05

The first public release.

### Added
- The **File List**: folders with breadcrumbs, checkboxes, a Filter box that searches every name,
  select all or none, live totals; files you leave out are not downloaded. **Pattern...** keeps
  the glob filter (`*.dll, docs/*`) for power users, with a button that clears it.
- **Browse...** opens the Windows folder picker (`linkunzip debug pick-folder` tries it from the
  command line).
- Resume: a stopped or failed job can run again into the same folder and skips the files that
  are already finished and verified (CRC-32 and size); its progress bar carries on from where it
  stopped. A **Resume** button on stopped and failed jobs; `--overwrite` on the command line
  extracts everything again.
- Friendly errors with a **Copy details** button: a link that opens a web page instead of the
  file, a login that is needed, an expired link, a file that is gone, not a zip, a server error,
  a full disk, a folder that can't be written, a server that can't be reached.
- "All N files verified" on the done screen.
- The helper reports its version, protocol and features; the extension offers an update when the
  helper is too old, and keeps working with it meanwhile.
- Light and dark themes: follows Windows, or choose with the sun/moon button or
  Settings > Appearance. Visible keyboard focus, keyboard use of the file list, screen reader
  labels.
- A **Cancel** button on the ready screen.
- The Cost Analysis follows the files ticked in the File List (files to write, to download, a
  normal download, free space).
- Before asking Chrome for a site, the login card says where the cookies go: only to the helper on
  this PC, and from there only to that site.
- Release workflow for GitHub Releases (installer, store zip, `SHA256SUMS.txt`) with an optional
  code-signing step.
- Open-source repository: GPL-3.0-or-later licence, contributing guide, security policy, issue
  templates, privacy policy, CI and a release workflow.

### Changed
- New look: the LinkUnzip logo everywhere (extension, helper, installer), a dark header with
  LINKUNZIP, Cost Analysis and the File List in one panel, the main buttons always in view, a
  status bar, and the zinc colour palette.
- No "read and change all your data on all websites" warning at install: public links need no
  site permission, and LinkUnzip asks for a site only when a download needs your login there
  (or once for every site, if you turn that on in Settings).
- "Downloaded" now includes the zip's index, also shown on its own.

## 0.2.0 - 2026-10-04

### Changed
- Renamed from "zipstream" to **LinkUnzip**: program `linkunzip.exe`, helper registration
  `com.linkunzip.host`, installer `linkunzip-setup.exe` installing to
  `%LOCALAPPDATA%\Programs\LinkUnzip`, extension "LinkUnzip" with the menu entry
  *Extract with LinkUnzip*.
- The installer removes the browser registrations of the pre-release `com.zipstream.host`.

## 0.1.0 - pre-release as "zipstream" (2026-10-02 to 2026-10-04, not published)

### Added
- Command line: `inspect` (what extracting would need, compared with download-then-extract) and
  `extract`, reading only the zip's index and the selected entries over HTTP Range requests, with
  parallel connections and `--include` filters. The zip is never written to disk.
- ZIP64, constant memory, every file checked (CRC-32 and size) and renamed from `.part` only when
  correct; network retries restart only the current file.
- Safety: refuses path tricks and duplicate entries before writing, renames names Windows can't
  store, zip-bomb and free-space guards.
- `--stream` for servers without Range support (GitHub's *Download ZIP*): one pass, one
  connection.
- Chrome extension (Manifest V3): right-click *Extract with ...*, toolbar popup with the zip links
  on the page, cost preview, progress, Stop, notifications, *Stream it anyway*,
  *Download normally*, optional *Catch .zip downloads*, use of the browser login.
- Native-messaging helper and `host install | uninstall | status`.
- Per-user Windows installer (Inno Setup) and a setup page in the extension that detects the
  helper and offers the installer.
