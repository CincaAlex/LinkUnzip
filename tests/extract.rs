//! Extraction against real Python-written archives served by the local Range server.
//! Every extracted file is compared by SHA-256 with the hash recorded when the archive was made.

mod common;

use common::server::{Fault, ServerOptions, TestServer};
use common::{assert_tree_matches, fixture, list_files, options};
use linkunzip::extract;

const MIB: u64 = 1 << 20;

#[test]
fn small_archive_single_threaded() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();

    let summary = extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap();

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(summary.files as usize, fx.files.len());
    assert_eq!(summary.dirs as usize, fx.dirs.len());
    assert_eq!(
        summary.extracted_bytes,
        fx.files.iter().map(|f| f.size).sum::<u64>()
    );
    assert_eq!(summary.archive_size, fx.zip_size);
    assert_eq!(summary.retries, 0);
    // The empty folder exists even though nothing is in it, and empty files exist too.
    assert!(out.path().join("empty_dir").is_dir());
    let empty_files: Vec<_> = fx.files.iter().filter(|f| f.size == 0).collect();
    assert!(
        !empty_files.is_empty(),
        "the fixture should contain empty files"
    );
    for f in empty_files {
        assert_eq!(
            std::fs::metadata(out.path().join(&f.name)).unwrap().len(),
            0,
            "{}",
            f.name
        );
    }
}

#[test]
fn unicode_and_cp437_names_land_on_disk_correctly() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap();
    for name in [
        "legacy/café_cp437.txt",
        "unicode/日本語/ファイル.txt",
        "unicode/emoji_😀_file.txt",
        "unicode/Привет мир.txt",
    ] {
        assert!(out.path().join(name).is_file(), "{name} missing");
    }
}

#[test]
fn archive_written_with_data_descriptors_and_local_only_zip64_extras() {
    // Local headers have zero sizes (data descriptor) and a different extra-field length than the
    // central directory, which is why the extractor takes sizes from the central directory only.
    let fx = fixture("streamed");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap();
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn one_range_request_per_span_not_per_file() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap();

    // probe + tail (index) + exactly one request for all 203 files
    let requests = server.requests();
    assert_eq!(requests.len(), 3, "{requests:?}");
    let (start, end) = requests[2].range.unwrap();
    let first_file = fx.files.iter().map(|f| f.header_offset).min().unwrap();
    assert_eq!(
        start, first_file,
        "the data request starts at the first file's local header"
    );
    assert!(end - start + 1 > 9 * MIB, "and covers the whole data area");
}

#[test]
fn downloaded_and_requests_include_the_index_reads() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let summary = extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["stored/README*"],
        1,
    ))
    .unwrap();

    // Everything the server sent, in as many requests as it saw.
    let log = server.requests();
    assert_eq!(summary.requests, log.len() as u64, "{log:?}");
    let sent = |r: &common::server::RequestLog| r.range.map_or(0, |(s, e)| e - s + 1);
    let index: u64 = log.iter().take(2).map(sent).sum(); // probe + tail
    assert!(summary.index_bytes > 0);
    assert_eq!(summary.index_bytes, index, "{log:?}");
    assert!(summary.downloaded_bytes >= summary.index_bytes);
    let readme = fx
        .files
        .iter()
        .find(|f| f.name == "stored/README_stored.txt")
        .unwrap();
    assert_eq!(
        summary.downloaded_bytes,
        summary.index_bytes + readme.compressed_size,
        "index + the one file's data"
    );
    assert_eq!(summary.verified_files, 1);

    let text = linkunzip::ui::render_summary(&summary);
    assert!(text.contains("(index "), "{text}");
    assert!(text.contains(" + files "), "{text}");
    assert!(text.contains("all 1 files verified OK"), "{text}");
}

// ---- parallel spans ----

/// The Range requests after the two index requests (probe + tail), sorted by start.
fn data_ranges(server: &TestServer) -> Vec<(u64, u64)> {
    let mut ranges: Vec<_> = server
        .requests()
        .iter()
        .skip(2)
        .filter_map(|r| r.range)
        .collect();
    ranges.sort();
    ranges
}

