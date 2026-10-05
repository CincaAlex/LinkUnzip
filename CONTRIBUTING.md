# Contributing to LinkUnzip

Thanks for helping. Bug reports, fixes and ideas are all welcome. For anything bigger than a small
fix, please open an issue first so we can agree on the approach before you spend time on it.

Security problems: please don't open a public issue, see [SECURITY.md](SECURITY.md).

## What you need

- Windows 10 or 11 (the helper is Windows-only for now).
- [Rust](https://rustup.rs), stable toolchain, with `rustfmt` and `clippy`.
- Python 3 on `PATH` (the tests generate their archives with it).
- Node 22, for checking the extension scripts and for the end-to-end test.
- [Inno Setup 6](https://jrsoftware.org/isinfo.php) to build the installer
  (`winget install JRSoftware.InnoSetup`).
- Chrome, to run the extension.

## Build and test

```powershell
cargo build --release              # target\release\linkunzip.exe
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test                         # unit and integration tests
Get-ChildItem extension\*.js | ForEach-Object { node --check $_.FullName }
```

CI runs exactly these on every push and pull request (`.github/workflows/ci.yml`). One more test
needs about 5 GB of disk, so it only runs on request:

```powershell
cargo test --release --test zip64 -- --ignored   # a ZIP64 archive over 2 GiB
```

The integration tests generate their archives on first use (`tools/make_test_zips.py` and
`tools/make_malicious_zips.py`, into `<target>\tmp\fixtures`), extract them through a local Range
server that drops connections on purpose, and compare the SHA-256 of every output file with the
original. The tools also work on their own:

```powershell
python tools\make_test_zips.py small|streamed|many|zip64|demo --out <dir>   # see --help
python tools\make_malicious_zips.py --out <dir>
python tools\range_server.py <folder> 8080          # a static file server with Range support
python tools\verify_extract.py <extracted> <manifest.json>
```

### The browser end-to-end test

Before a change to the helper protocol or the extension, also run `tools/e2e/extension.mjs`. It
drives a throwaway headless Chrome with the extension and the installed helper against local
servers: inspecting, extracting with SHA-256 checks, choosing files, Stop and Resume, a server
without Range support, stream mode, catching downloads, and every screen in light and dark with a
contrast check.

```powershell
npm i puppeteer-core --prefix $env:LOCALAPPDATA\linkunzip-e2e    # once
python tools\make_test_zips.py demo --out $env:LOCALAPPDATA\linkunzip-test\demo-data --size-gb 1.2
python tools\package.py; dist\linkunzip-setup.exe /VERYSILENT /SUPPRESSMSGBOXES
$env:E2E_MODULES = "$env:LOCALAPPDATA\linkunzip-e2e"
node tools\e2e\extension.mjs        # --stubs-only for the quick part without local servers
```

It needs about 1 GB of demo data and a real helper install, so it runs locally rather than in CI.

## Package and release

```powershell
python tools\package.py [--skip-build]
```

writes `dist\linkunzip-setup.exe`, `dist\linkunzip-extension-<version>.zip` (the extension without
its development `key`, for the stores) and `dist\SHA256SUMS.txt`, and copies the installer into
`extension\` so an unpacked copy can offer it on its setup page. Environment variables:

| Variable | Meaning |
|---|---|
| `LINKUNZIP_EXTRA_IDS` | comma-separated extension IDs the helper also accepts (the store IDs) |
| `LINKUNZIP_SIGN_COMMAND` | code-signing command with `{file}` where the file goes; see [docs/signing.md](docs/signing.md) |
| `LINKUNZIP_REPO_URL` | the repository's address, shown as the publisher and support links in *Installed apps* |
| `CARGO_TARGET_DIR` | Cargo's build folder (default `target\`) |
| `ISCC` | path to Inno Setup's `ISCC.exe`, if it isn't in a standard place |

Releases are built by GitHub Actions from a `v*` tag: see [docs/release.md](docs/release.md).

## Project layout

| Path | Role |
|---|---|
| `src/zip/` | The ZIP format: end-of-central-directory and ZIP64 records, central directory, local headers, reading the index over HTTP |
| `src/http.rs`, `src/error.rs` | Probing a server, ranged GETs, retries and backoff, error codes |
| `src/plan.rs`, `src/safety.rs` | Choosing entries, checking them, grouping them into spans; path sanitising |
| `src/extract.rs`, `src/stats.rs` | The extraction engine: worker threads, per-entry streaming, counters |
| `src/stream.rs` | Sequential mode for servers without Range support |
| `src/resume.rs` | Skipping files a previous run already finished |
| `src/host.rs`, `src/picker.rs` | The native-messaging helper and the Windows folder picker |
| `src/inspect.rs`, `src/ui.rs`, `src/main.rs` | The `inspect` report, the progress display and the command line |
| `tests/` | Integration tests (local Range server, hostile archives, stream mode, resume, the helper protocol) |
| `extension/` | The browser extension (Manifest V3); see [extension/README.md](extension/README.md) |
| `installer/` | The per-user Windows installer (Inno Setup) |
| `tools/` | Packaging, test-archive generators, a Range server, an output checker, the end-to-end test, the icon generator |
| `site/` | The website, deployed to GitHub Pages |
| `docs/` | Privacy policy, release and signing guides |

## Windows notes

- **Folder synced by OneDrive (or Dropbox)?** Keep the build output out of it, or the sync client
  uploads thousands of build files: `$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\linkunzip-target"`.
- **`cargo` not found?** rustup adds `%USERPROFILE%\.cargo\bin` to `PATH` for new terminals only.
- **Never start `chrome.exe` for testing without its own `--user-data-dir`**: it would open in
  your normal browser profile. The end-to-end test uses throwaway profiles.
- **Save `Cargo.toml` and `extension/manifest.json` without a byte-order mark.** Windows
  PowerShell 5.1's `Set-Content -Encoding utf8` and `Out-File` add one.

## Code style

- **Messages are plain English for people**: say what happened and what to do next ("This link
  opens a web page, not the file"), not internal names. Technical detail goes in a separate
  detail field.
- **Every behaviour has a test.** A bug fix comes with the test that would have caught it. The
  integration tests in `tests/` run against a local Range server and compare SHA-256 hashes of
  the output; follow their pattern.
- Rust: `cargo fmt`, no clippy warnings, errors with `anyhow` context that reads as a sentence.
- Extension: text that comes from archives or servers goes through `textContent` (the `h()`
  helper), never `innerHTML`. No remote code, no analytics, no tracking.
- Archives are untrusted input: a change to parsing or writing files needs a test with a hostile
  archive (`tools/make_malicious_zips.py`).
- Keep the style of the code around your change: naming, comment density, how errors are shown.

## Pull requests

- One topic per pull request, with a short description of what changed and why.
- Update `README.md` when you change what people see or a command-line option, and add a line to
  the *Unreleased* section of `CHANGELOG.md`.
- The pull request template has the checklist.

## Licence of contributions

LinkUnzip is licensed under the [GNU General Public License v3.0 or later](LICENSE). By sending a
contribution you agree that it is licensed under the same terms.
