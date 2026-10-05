//! Runs the ZIP parsers against real archives written by Python's `zipfile`
//! and compare every field with what Python recorded in the manifest.
//! (Unit tests in src/zip/* cover hand-built edge cases; this is the independent cross-check.)

mod common;

use linkunzip::zip::central::{Entry, parse_central_directory};
use linkunzip::zip::eocd::{self, TailInfo};

/// Parse the index straight from a file on disk, using the same steps `read_index` will use
/// over HTTP: tail -> EOCD (-> ZIP64 EOCD) -> central directory.
fn index_of(path: &std::path::Path) -> Vec<Entry> {
    let data = std::fs::read(path).unwrap();
    let window = data.len().min(eocd::TAIL_WINDOW as usize);
    let tail_start = data.len() - window;
    let loc = match eocd::parse_tail(&data[tail_start..]).unwrap() {
        TailInfo::Classic(loc) => loc,
        TailInfo::Zip64 { zip64_eocd_offset } => {
            eocd::parse_zip64_eocd(&data[zip64_eocd_offset as usize..]).unwrap()
        }
    };
    let cd = &data[loc.offset as usize..(loc.offset + loc.size) as usize];
    parse_central_directory(cd, loc.entry_count).unwrap()
}

fn check_against_manifest(kind: &str) {
    let fx = common::fixture(kind);
    let entries = index_of(&fx.zip_path);
    assert_eq!(entries.len(), fx.files.len() + fx.dirs.len(), "entry count");
    let by_name: std::collections::HashMap<&str, &Entry> =
        entries.iter().map(|e| (e.name.as_str(), e)).collect();

    for f in &fx.files {
        let e = by_name
            .get(f.name.as_str())
            .unwrap_or_else(|| panic!("{} missing from index", f.name));
        assert_eq!(e.uncompressed_size, f.size, "{}: size", f.name);
        assert_eq!(
            e.compressed_size, f.compressed_size,
            "{}: compressed size",
            f.name
        );
        assert_eq!(e.crc32, f.crc32, "{}: crc", f.name);
        assert_eq!(e.method, f.method, "{}: method", f.name);
        assert_eq!(e.local_header_offset, f.header_offset, "{}: offset", f.name);
        assert!(!e.is_dir() && e.unsupported_reason().is_none());
    }
    for d in &fx.dirs {
        let e = by_name
            .get(d.as_str())
            .unwrap_or_else(|| panic!("dir {d} missing"));
        assert!(e.is_dir());
    }
}

#[test]
fn small_archive_matches_python() {
    check_against_manifest("small");
}

#[test]
fn streamed_archive_with_data_descriptors_matches_python() {
    check_against_manifest("streamed");
}

#[test]
fn zip64_eocd_with_70000_entries_matches_python() {
    // More than 65,535 entries => the classic EOCD is full of 0xFFFF and a ZIP64 EOCD record is used.
    let fx = common::fixture("many");
    let data = std::fs::read(&fx.zip_path).unwrap();
    let window = data.len().min(eocd::TAIL_WINDOW as usize);
    assert!(
        matches!(
            eocd::parse_tail(&data[data.len() - window..]).unwrap(),
            TailInfo::Zip64 { .. }
        ),
        "expected the ZIP64 path to be taken"
    );
    check_against_manifest("many");
}

#[test]
fn cp437_and_unicode_names_are_decoded() {
    let fx = common::fixture("small");
    let names: Vec<String> = index_of(&fx.zip_path).into_iter().map(|e| e.name).collect();
    for expected in [
        "legacy/café_cp437.txt",
        "unicode/日本語/ファイル.txt",
        "unicode/emoji_😀_file.txt",
    ] {
        assert!(names.iter().any(|n| n == expected), "{expected} not found");
    }
}
