//! Probing a server, reading the index over HTTP Range requests, and `inspect`.

mod common;

use std::collections::HashMap;
use std::time::Duration;

use common::server::{ServerOptions, TestServer};
use linkunzip::error::{Described, ErrorCode, RetryPolicy, describe};
use linkunzip::http::Source;
use linkunzip::inspect;
use linkunzip::zip::index::read_index;

/// Fast retries so failure tests don't sit in backoff sleeps.
fn quick() -> RetryPolicy {
    RetryPolicy {
        max_attempts: 3,
        base_delay: Duration::from_millis(5),
    }
}

#[test]
fn probe_reports_size_and_validators() {
    let fx = common::fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let src = Source::probe(&server.url_for(&fx.zip_name), quick()).unwrap();
    assert_eq!(src.size, fx.zip_size);
    assert!(src.etag.is_some() && src.last_modified.is_some());
    // The probe itself must be a one-byte range request.
    let log = server.requests();
    assert_eq!(log.len(), 1);
    assert_eq!((log[0].range, log[0].status), (Some((0, 0)), 206));
}

fn check_index(kind: &str, expected_requests: usize) {
    let fx = common::fixture(kind);
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let src = Source::probe(&server.url_for(&fx.zip_name), quick()).unwrap();
    let index = read_index(&src).unwrap();
    let entries = index.entries;
    // Every byte and request spent on the index is counted.
    assert_eq!(src.index_requests(), expected_requests as u64);
    assert_eq!(src.index_bytes(), server.bytes_requested());

    assert_eq!(entries.len(), fx.files.len() + fx.dirs.len());
    let by_name: HashMap<_, _> = entries.iter().map(|e| (e.name.as_str(), e)).collect();
    for f in &fx.files {
        let e = by_name[f.name.as_str()];
        assert_eq!(
            (
                e.uncompressed_size,
                e.compressed_size,
                e.crc32,
                e.method,
                e.local_header_offset
            ),
            (
                f.size,
                f.compressed_size,
                f.crc32,
                f.method,
                f.header_offset
            ),
            "{}",
            f.name
        );
    }
    // The whole point: the index costs a handful of tiny requests, never a download.
    let requests = server.requests();
    assert_eq!(
        requests.len(),
        expected_requests,
        "requests made: {requests:?}"
    );
    assert!(requests.iter().all(|r| r.status == 206));
    assert!(
        server.bytes_requested() < 8 * 1024 * 1024,
        "index should not need much data"
    );
}

#[test]
fn small_archive_index_costs_two_requests() {
    // probe + the tail; the central directory is small enough to be inside the tail already.
    check_index("small", 2);
}

#[test]
fn streamed_archive_index_costs_two_requests() {
    check_index("streamed", 2);
}

#[test]
fn zip64_archive_index_is_read_with_one_extra_request_for_the_directory() {
    // probe + tail (EOCD, ZIP64 locator and ZIP64 record) + the central directory (~5 MB, too big for the tail).
    check_index("many", 3);
}

#[test]
fn server_without_range_support_is_rejected_with_a_clear_message() {
    let fx = common::fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    let err = Source::probe(&server.url_for(&fx.zip_name), quick())
        .err()
        .expect("must fail")
        .to_string();
    assert!(err.contains("Range"), "{err}");
    assert!(err.contains("200"), "{err}");
}

#[test]
fn missing_file_is_a_clear_error_and_is_not_retried() {
    let fx = common::fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let err = Source::probe(&server.url_for("nope.zip"), quick())
        .err()
        .unwrap()
        .to_string();
    assert!(err.contains("404"), "{err}");
    assert_eq!(server.requests().len(), 1, "a 404 is fatal, so no retries");
}

#[test]
fn connection_refused_is_retried_then_reported() {
    // Nothing listens on port 9 of localhost.
    let err = Source::probe("http://127.0.0.1:9/a.zip", quick())
        .err()
        .unwrap();
    let text = format!("{err:#}");
    assert!(text.contains("giving up after 3 attempts"), "{text}");
}

