//! Hostile archives from tools/make_malicious_zips.py must be refused or neutralised,
//! never write outside the output folder, and leave nothing half-written behind.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use common::server::{ServerOptions, TestServer};
use common::{list_files, malicious_dir, options};
use linkunzip::extract::{self, Summary};

struct Case {
    server: TestServer,
    /// A scratch folder; extraction goes into `base/dest` so that `../` escapes land inside `base`.
    base: tempfile::TempDir,
    name: String,
}

impl Case {
    fn new(zip: &str) -> Case {
        Case {
            server: TestServer::start(&malicious_dir(), ServerOptions::default()),
            base: tempfile::tempdir().unwrap(),
            name: zip.to_string(),
        }
    }

    fn dest(&self) -> PathBuf {
        self.base.path().join("dest")
    }

    fn extract(&self, include: &[&str], jobs: usize) -> Result<Summary, String> {
        let opts = options(self.server.url_for(&self.name), &self.dest(), include, jobs);
        extract::run(&opts).map_err(|e| format!("{e:#}"))
    }

    /// Nothing may exist in `base` except (possibly) `dest`: no escaped files.
    fn assert_nothing_escaped(&self) {
        let siblings: BTreeSet<String> = std::fs::read_dir(self.base.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            siblings.iter().all(|n| n == "dest"),
            "files escaped into {:?}: {siblings:?}",
            self.base.path()
        );
        for evil in ["evil.txt", "evil2.txt"] {
            assert!(
                !self.base.path().parent().unwrap().join(evil).exists(),
                "{evil} escaped two levels up"
            );
        }
    }
}

fn files_in(dir: &Path) -> BTreeSet<String> {
    if dir.exists() {
        list_files(dir)
    } else {
        BTreeSet::new()
    }
}

fn manifest() -> serde_json::Value {
    serde_json::from_str(
        &std::fs::read_to_string(malicious_dir().join("malicious.manifest.json")).unwrap(),
    )
    .unwrap()
}

// ---- attacks: rejected before anything is written ----

#[test]
fn zip_slip_is_refused_and_nothing_at_all_is_written() {
    let case = Case::new("zipslip.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(
        err.contains("../evil.txt") && err.contains("traversal"),
        "{err}"
    );
    assert!(err.contains("Nothing was written"), "{err}");
    assert!(
        !case.dest().exists(),
        "even the output folder must not be created"
    );
    case.assert_nothing_escaped();
}

#[test]
fn zip_slip_archive_can_still_be_used_by_excluding_the_bad_entries() {
    let case = Case::new("zipslip.zip");
    case.extract(&["safe/*"], 2).unwrap();
    assert_eq!(
        files_in(&case.dest()),
        BTreeSet::from(["safe/ok.txt".to_string()])
    );
    case.assert_nothing_escaped();
}

