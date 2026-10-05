// Gives linkunzip.exe its icon and version details on Windows (Explorer, Task Manager and
// "Installed apps" show them). The .rc file is generated so the version always matches Cargo.toml.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=resources/linkunzip.ico");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let icon = root.join("resources").join("linkunzip.ico");
    let version = env::var("CARGO_PKG_VERSION").unwrap();
    let mut parts = version
        .split(['.', '-', '+'])
        .map(|p| p.parse::<u16>().unwrap_or(0));
    let (major, minor, patch) = (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    );
    let icon_path = icon.display().to_string().replace('\\', "\\\\");

    let rc = format!(
        r#"#pragma code_page(65001)
1 ICON "{icon_path}"
1 VERSIONINFO
FILEVERSION {major},{minor},{patch},0
PRODUCTVERSION {major},{minor},{patch},0
FILEOS 0x40004
FILETYPE 0x1
BEGIN
  BLOCK "StringFileInfo"
  BEGIN
    BLOCK "040904B0"
    BEGIN
      VALUE "CompanyName", "LinkUnzip"
      VALUE "FileDescription", "LinkUnzip"
      VALUE "FileVersion", "{version}"
      VALUE "InternalName", "linkunzip"
      VALUE "OriginalFilename", "linkunzip.exe"
      VALUE "ProductName", "LinkUnzip"
      VALUE "ProductVersion", "{version}"
    END
  END
  BLOCK "VarFileInfo"
  BEGIN
    VALUE "Translation", 0x409, 1200
  END
END
"#
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("linkunzip.rc");
    fs::write(&out, rc).unwrap();
    // Optional: a machine without the Windows SDK's rc.exe still builds, just without an icon.
    embed_resource::compile(&out, embed_resource::NONE)
        .manifest_optional()
        .unwrap();
}
