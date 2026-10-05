//! Resume: running the same link into the same folder again downloads only what is missing or
//! wrong, in Range mode (journal or CRC check) and in stream mode (comparing as the bytes pass).

mod common;

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use common::server::{RequestLog, ServerOptions, TestServer};
use common::{Fixture, assert_tree_matches, fixture, list_files, options};
use linkunzip::extract::{self, ExtractOptions, Summary};
use linkunzip::resume::JOURNAL_NAME;
use linkunzip::stats::Stats;

fn run(
    server: &TestServer,
    fx: &Fixture,
    out: &Path,
    tweak: impl FnOnce(&mut ExtractOptions),
) -> Summary {
    let mut opts = options(server.url_for(&fx.zip_name), out, &[], 2);
    tweak(&mut opts);
    extract::run(&opts).unwrap_or_else(|e| panic!("{e:#}"))
}

fn compressed(fx: &Fixture, names: &[&str]) -> u64 {
    fx.files
        .iter()
        .filter(|f| names.contains(&f.name.as_str()))
        .map(|f| f.compressed_size)
        .sum()
}

/// The data requests of a Range-mode run (after the probe and the tail of the "small" fixture).
fn data_requests(server: &TestServer) -> Vec<RequestLog> {
    server.requests().into_iter().skip(2).collect()
}

/// Damage the extracted tree the ways an interrupted or meddled-with folder can look.
const DELETED: [&str; 2] = ["docs/2022/q1/report_000.txt", "big/large_random.bin"];
const TRUNCATED: &str = "unicode/日本語/ファイル.txt";
const CORRUPTED: &str = "stored/README_stored.txt";
const WITH_STALE_PART: &str = "legacy/café_cp437.txt";

fn damage(out: &Path) {
    for name in DELETED {
        std::fs::remove_file(out.join(name)).unwrap();
    }
    let truncated = out.join(TRUNCATED);
    let len = std::fs::metadata(&truncated).unwrap().len();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&truncated)
        .unwrap()
        .set_len(len / 2)
        .unwrap();
    // Same size, one byte different: only the CRC-32 can tell.
    let corrupted = out.join(CORRUPTED);
    let mut bytes = std::fs::read(&corrupted).unwrap();
    bytes[3] ^= 0x55;
    std::fs::write(&corrupted, bytes).unwrap();
    std::fs::write(out.join(format!("{WITH_STALE_PART}.part")), b"left over").unwrap();
}

#[test]
fn a_rerun_downloads_only_what_is_missing_or_wrong() {
    let fx = fixture("small");
    let out = tempfile::tempdir().unwrap();
    let first_server = TestServer::start(&fx.dir, ServerOptions::default());
    let first = run(&first_server, &fx, out.path(), |_| {});
    assert_eq!(first.files as usize, fx.files.len());
    assert_eq!(first.skipped_files, 0);
    assert!(
        !out.path().join(JOURNAL_NAME).exists(),
        "the journal is deleted after a successful run"
    );

    damage(out.path());
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let second = run(&server, &fx, out.path(), |_| {});

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    let redone = [DELETED[0], DELETED[1], TRUNCATED, CORRUPTED];
    assert_eq!(second.files, redone.len() as u64, "{second:?}");
    assert_eq!(second.skipped_files as usize, fx.files.len() - redone.len());
    assert_eq!(second.verified_files as usize, fx.files.len());
    let skipped_bytes: u64 = fx
        .files
        .iter()
        .filter(|f| !redone.contains(&f.name.as_str()))
        .map(|f| f.size)
        .sum();
    assert_eq!(second.skipped_bytes, skipped_bytes);
    // Only the four files' data came over the network ...
    assert_eq!(
        second.downloaded_bytes - second.index_bytes,
        compressed(&fx, &redone)
    );
    // ... and every data request was for one of them, never only for files that were fine.
    let wanted: Vec<u64> = fx
        .files
        .iter()
        .filter(|f| redone.contains(&f.name.as_str()))
        .map(|f| f.header_offset)
        .collect();
    let data = data_requests(&server);
    assert!(!data.is_empty());
    for r in &data {
        let (start, end) = r.range.unwrap();
        assert!(
            wanted.iter().any(|&o| (start..=end).contains(&o)),
            "a request for nothing that was needed: {r:?}"
        );
    }
    assert!(server.bytes_requested() < fx.zip_size, "{data:?}");
    assert!(!out.path().join(JOURNAL_NAME).exists());
}