#[test]
fn absolute_and_unc_paths_are_refused() {
    let case = Case::new("absolute.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(err.contains("absolute"), "{err}");
    assert!(!case.dest().exists());
    case.assert_nothing_escaped();
}

#[test]
fn drive_letters_are_refused() {
    let case = Case::new("drive.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(err.contains("drive letter"), "{err}");
    assert!(!case.dest().exists());
    #[cfg(windows)]
    assert!(!Path::new(r"C:\Windows\evil.txt").exists());
}

#[test]
fn names_that_collide_on_a_case_insensitive_file_system_are_refused() {
    let case = Case::new("collide.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(err.contains("same file"), "{err}");
    assert!(!case.dest().exists());
}

// ---- Windows-incompatible names: neutralised and reported ----

fn check_sanitised(zip: &str) {
    let case = Case::new(zip);
    let m = &manifest()[zip];
    let summary = case.extract(&[], 1).unwrap();

    let renamed = m["renamed"].as_object().unwrap();
    let mut expected_files: BTreeSet<String> = renamed
        .values()
        .map(|v| v.as_str().unwrap().to_string())
        .collect();
    for name in m["untouched"].as_array().unwrap_or(&Vec::new()) {
        expected_files.insert(name.as_str().unwrap().to_string());
    }
    assert_eq!(files_in(&case.dest()), expected_files);

    // every rename is reported in the summary: nothing is silently renamed
    let reported: std::collections::BTreeMap<_, _> = summary.renames.iter().cloned().collect();
    assert_eq!(reported.len(), renamed.len(), "{reported:?}");
    for (from, to) in renamed {
        assert_eq!(
            reported.get(from).map(String::as_str),
            to.as_str(),
            "{from}"
        );
    }
    // content survived the rename
    for to in renamed.values() {
        assert!(
            std::fs::metadata(case.dest().join(to.as_str().unwrap()))
                .unwrap()
                .len()
                > 0
        );
    }
    case.assert_nothing_escaped();
}

#[test]
fn reserved_windows_device_names_are_renamed_not_opened_as_devices() {
    check_sanitised("reserved.zip");
}

#[test]
fn invalid_characters_and_trailing_dots_are_replaced() {
    check_sanitised("badchars.zip");
}

// ---- corrupt / malicious structure ----

#[test]
fn a_zip_bomb_is_stopped_and_leaves_no_file_behind() {
    let case = Case::new("bomb.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(
        err.contains("bomb.bin") && err.contains("declared"),
        "{err}"
    );
    assert!(
        err.contains("1024"),
        "the message should name the declared size: {err}"
    );

    // Neither the final file nor its .part may survive.
    let files = files_in(&case.dest());
    assert!(
        !files.iter().any(|f| f.starts_with("bomb.bin")),
        "{files:?}"
    );
    // Fatal errors are not retried: probe + tail + a single data request.
    assert_eq!(
        case.server.requests().len(),
        3,
        "{:?}",
        case.server.requests()
    );
    case.assert_nothing_escaped();
}

#[test]
fn a_zip_bomb_is_also_stopped_with_parallel_workers() {
    let case = Case::new("bomb.zip");
    assert!(case.extract(&[], 4).unwrap_err().contains("declared"));
    assert!(
        !files_in(&case.dest())
            .iter()
            .any(|f| f.starts_with("bomb.bin"))
    );
}

#[test]
fn a_wrong_crc_is_detected_and_the_bad_file_never_gets_its_real_name() {
    let case = Case::new("crc.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(
        err.contains("b.txt") && err.contains("CRC-32 mismatch"),
        "{err}"
    );

    let files = files_in(&case.dest());
    assert!(
        files.contains("a.txt"),
        "the file before the bad one was completed: {files:?}"
    );
    assert!(
        !files.contains("b.txt") && !files.iter().any(|f| f.ends_with(".part")),
        "{files:?}"
    );
    assert_eq!(
        case.server.requests().len(),
        3,
        "a CRC error is fatal, not retried"
    );
}

#[test]
fn stored_entry_with_inconsistent_sizes_is_refused() {
    let case = Case::new("bomb_stored.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(
        err.contains("stored entry") && err.contains("differ"),
        "{err}"
    );
    assert!(!case.dest().exists());
}

#[test]
fn an_entry_that_overlaps_the_next_one_is_refused() {
    let case = Case::new("truncated.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(err.contains("overlaps"), "{err}");
    assert!(!case.dest().exists());
}

#[test]
fn two_entries_sharing_one_local_header_are_refused() {
    let case = Case::new("overlap.zip");
    let err = case.extract(&[], 1).unwrap_err();
    assert!(err.contains("share the same data"), "{err}");
    assert!(!case.dest().exists());
}

#[test]
fn encrypted_and_unsupported_entries_fail_clearly_unless_excluded() {
    for (zip, reason) in [
        ("encrypted.zip", "encrypted"),
        ("bzip2.zip", "compression method 12"),
    ] {
        let case = Case::new(zip);
        let err = case.extract(&[], 1).unwrap_err();
        assert!(err.contains(reason), "{zip}: {err}");
        assert!(
            err.contains("--include"),
            "the message should say how to proceed: {err}"
        );
        assert!(!case.dest().exists(), "{zip}: nothing may be written");

        case.extract(&["ok.txt"], 1).unwrap();
        assert_eq!(
            files_in(&case.dest()),
            BTreeSet::from(["ok.txt".to_string()]),
            "{zip}"
        );
    }
}