#[test]
fn a_file_that_is_not_a_zip_is_reported_as_such() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("notes.txt"),
        "just some text, definitely not a zip file. ".repeat(10),
    )
    .unwrap();
    let server = TestServer::start(dir.path(), ServerOptions::default());
    let src = Source::probe(&server.url_for("notes.txt"), quick()).unwrap();
    let err = format!("{:#}", read_index(&src).unwrap_err());
    assert!(err.contains("does not look like a ZIP"), "{err}");
}

#[test]
fn a_file_that_changes_during_the_run_is_detected_via_etag() {
    let fx = common::fixture("small");
    // Request #1 (the probe) sees ETag v1; everything after sees v2.
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            change_etag_after: Some(1),
            ..Default::default()
        },
    );
    let src = Source::probe(&server.url_for(&fx.zip_name), quick()).unwrap();
    let err = format!("{:#}", read_index(&src).unwrap_err());
    assert!(err.contains("changed on the server"), "{err}");
}

// ---- error codes: what the browser extension is told ----

/// Inspect `url` and return the failure as the extension would see it.
fn failure(url: &str) -> Described {
    let out = tempfile::tempdir().unwrap();
    let err = inspect::inspect(url, out.path(), quick())
        .err()
        .expect("inspect should fail");
    describe(&err, linkunzip::http::host_of(url).as_deref())
}

fn status_server(code: u16) -> (tempfile::TempDir, TestServer) {
    let dir = tempfile::tempdir().unwrap();
    let server = TestServer::start(
        dir.path(),
        ServerOptions {
            status: Some(code),
            ..Default::default()
        },
    );
    (dir, server)
}

const SIGNED: &str = "a.zip?X-Amz-Credential=k&X-Amz-Expires=60&X-Amz-Signature=abc";

#[test]
fn http_statuses_get_their_codes() {
    for (status, path, code) in [
        (401, "a.zip", ErrorCode::NeedsLogin),
        (403, "a.zip", ErrorCode::NeedsLogin),
        (403, SIGNED, ErrorCode::LinkExpired),
        (400, SIGNED, ErrorCode::LinkExpired),
        (404, "a.zip", ErrorCode::NotFound),
        (410, "a.zip", ErrorCode::NotFound),
        (410, SIGNED, ErrorCode::LinkExpired),
        (500, "a.zip", ErrorCode::ServerError),
        (503, "a.zip", ErrorCode::ServerError),
    ] {
        let (_dir, server) = status_server(status);
        let d = failure(&server.url_for(path));
        assert_eq!(d.code, code, "{status} {path}: {d:?}");
        assert_eq!(d.http_status, Some(status), "{status} {path}");
        assert!(d.detail.contains(&status.to_string()), "{d:?}");
        // A status answer is final for the probe: no retry loop on top.
        assert_eq!(server.requests().len(), 1, "{status} {path}");
    }
}

#[test]
fn messages_are_plain_english_and_name_the_host() {
    let (_dir, server) = status_server(401);
    let d = failure(&server.url_for("a.zip"));
    assert!(d.message.contains("127.0.0.1"), "{d:?}");
    assert!(d.message.contains("signed in"), "{d:?}");

    let (_dir, server) = status_server(404);
    let d = failure(&server.url_for("a.zip"));
    assert_eq!(
        d.message,
        "The file is gone from the server (HTTP 404 Not Found)."
    );
    assert!(d.code.cli_hint().is_some());
}

/// A folder serving a sign-in page as `login.zip`.
fn login_page() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("login.zip"),
        "\n  <!DOCTYPE html><html><body><form>Please sign in</form></body></html>",
    )
    .unwrap();
    dir
}

