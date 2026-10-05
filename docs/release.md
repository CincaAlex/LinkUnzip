# Releasing LinkUnzip

How a version gets from `main` to the people who install it. Written 2026-10-04. Signing has
its own guide: [signing.md](signing.md).

What a release publishes (GitHub Release, built by `.github/workflows/release.yml` from a tag):

| File | For |
|---|---|
| `linkunzip-setup.exe` | the Windows helper. The name never changes, so `https://github.com/CincaAlex/LinkUnzip/releases/latest/download/linkunzip-setup.exe` always gives the newest published one: that is the extension's `DOWNLOAD_URL`. |
| `linkunzip-extension-X.Y.Z.zip` | the extension for the Chrome Web Store and Edge Add-ons (no development `key`) |
| `SHA256SUMS.txt` | checksums of both |

Development continues as 0.2.x; the store launch is **1.0.0**.

## One-time setup on github.com

Nothing here is automated: these are clicks for the maintainer.

1. **The repository** is <https://github.com/CincaAlex/LinkUnzip>. The first push, from this
   folder:

   ```powershell
   git remote add origin https://github.com/CincaAlex/LinkUnzip.git
   git push -u origin main
   ```

   The website uses `{{STORE_URL}}` and `{{EDGE_STORE_URL}}` placeholders in `site/` until the
   store listings are approved.
2. **Private vulnerability reporting** (needed by `SECURITY.md`): *Settings > Code security >
   Private vulnerability reporting > Enable*.
3. **GitHub Pages** for the website in `site/`: *Settings > Pages > Build and deployment >
   Source: GitHub Actions*. `.github/workflows/pages.yml` deploys it on every change to `site/`
   on `main` and refuses while `{{...}}` placeholders are left. Under *Custom domain* enter
   `linkunzip.app` and tick *Enforce HTTPS*. The privacy policy is then at
   `https://linkunzip.app/privacy` (the URL the store listings ask for).