#[test]
fn parallel_jobs_extract_identical_results_with_disjoint_spans() {
    let fx = fixture("small");
    for jobs in [2, 3, 4, 8] {
        let server = TestServer::start(&fx.dir, ServerOptions::default());
        let out = tempfile::tempdir().unwrap();

        let summary = extract::run(&options(
            server.url_for(&fx.zip_name),
            out.path(),
            &[],
            jobs,
        ))
        .unwrap();

        assert_tree_matches(out.path(), &fx, |_| true, |_| true);
        assert_eq!(summary.files as usize, fx.files.len(), "jobs={jobs}");

        let ranges = data_ranges(&server);
        assert!(
            ranges.len() >= 2 && ranges.len() <= jobs,
            "jobs={jobs}: {ranges:?}"
        );
        assert_eq!(summary.spans, ranges.len());
        for pair in ranges.windows(2) {
            assert!(pair[0].1 < pair[1].0, "spans overlap: {ranges:?}");
        }
    }
}

#[test]
fn parallel_extraction_of_a_streamed_archive() {
    let fx = fixture("streamed");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 4)).unwrap();
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn more_jobs_than_spans_is_fine() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    // Only a few KB are selected, so there is a single span; 16 requested workers must not matter.
    extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["stored/README*"],
        16,
    ))
    .unwrap();
    assert_tree_matches(
        out.path(),
        &fx,
        |n| n == "stored/README_stored.txt",
        |_| false,
    );
    assert_eq!(data_ranges(&server).len(), 1);
}

// ---- retries ----

/// A fault that cuts the connection 1 MiB into the data of `big/large_random.bin` (3 MiB of
/// incompressible data, so definitely "mid-file"). Returns the fault and that file's header offset.
fn fault_inside_big_file(fx: &common::Fixture, times: usize) -> (Fault, u64) {
    let target = fx
        .files
        .iter()
        .find(|f| f.name == "big/large_random.bin")
        .unwrap();
    (
        Fault {
            cut_at_offset: target.header_offset + MIB,
            times,
        },
        target.header_offset,
    )
}

#[test]
fn a_dropped_connection_mid_file_is_retried_from_the_start_of_that_file() {
    let fx = fixture("small");
    let (fault, target_offset) = fault_inside_big_file(&fx, 1);
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            fault: Some(fault),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();

    let summary = extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap();

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(summary.retries, 1);

    let data: Vec<_> = server.requests().into_iter().skip(2).collect(); // after probe + tail
    assert_eq!(data.len(), 2, "{data:?}");
    assert!(data[0].faulted && !data[1].faulted);
    assert_eq!(
        data[1].range.unwrap().0,
        target_offset,
        "the retry must restart at the interrupted file: not at the span start (redoing finished files) and not after it"
    );

    // The abandoned attempt is not double-counted in the progress numbers.
    assert_eq!(
        summary.downloaded_bytes - summary.index_bytes,
        fx.files.iter().map(|f| f.compressed_size).sum::<u64>()
    );
    assert_eq!(
        summary.extracted_bytes,
        fx.files.iter().map(|f| f.size).sum::<u64>()
    );
}

#[test]
fn retries_work_with_parallel_workers_too() {
    let fx = fixture("small");
    let (fault, _) = fault_inside_big_file(&fx, 1);
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            fault: Some(fault),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let summary = extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 4)).unwrap();
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(summary.retries, 1);
    assert_eq!(
        summary.extracted_bytes,
        fx.files.iter().map(|f| f.size).sum::<u64>()
    );
}