#[test]
fn a_web_page_is_html_page_with_or_without_range_support() {
    let dir = login_page();
    for (support_range, content_type, status) in [
        (false, Some("text/html; charset=utf-8"), 200),
        (false, None, 200),
        (true, Some("text/html"), 206),
        (true, None, 206),
    ] {
        let server = TestServer::start(
            dir.path(),
            ServerOptions {
                support_range,
                content_type: content_type.map(str::to_string),
                ..Default::default()
            },
        );
        let d = failure(&server.url_for("login.zip"));
        assert_eq!(
            d.code,
            ErrorCode::HtmlPage,
            "range={support_range} type={content_type:?}: {d:?}"
        );
        assert_eq!(d.http_status, Some(status));
        assert!(d.message.contains("web page"), "{d:?}");
    }
}

#[test]
fn a_zip_served_as_text_html_is_still_a_zip() {
    // Misconfigured servers (PHP download scripts) send zips as text/html.
    let fx = common::fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            content_type: Some("text/html".into()),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let report = inspect::inspect(&server.url_for(&fx.zip_name), out.path(), quick()).unwrap();
    assert_eq!(report.totals.files as usize, fx.files.len());

    // Without Range support it is a zip that has to be streamed, not a web page.
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            content_type: Some("text/html".into()),
            support_range: false,
            ..Default::default()
        },
    );
    assert_eq!(
        failure(&server.url_for(&fx.zip_name)).code,
        ErrorCode::NoRange
    );
}

#[test]
fn other_failures_get_their_codes() {
    // A zip without Range support.
    let fx = common::fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    assert_eq!(
        failure(&server.url_for(&fx.zip_name)).code,
        ErrorCode::NoRange
    );

    // A file that is not a zip (served with Range support).
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("notes.txt"),
        "plain text, not a zip. ".repeat(20),
    )
    .unwrap();
    let server = TestServer::start(dir.path(), ServerOptions::default());
    let d = failure(&server.url_for("notes.txt"));
    assert_eq!(d.code, ErrorCode::NotZip, "{d:?}");
    assert_eq!(d.message, "This file isn't a ZIP archive.");

    // Nothing listening: the network, after the retries.
    let d = failure("http://127.0.0.1:9/a.zip");
    assert_eq!(d.code, ErrorCode::Network, "{d:?}");
    assert!(d.message.contains("Can't reach 127.0.0.1"), "{d:?}");
    assert!(d.detail.contains("giving up after 3 attempts"), "{d:?}");

    // Not a URL we can use.
    assert_eq!(
        failure("ftp://example.com/a.zip").code,
        ErrorCode::BadRequest
    );
}

#[test]
fn inspect_report_has_the_numbers_the_demo_needs() {
    let fx = common::fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let report = inspect::inspect(&server.url_for(&fx.zip_name), out.path(), quick()).unwrap();

    let extracted: u64 = fx.files.iter().map(|f| f.size).sum();
    let compressed: u64 = fx.files.iter().map(|f| f.compressed_size).sum();
    assert_eq!(report.totals.files as usize, fx.files.len());
    assert_eq!(report.totals.dirs as usize, fx.dirs.len());
    assert_eq!(report.totals.extracted, extracted);
    assert_eq!(report.totals.compressed, compressed);
    assert!(report.totals.unsupported.is_empty());
    assert_eq!(report.archive_size, fx.zip_size);
    assert_eq!(report.linkunzip_needs(), extracted);
    assert_eq!(report.normal_needs(), extracted + fx.zip_size);
    assert!(report.free.unwrap() > 0);
    assert_eq!(report.index_bytes, server.bytes_requested());
    assert_eq!(report.index_requests, 2);
    assert!(report.totals.folders >= report.totals.dirs);

    let text = report.render(true);
    assert!(text.contains("Normal download + extract needs"), "{text}");
    assert!(text.contains("LinkUnzip needs"), "{text}");
    assert!(
        text.contains("café_cp437.txt"),
        "--list should show entries"
    );
}
