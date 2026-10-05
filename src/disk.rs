//! Free disk space and path display helpers.

use std::path::{Component, Path, PathBuf, Prefix};

use anyhow::{Context, Result};

use crate::error::{Coded, ErrorCode, disk_full_message};

/// The closest ancestor of `path` that exists (the path itself if it does). Free space can only
/// be queried on something that exists, and we don't want to create the output folder just to ask.
pub fn nearest_existing(path: &Path) -> PathBuf {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut p = abs.as_path();
    while !p.exists() {
        match p.parent() {
            Some(parent) => p = parent,
            None => break,
        }
    }
    p.to_path_buf()
}

/// Bytes available to this user on the volume that holds `path`.
pub fn free_space(path: &Path) -> Result<u64> {
    let probe = nearest_existing(path);
    fs4::available_space(&probe)
        .with_context(|| format!("could not read free disk space of {}", probe.display()))
}

/// `Z:` on Windows (from the path's drive prefix); the mount root elsewhere.
pub fn drive_label(path: &Path) -> String {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    for c in abs.components() {
        match c {
            Component::Prefix(p) => {
                return match p.kind() {
                    Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                        format!("{}:", letter as char)
                    }
                    _ => p.as_os_str().to_string_lossy().into_owned(),
                };
            }
            Component::RootDir => return "/".to_string(),
            _ => {}
        }
    }
    ".".to_string()
}

/// Remove the `\\?\` long-path prefix for display (`\\?\C:\x` -> `C:\x`); other paths unchanged.
pub fn display_path(path: &Path) -> String {
    let s = path.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => rest.to_string(),
        _ => s,
    }
}

/// Decide whether the selected files fit. Pure function so it can be unit tested.
pub fn check_fits(free: u64, needed: u64, force: bool) -> Result<()> {
    if needed <= free || force {
        return Ok(());
    }
    Err(Coded::new(
        ErrorCode::DiskFull,
        format!(
            "not enough free space: the selected files need {} ({needed} bytes) but only {} ({free} bytes) is free",
            crate::fmt::human_bytes(needed),
            crate::fmt::human_bytes(free)
        ),
    )
    .with_message(disk_full_message(needed, free))
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fits_or_refuses() {
        assert!(check_fits(100, 100, false).is_ok());
        let err = check_fits(100, 101, false).unwrap_err();
        let d = crate::error::describe(&err, None);
        assert_eq!(d.code, ErrorCode::DiskFull);
        assert!(
            d.message.contains("101 B") && d.message.contains("100 B"),
            "{d:?}"
        );
        assert!(d.code.cli_hint().unwrap().contains("--force"));
        assert!(check_fits(100, 101, true).is_ok());
    }

    #[test]
    fn nearest_existing_walks_up() {
        let tmp = std::env::temp_dir();
        let deep = tmp.join("linkunzip-does-not-exist-1").join("a").join("b");
        assert_eq!(nearest_existing(&deep), std::path::absolute(&tmp).unwrap());
        assert!(free_space(&deep).unwrap() > 0);
    }

    #[test]
    fn long_path_prefix_is_hidden_for_display() {
        assert_eq!(display_path(Path::new(r"\\?\C:\data\x")), r"C:\data\x");
        assert_eq!(
            display_path(Path::new(r"\\?\UNC\srv\share")),
            r"\\?\UNC\srv\share"
        );
        assert_eq!(display_path(Path::new("rel/path")), "rel/path");
    }
}