4. **Actions variables** (*Settings > Secrets and variables > Actions > Variables*), all
   optional:
   - `LINKUNZIP_EXTRA_IDS`: the store extension IDs, comma separated (see
     [Store IDs](#the-store-ids-and-the-helper)).
   - `LINKUNZIP_SIGN_COMMAND`: only when signing happens in CI ([signing.md](signing.md)).
   - `LINKUNZIP_RELEASE_DRAFT`: `false` to publish releases straight from the tag. Leave it unset
     while you sign on your PC: then every tag makes a draft you check and publish.
5. **Protect `main`** (recommended): *Settings > Rules > Rulesets > New branch ruleset*, target
   `main`, *Require status checks to pass* with the CI check `Windows`, and block force pushes.
6. **Sponsors** (optional): add a `.github/FUNDING.yml` once a GitHub Sponsors or Ko-fi
   account exists.

## Checklist for each release

### 1. Versions

Both must be the same `X.Y.Z` (the workflow and `package.py` refuse otherwise):

- `Cargo.toml`: `version = "X.Y.Z"`; then `cargo build` so `Cargo.lock` follows.
- `extension/manifest.json`: `"version": "X.Y.Z"` (plain numbers only: Chrome accepts no `-rc`).

### 2. Changelog

In `CHANGELOG.md`, rename *Unreleased* to `## X.Y.Z - YYYY-MM-DD` and start a new empty
*Unreleased* above it. The workflow copies the section that starts with `## X.Y.Z` into the
release notes, so keep that exact heading format.

### 3. First release only: `DOWNLOAD_URL`

Set `DOWNLOAD_URL` in `extension/config.js` to
`https://github.com/CincaAlex/LinkUnzip/releases/latest/download/linkunzip-setup.exe` **in the
release commit**, so the store zip built from the tag already points there. The link starts
working the moment the release is published. Once it is set, an unpacked copy of the extension
also downloads the published helper instead of the copy `package.py` bundles.

### 4. Local checks before tagging

CI runs the first group on every push; the rest needs the real browser and a 1 GB demo archive,
so it only runs here.

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\linkunzip-target"
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
python tools\package.py
dist\linkunzip-setup.exe /VERYSILENT /SUPPRESSMSGBOXES
& "$env:LOCALAPPDATA\Programs\LinkUnzip\linkunzip.exe" host status
$env:E2E_MODULES = "$env:LOCALAPPDATA\linkunzip-e2e"
node tools\e2e\extension.mjs
```

The end-to-end test needs the demo data first
(`python tools\make_test_zips.py demo --out $env:LOCALAPPDATA\linkunzip-test\demo-data --size-gb 1.2`)
and `npm i puppeteer-core` in `E2E_MODULES`. Then check by hand in your normal browser: install
through the setup page, right-click extraction, choosing files, Stop and Resume, a link that opens
a web page, light and dark theme.

### 5. Tag

```powershell
git commit -am "Release X.Y.Z"
git tag -a vX.Y.Z -m "LinkUnzip X.Y.Z"
git push origin main vX.Y.Z
```

### 6. Check the GitHub Release

*Actions > Release* builds the tag (about 5 minutes) and creates a **draft** release named
*LinkUnzip X.Y.Z*. On the draft:

- the three files are there; the setup is about 4 MB, the zip well under 1 MB;
- the notes show the changelog section;
- download `linkunzip-setup.exe` and compare its hash with `SHA256SUMS.txt`
  (`Get-FileHash .\linkunzip-setup.exe -Algorithm SHA256`); if it is signed, check the signature
  ([signing.md](signing.md#verify-a-signature)).

Signing on your PC (Certum)? Now build the tag signed and swap the files:
[signing.md, Sign a release on your PC](signing.md#3-sign-a-release-on-your-pc).

Then **Publish release**. Drafts are invisible to the public and to `releases/latest`, so nothing
changes for users until this click.

### 7. Test the download like a user

1. Open `https://github.com/CincaAlex/LinkUnzip/releases/latest/download/linkunzip-setup.exe` in a
   browser: it must download the new version.
2. In your normal browser, with the extension as people will get it: setup page > **Download** >
   **Open the installer** > **Install**; the page turns green and shows the new helper version.
3. Extract one public zip, e.g.
   `https://download.blender.org/release/Blender4.2/blender-4.2.0-windows-x64.zip`.

### 8. Stores

Upload the release's `linkunzip-extension-X.Y.Z.zip` in the Chrome Web Store developer dashboard
and in Edge Partner Center, then submit it for review. Say LinkUnzip is in a store only once that
listing is approved.

## The store IDs and the helper

The helper only answers extension IDs listed in its registration: the development ID plus
`LINKUNZIP_EXTRA_IDS`. A store copy of the extension has a different ID, assigned by the store,
so **the helper users install must already allow that ID**:

1. Create the store item by uploading the zip in the store's developer dashboard, without
   submitting it for review yet. The Chrome Web Store shows the item's ID at once. For Edge
   Add-ons, look for the extension ID in Partner Center; if it only appears after approval, see
   the note below.
2. Put the ID(s) in the repository variable `LINKUNZIP_EXTRA_IDS` (comma separated).
3. Cut the release (the steps above) so the published helper allows them.
4. Then submit the store items for review.

If a store ID only becomes known after approval, publish a helper release with it straight
away. Until then the extension shows its *Update the LinkUnzip helper* card, or its setup page.

## When something goes wrong

| Problem | What to do |
|---|---|
| *tag vX does not match version Y* | The tag and `Cargo.toml` differ. Delete the tag (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`), fix, tag again. |
| *extension/manifest.json says A, Cargo.toml says B* | Bump both (step 1). |
| *Inno Setup was not found* | Chocolatey's `innosetup` package failed or moved to a new major version: install it another way in `release.yml`, or point `ISCC` at `ISCC.exe`. |
| Signing failed / *not validly signed* / *no timestamp* | See [signing.md](signing.md). Timestamp servers have outages; re-run the job. |
| A broken release is already public | Publish a fixed `X.Y.Z+1` instead of replacing files: people may have the old checksums. If a file must go, delete the release and say why in the next release notes. |
| Re-run a tag after fixing the workflow | Delete the draft release and the tag, then push the tag again. |
