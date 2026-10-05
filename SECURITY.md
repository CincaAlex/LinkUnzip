# Security policy

LinkUnzip downloads files from links and writes them to your disk, and its browser extension can
pass your login cookies for a site to the helper program. Security reports are very welcome.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately through GitHub:

1. Go to <https://github.com/CincaAlex/LinkUnzip/security/advisories/new>
   (or the repository's **Security** tab, then **Report a vulnerability**).
2. Describe the problem, the version (helper and extension), and how to reproduce it. A small
   archive or a script that shows the issue helps a lot. Please don't include real private links
   or cookies.

The maintainer aims to reply within 7 days, keeps you informed while a fix is prepared, and
credits you in the advisory and the changelog unless you prefer otherwise. Please give us a
reasonable time to release a fix before you publish details.

## Supported versions

Only the latest release gets security fixes. The helper and the extension are released together
with the same version number; please update both before reporting.

| Version | Supported |
|---|---|
| latest release | yes |
| older releases | no |

## What counts

Examples of what we want to hear about:

- An archive that makes LinkUnzip write outside the chosen folder, overwrite a file it shouldn't,
  or use far more disk or memory than its declared size.
- Cookies or other headers sent to a host other than the one of the link you chose.
- Another extension, a web page or another program being able to make the helper do something.
- The installer or the helper registration being abusable on a shared PC.
- Anything in the extension that lets a web page or an archive inject script.

Out of scope: problems that need an attacker who already controls your Windows account, the
SmartScreen warning on unsigned builds, and denial of service by a server that is simply slow.
