# Code signing

How the LinkUnzip installer gets signed, and what to do when it's time. Written 2026-10-04.

## Decision

- **Now:** unsigned builds. The signing hook is ready (`LINKUNZIP_SIGN_COMMAND`) but unused.
- **Right before the public launch:** buy a **Certum Open Source Code Signing in the Cloud**
  certificate and sign releases on the maintainer's PC ([Route 1](#route-1-certum-open-source-code-signing-in-the-cloud)).
- **Later**, once the project has some reputation: apply to the free **SignPath Foundation**
  programme ([Route 2](#route-2-signpath-foundation-later)).
- Not available: Microsoft's **Azure Artifact Signing** ($9.99/month) only accepts individuals in
  the USA and Canada.

## What signing changes, and what it doesn't

Without a signature, Windows SmartScreen shows *Windows protected your PC* with
*Publisher: Unknown publisher* when someone runs the downloaded installer, and the browser may
say the file isn't commonly downloaded. People have to click *More info*, then *Run anyway*.

With a signature:

- Windows shows the certificate's name as the publisher (for Certum Open Source:
  *Open Source Developer, Your Name*; for SignPath Foundation: *SignPath Foundation*),
  in SmartScreen, in the file's *Properties > Digital Signatures*, and in Installed apps.
- Anyone can check that the file is exactly what was signed: a changed byte breaks the signature.
- With a **timestamp** (always use one), the signature stays valid after the certificate expires.

What it doesn't do: **SmartScreen still warns about a new certificate until it has built up
reputation**, which comes from many people downloading and running signed files without
problems. No certificate type skips this any more. Reputation follows the certificate, so keep
signing with the same identity and renew it rather than switching.

What gets signed: `linkunzip.exe` (before Inno Setup packs it), the uninstaller Inno Setup
generates, and `linkunzip-setup.exe`. The extension zip is not Authenticode-signed: the browser
stores sign extensions themselves.

## Costs

| Route | Cost | Publisher name shown | Where signing happens |
|---|---|---|---|
| Unsigned (now) | free | Unknown publisher | nowhere |
| Certum Open Source in the Cloud | from about EUR 49 for the first year (check the shop for the current price, VAT and renewal) | Open Source Developer, Your Name | your PC (SimplySign Desktop); CI only with unofficial tools |
| SignPath Foundation | free | SignPath Foundation | SignPath's service, called from GitHub Actions |
| Azure Artifact Signing | $9.99/month | your name | not available outside the USA/Canada for individuals |

Certum limits the certificate to 5,000 signatures a month; a release uses 3.

## How the build signs: `LINKUNZIP_SIGN_COMMAND`

`tools/package.py` signs when the environment variable `LINKUNZIP_SIGN_COMMAND` is set to a
command line with `{file}` where the file name goes. Write `{file}` without quotes: it is quoted
for you. For example:

```
signtool sign /sha1 <THUMBPRINT> /fd sha256 /tr http://time.certum.pl /td sha256 /d LinkUnzip /du https://github.com/CincaAlex/LinkUnzip {file}
```

- `/sha1 <THUMBPRINT>` picks the certificate (see below how to find it); `/fd sha256` is the file
  digest; `/tr ... /td sha256` adds an RFC 3161 timestamp from Certum's server; `/d` and `/du`
  are the name and link Windows shows in the signature details.
- `package.py` runs it on `dist\stage\linkunzip.exe`, then hands the same command to Inno Setup as
  a Sign Tool, which signs the uninstaller and the finished setup (retrying 5 times if a
  timestamp server has a bad moment).
- **The build stops** if the command fails, if `{file}` is missing, or if a file is still unsigned
  afterwards. A signature Windows doesn't trust (a test certificate) only gives a warning; the
  release workflow insists on a valid signature with a timestamp.
- The command runs directly, not through `cmd.exe`: `signtool` must be on `PATH` (or give its full
  path in quotes), and `%VARIABLES%` are not expanded. Never put a password in it.

`signtool.exe` comes with the Windows SDK. On the dev PC it is at
`C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe`; the release workflow
finds it on the GitHub runner by itself.

## Route 1: Certum Open Source Code Signing in the Cloud

The key lives in Certum's cloud (SimplySign), so there is no card or USB token: the SimplySign
app on your phone gives one-time codes, and SimplySign Desktop on the PC makes the certificate
available to `signtool` while you are logged in.

### 1. Before ordering

- **Make the GitHub repository public first.** Certum issues this certificate only for a
  publicly available open-source project that clearly shows *your* relationship with it, and
  refuses if it can't identify the project from public information. The repository under your
  own account with your name on your GitHub profile does this; a line naming you as the
  maintainer in the README also helps.
- **The certificate carries your real name.** Everyone who checks the installer sees
  *Open Source Developer, Firstname Lastname*. A pseudonym or a project name is not
  possible with this certificate (SignPath Foundation shows its own name instead).
- Certificates are issued to individuals only. Plan some days for the identity check before the
  launch date.

### 2. Order and verify your identity

1. In the Certum shop (<https://shop.certum.eu>), open *Code Signing* and choose
   **Open Source Code Signing in the Cloud**. Create a Certum account and pay.
2. In your Certum account, under *Data security products*, start the activation. Choose an
   identity verification method (automatic verification is the recommended one; the others are a
   registration point, a notary, or photos of your ID) and provide:
   - your identity document,
   - a utility bill (gas, electricity, water, phone...) in your name,
   - the project's address: `https://github.com/CincaAlex/LinkUnzip`.
3. When Certum approves, install the **SimplySign** app on your phone and scan the QR code Certum
   gives you: from then on it shows the one-time codes for your account. Keep that QR code (or the
   phone) safe: it is the key to signing as you.
4. Install **SimplySign Desktop** on the PC from Certum's support pages and log in with your
   account and a code from the phone. The certificate then appears in Windows:

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
   ```

   Note the **Thumbprint**: it goes after `/sha1` in the signing command.

### 3. Sign a release on your PC

The release workflow builds every tag in GitHub Actions and creates a **draft** release with
unsigned files. To publish signed files instead, build the same tag on your PC, signed, and swap
the files before publishing the draft:

```powershell
git checkout vX.Y.Z
$env:PATH = "$env:USERPROFILE\.cargo\bin;C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64;$env:PATH"
$env:LINKUNZIP_REPO_URL = "https://github.com/CincaAlex/LinkUnzip"
$env:LINKUNZIP_EXTRA_IDS = "<the store extension IDs, as in the repository variable>"
$env:LINKUNZIP_SIGN_COMMAND = 'signtool sign /sha1 <THUMBPRINT> /fd sha256 /tr http://time.certum.pl /td sha256 /d LinkUnzip /du https://github.com/CincaAlex/LinkUnzip {file}'
python tools\package.py
```

(SimplySign Desktop must be open and logged in.) Check the result (see
[Verify a signature](#verify-a-signature)), then replace the draft's files and publish:

```powershell
gh release upload vX.Y.Z dist\linkunzip-setup.exe dist\linkunzip-extension-X.Y.Z.zip dist\SHA256SUMS.txt --clobber
```

Upload all three together: `SHA256SUMS.txt` must match the files next to it. On the draft's page,
delete the paragraph saying the build is not code-signed, then **Publish release**. Go back to
your branch afterwards (`git checkout main`).

### 4. Optional, later: signing in GitHub Actions with Certum

Certum's official tooling is the desktop app. Unofficial tools exist that sign from a GitHub
runner, either by driving SimplySign Desktop or by talking to Certum's cloud service directly,
for example [certum-cloud-code-sign](https://github.com/jay0lee/certum-cloud-code-sign),
[super-simply-sign](https://github.com/actions-marketplace-validations/IvanHanloth_super-simply-sign)
and [ssign](https://github.com/Le-Syl21/ssign). They need your SimplySign login and the secret
behind the phone app's codes stored as repository secrets, so **anyone who can change the
workflows could sign as you**. If you go this way:

1. Read the tool's code and pin it to a full commit SHA, not a tag.
2. Create an environment `release` (Settings > Environments) with yourself as required reviewer
   and *Deployment branches and tags* limited to `v*` tags; put the secrets there, and add
   `environment: release` to the job in `.github/workflows/release.yml`.
3. Add the tool's setup step where the comment in `release.yml` says, and set the repository
   variable `LINKUNZIP_SIGN_COMMAND` to the command it documents (with `{file}`).
4. Once a dry run (Actions > Release > Run workflow) shows valid signatures, set the variable
   `LINKUNZIP_RELEASE_DRAFT` to `false` if you want tags to publish directly.

## Route 2: SignPath Foundation (later)

SignPath Foundation signs open-source releases for free with a certificate issued to
*SignPath Foundation*, so no personal identification is needed and the publisher shown is
*SignPath Foundation*, not you. Its conditions (see <https://signpath.org/terms>):

- an OSI-approved licence (GPL-3.0-or-later qualifies), no malware or unwanted programs,
  actively maintained, already released in the form to be signed, and some verifiable reputation;
- a **Code Signing Policy** page on the project's website naming the team roles (authors,
  reviewers, approvers), with a privacy statement and attribution to SignPath Foundation and
  SignPath.io;
- multi-factor authentication for every team member on SignPath and GitHub;
- binaries built by CI from the public repository, so SignPath can verify where they came from.

Apply at <https://signpath.org/apply> after a few public releases and some users. When accepted,
the release workflow changes shape: signing becomes signing requests made with SignPath's GitHub
action (`signpath/github-action-submit-signing-request`) from the GitHub-hosted runner. Sign
`linkunzip.exe`, build the installer with `package.py --skip-build`, then sign the setup. In that
shape the uninstaller stays unsigned (Inno Setup can only sign it through a local Sign Tool); that
is acceptable because it is never downloaded. Plan that change when the application is approved.

## Verify a signature

```powershell
Get-AuthenticodeSignature .\linkunzip-setup.exe | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

- `Status` must be `Valid`.
- `SignerCertificate` shows the subject (*Open Source Developer, ...*) and the expiry date.
- `TimeStamperCertificate` must be present, or the signature dies with the certificate.

Also check the program inside: after installing, run the same command on
`%LOCALAPPDATA%\Programs\LinkUnzip\linkunzip.exe` and `unins000.exe`. Explorer shows the same
under *Properties > Digital Signatures*. With the SDK: `signtool verify /pa /v linkunzip-setup.exe`.
