# Changelog

All notable changes to LinkUnzip. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/). The helper (`linkunzip.exe`) and
the extension always share one version number.

## Unreleased

Work towards 1.0, the first public release.

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