#[test]
fn a_folder_that_is_complete_costs_only_the_index() {
    let fx = fixture("small");
    let out = tempfile::tempdir().unwrap();
    run(
        &TestServer::start(&fx.dir, ServerOptions::default()),
        &fx,
        out.path(),
        |_| {},
    );

    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let again = run(&server, &fx, out.path(), |_| {});
    assert_eq!(again.files, 0);
    assert_eq!(again.skipped_files as usize, fx.files.len());
    assert_eq!(again.downloaded_bytes, again.index_bytes);
    assert_eq!(server.requests().len(), 2, "probe + tail, no data");
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn overwrite_extracts_everything_again() {
    let fx = fixture("small");
    let out = tempfile::tempdir().unwrap();
    run(
        &TestServer::start(&fx.dir, ServerOptions::default()),
        &fx,
        out.path(),
        |_| {},
    );

    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let again = run(&server, &fx, out.path(), |o| o.resume = false);
    assert_eq!(again.files as usize, fx.files.len());
    assert_eq!(again.skipped_files, 0);
    assert_eq!(
        again.downloaded_bytes - again.index_bytes,
        fx.files.iter().map(|f| f.compressed_size).sum::<u64>()
    );
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn a_cancelled_run_resumes_to_a_correct_tree_using_its_journal() {
    let fx = fixture("small");
    let out = tempfile::tempdir().unwrap();
    let slow = TestServer::start(
        &fx.dir,
        ServerOptions {
            chunk_delay_ms: 30,
            ..Default::default()
        },
    );
    // Stop as soon as a few files are done.
    let cancel = Arc::new(AtomicBool::new(false));
    let mut opts = options(slow.url_for(&fx.zip_name), out.path(), &[], 1);
    opts.cancel = Some(cancel.clone());
    let flag = cancel.clone();
    opts.on_progress = Some(Arc::new(move |s: &Stats| {
        if s.files_done() >= 5 {
            flag.store(true, Ordering::SeqCst);
        }
    }));
    assert!(extract::run(&opts).is_err(), "the run was cancelled");
    let finished = list_files(out.path())
        .into_iter()
        .filter(|f| !f.ends_with(".part") && f != JOURNAL_NAME)
        .count();
    assert!(finished >= 5, "{finished}");
    assert!(
        finished < fx.files.len(),
        "cancelled too late to test anything"
    );
    let journal = std::fs::read_to_string(out.path().join(JOURNAL_NAME)).unwrap();
    assert!(
        journal.lines().count() > finished,
        "identity + one line per finished file:\n{journal}"
    );

    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let resumed = run(&server, &fx, out.path(), |_| {});
    assert_eq!(resumed.skipped_files as usize, finished);
    assert_eq!(resumed.files as usize, fx.files.len() - finished);
    // The journal is gone, so the tree comparison does not see it.
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn an_entry_named_like_the_journal_cannot_overwrite_it() {
    // The resume journal's name is reserved; such an entry is renamed like a reserved device name.
    let safe = linkunzip::safety::sanitize_entry_name(JOURNAL_NAME).unwrap();
    assert!(safe.changed);
    assert_ne!(safe.path.to_str().unwrap(), JOURNAL_NAME);
}

#[test]
fn the_command_line_resumes_by_default_and_overwrite_turns_it_off() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let cli = |extra: &[&str]| {
        let result = std::process::Command::new(env!("CARGO_BIN_EXE_linkunzip"))
            .arg("extract")
            .arg(server.url_for(&fx.zip_name))
            .arg("-o")
            .arg(out.path())
            .args(extra)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        String::from_utf8_lossy(&result.stdout).into_owned()
    };
    let first = cli(&[]);
    assert!(!first.contains("Skipped"), "{first}");
    let second = cli(&[]);
    assert!(
        second.contains(&format!(
            "Skipped              {} files already in the folder (verified)",
            fx.files.len()
        )),
        "{second}"
    );
    let third = cli(&["--overwrite"]);
    assert!(!third.contains("Skipped"), "{third}");
    assert!(
        third.contains(&format!("Files extracted      {}", fx.files.len())),
        "{third}"
    );
}

// ---- stream mode ----

fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path).unwrap().modified().unwrap()
}

#[test]
fn stream_mode_never_rewrites_a_file_that_is_already_correct() {
    for kind in ["small", "streamed"] {
        let fx = fixture(kind);
        let server = TestServer::start(
            &fx.dir,
            ServerOptions {
                support_range: false,
                ..Default::default()
            },
        );
        let out = tempfile::tempdir().unwrap();
        let mut opts = options(server.url_for(&fx.zip_name), out.path(), &[], 1);
        opts.stream = true;
        extract::run(&opts).unwrap();

        // Damage two files and remember when an untouched one was written.
        let names: Vec<&str> = fx.files.iter().map(|f| f.name.as_str()).collect();
        let (gone, changed, kept) = (names[0], names[names.len() / 2], names[names.len() - 1]);
        std::fs::remove_file(out.path().join(gone)).unwrap();
        let mut bytes = std::fs::read(out.path().join(changed)).unwrap();
        if bytes.is_empty() {
            bytes.push(1);
        } else {
            bytes[0] ^= 0xFF;
        }
        std::fs::write(out.path().join(changed), bytes).unwrap();
        std::fs::write(out.path().join(format!("{kept}.part")), b"stale").unwrap();
        let kept_time = modified(&out.path().join(kept));
        std::thread::sleep(std::time::Duration::from_millis(50));

        let again = extract::run(&opts).unwrap();
        assert_tree_matches(out.path(), &fx, |_| true, |_| true);
        assert_eq!(again.files, 2, "{kind}: {again:?}");
        assert_eq!(again.skipped_files as usize, fx.files.len() - 2, "{kind}");
        assert_eq!(again.verified_files as usize, fx.files.len(), "{kind}");
        assert_eq!(
            modified(&out.path().join(kept)),
            kept_time,
            "{kind}: an identical file was rewritten"
        );

        // --overwrite: everything is written again.
        opts.resume = false;
        let all = extract::run(&opts).unwrap();
        assert_eq!((all.files as usize, all.skipped_files), (fx.files.len(), 0));
        assert!(modified(&out.path().join(kept)) > kept_time, "{kind}");
    }
}