#[test]
fn a_persistently_failing_file_is_abandoned_after_five_attempts() {
    let fx = fixture("small");
    let (fault, target_offset) = fault_inside_big_file(&fx, 100);
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            fault: Some(fault),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();

    let err = extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 1)).unwrap_err();
    let text = format!("{err:#}");
    assert!(text.contains("big/large_random.bin"), "{text}");
    assert!(text.contains("after 5 attempts"), "{text}");

    // 1 original request + 4 retries, every one cut; the retries all start at the failing file.
    let data: Vec<_> = server.requests().into_iter().skip(2).collect();
    assert_eq!(data.len(), 5, "{data:?}");
    assert!(data.iter().all(|r| r.faulted));
    assert!(
        data[1..]
            .iter()
            .all(|r| r.range.unwrap().0 == target_offset)
    );

    // Files that were completed before the failure stay; the failing one leaves no trace.
    let files = list_files(out.path());
    assert!(
        files.contains("docs/2022/q1/report_000.txt"),
        "earlier files are kept"
    );
    assert!(!files.contains("big/large_random.bin"));
    assert!(
        !files.iter().any(|f| f.ends_with(".part")),
        "no .part leftovers: {files:?}"
    );
}

#[test]
fn include_extracts_only_matching_files_and_skips_the_rest_of_the_download() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();

    let summary = extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["*.csv"],
        1,
    ))
    .unwrap();

    assert_tree_matches(out.path(), &fx, |n| n.ends_with(".csv"), |_| false);
    assert_eq!(
        summary.files as usize,
        fx.files.iter().filter(|f| f.name.ends_with(".csv")).count()
    );
    // Only the span up to the last CSV is requested: the 5 MiB of random/stored blobs after it are never fetched.
    assert!(
        server.bytes_requested() < fx.zip_size - 4 * MIB,
        "requested {} bytes of a {} byte archive",
        server.bytes_requested(),
        fx.zip_size
    );
}

#[test]
fn include_can_be_repeated_and_selects_folders() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["unicode/*", "stored/*"],
        1,
    ))
    .unwrap();
    assert_tree_matches(
        out.path(),
        &fx,
        |n| n.starts_with("unicode/") || n.starts_with("stored/"),
        |_| false,
    );
}

#[test]
fn include_matching_nothing_fails_without_writing() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let err = extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["*.nothing"],
        1,
    ))
    .unwrap_err();
    assert!(err.to_string().contains("no entries"), "{err:#}");
    assert!(list_files(out.path()).is_empty());
}

#[test]
fn existing_files_are_replaced() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(out.path().join("stored")).unwrap();
    std::fs::write(out.path().join("stored/README_stored.txt"), "old content").unwrap();
    extract::run(&options(
        server.url_for(&fx.zip_name),
        out.path(),
        &["stored/*"],
        1,
    ))
    .unwrap();
    assert_tree_matches(out.path(), &fx, |n| n.starts_with("stored/"), |_| false);
}

#[test]
fn the_command_line_tool_works_end_to_end() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();

    let result = std::process::Command::new(env!("CARGO_BIN_EXE_linkunzip"))
        .arg("extract")
        .arg(server.url_for(&fx.zip_name))
        .arg("-o")
        .arg(out.path())
        .args(["--jobs", "1"])
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    let stdout = String::from_utf8_lossy(&result.stdout);
    assert!(
        stdout.contains("Downloaded ") && stdout.contains("(index ") && stdout.contains("requests"),
        "{stdout}"
    );

    // And a failure exits non-zero with a readable message.
    let bad = std::process::Command::new(env!("CARGO_BIN_EXE_linkunzip"))
        .arg("extract")
        .arg(server.url_for("missing.zip"))
        .arg("-o")
        .arg(out.path())
        .output()
        .unwrap();
    assert!(!bad.status.success());
    let stderr = String::from_utf8_lossy(&bad.stderr);
    assert!(stderr.contains("404"), "{stderr}");
    // The same plain-English message the browser shows, the technical details, and a hint.
    assert!(
        stderr.contains("error: The file is gone from the server (HTTP 404 Not Found)."),
        "{stderr}"
    );
    assert!(stderr.contains("details: "), "{stderr}");
    assert!(stderr.contains("hint: "), "{stderr}");
}
