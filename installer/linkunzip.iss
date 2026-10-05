; LinkUnzip installer (Inno Setup 6). Build it with:  python tools/package.py
;
; Installs for the current user only, so there is no administrator prompt:
;   %LOCALAPPDATA%\Programs\LinkUnzip\linkunzip.exe            the program (also the CLI)
;   %LOCALAPPDATA%\Programs\LinkUnzip\com.linkunzip.host.json  native-messaging host manifest
;   %LOCALAPPDATA%\Programs\LinkUnzip\LICENSE.txt              the GPL, which travels with the program
;   one registry value per browser (HKCU) pointing at that manifest
; and an entry in Settings > Apps > Installed apps that removes all of it again.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\dist\stage"
#endif
; The project's home; package.py passes the real one from LINKUNZIP_REPO_URL (the release workflow
; sets it from the GitHub repository).
#ifndef RepoUrl
  #define RepoUrl "https://github.com/CincaAlex/LinkUnzip"
#endif
#define HostKey "NativeMessagingHosts\com.linkunzip.host"

[Setup]
AppId={{80CBDE21-10A7-48F6-A3FD-79A644DB2DB8}
AppName=LinkUnzip
AppVersion={#AppVersion}
AppVerName=LinkUnzip {#AppVersion}
AppPublisher=LinkUnzip
AppPublisherURL={#RepoUrl}
AppSupportURL={#RepoUrl}/issues
AppUpdatesURL={#RepoUrl}/releases
AppCopyright=Copyright (C) 2026 the LinkUnzip contributors. License: GPL-3.0-or-later
DefaultDirName={autopf}\LinkUnzip
PrivilegesRequired=lowest
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=linkunzip-setup
SetupIconFile=..\resources\linkunzip.ico
WizardImageFile=..\resources\wizard-large-100.bmp,..\resources\wizard-large-200.bmp
WizardSmallImageFile=..\resources\wizard-small-100.bmp,..\resources\wizard-small-200.bmp
WizardStyle=modern
UninstallDisplayIcon={app}\linkunzip.exe
UninstallDisplayName=LinkUnzip
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
; A browser may be running linkunzip.exe right now: close that helper process (not the browser)
; so the new version can be copied in. The extension starts it again on the next extraction.
CloseApplications=force
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName=LinkUnzip
VersionInfoDescription=LinkUnzip setup
#ifdef Sign
; Code signing (docs/signing.md): package.py defines the "linkunzipsign" Sign Tool from
; LINKUNZIP_SIGN_COMMAND and signs linkunzip.exe itself; Inno Setup signs the uninstaller and the
; finished setup with it. Timestamp servers have bad moments, hence the retries.
SignTool=linkunzipsign
SignedUninstaller=yes
SignToolRetryCount=5
SignToolRetryDelay=5000
#endif

[Messages]
WizardReady=Install LinkUnzip
ReadyLabel1=This adds the LinkUnzip helper to your PC, so the LinkUnzip extension in Chrome, Edge or Brave can extract ZIP files straight into a folder without saving the ZIP.
ReadyLabel2a=It installs just for you (no administrator rights), only runs while you're using LinkUnzip, and can be removed from Settings > Apps like any other app.%n%nClick Install to continue.
ReadyLabel2b=It installs just for you (no administrator rights), only runs while you're using LinkUnzip, and can be removed from Settings > Apps like any other app.%n%nClick Install to continue.
FinishedHeadingLabel=LinkUnzip is ready
FinishedLabelNoIcons=Open the LinkUnzip extension in your browser: the label at the top now says "host v{#AppVersion}".%n%nThen right-click any .zip link and choose "Extract with LinkUnzip".%n%nIf it still says "host not found", close every browser window and open the browser again.
FinishedLabel=Open the LinkUnzip extension in your browser: the label at the top now says "host v{#AppVersion}".%n%nThen right-click any .zip link and choose "Extract with LinkUnzip".%n%nIf it still says "host not found", close every browser window and open the browser again.

[Files]
Source: "{#StageDir}\linkunzip.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\com.linkunzip.host.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Google\Chrome\{#HostKey}"; ValueType: string; ValueName: ""; ValueData: "{app}\com.linkunzip.host.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\{#HostKey}"; ValueType: string; ValueName: ""; ValueData: "{app}\com.linkunzip.host.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\{#HostKey}"; ValueType: string; ValueName: ""; ValueData: "{app}\com.linkunzip.host.json"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Chromium\{#HostKey}"; ValueType: string; ValueName: ""; ValueData: "{app}\com.linkunzip.host.json"; Flags: uninsdeletekey
; Pre-release builds were called "zipstream": remove their browser registrations so only one
; helper answers. (Their files and "Installed apps" entry go with their own uninstaller.)
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.zipstream.host"; Flags: deletekey
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.zipstream.host"; Flags: deletekey
Root: HKCU; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.zipstream.host"; Flags: deletekey
Root: HKCU; Subkey: "Software\Chromium\NativeMessagingHosts\com.zipstream.host"; Flags: deletekey
