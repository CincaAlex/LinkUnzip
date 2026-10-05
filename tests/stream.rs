//! Sequential mode (`--stream`): servers without Range support, archives written in streaming
//! style (data descriptors), connections that drop, hostile archives, cancellation.

mod common;

use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use common::server::{Fault, ServerOptions, TestServer};
use common::{assert_tree_matches, fixture, list_files, malicious_dir, options};
use linkunzip::extract::{self, ExtractOptions, Summary};

/// A server that, like GitHub's "Download ZIP", only ever sends the whole file.
fn no_range() -> ServerOptions {
    ServerOptions {
        support_range: false,
        ..Default::default()
    }
}

fn stream_options(url: String, out: &std::path::Path, include: &[&str]) -> ExtractOptions {
    let mut opts = options(url, out, include, 1);
    opts.stream = true;
    opts
}

fn run_stream(
    server: &TestServer,
    zip: &str,
    out: &std::path::Path,
    include: &[&str],
) -> Result<Summary, String> {
    extract::run(&stream_options(server.url_for(zip), out, include)).map_err(|e| format!("{e:#}"))
}

#[test]
fn a_plain_archive_is_extracted_in_one_pass() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, no_range());
    let out = tempfile::tempdir().unwrap();

    let summary = run_stream(&server, &fx.zip_name, out.path(), &[]).unwrap();

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(summary.files as usize, fx.files.len());
    assert_eq!(summary.zip_bytes_on_disk, 0);
    assert_eq!(summary.requests, 1, "one connection, start to finish");
    assert_eq!(summary.archive_size, fx.zip_size);
    assert_eq!(server.requests().len(), 1);
    assert!(server.requests()[0].range.is_none());
}

#[test]
fn archives_written_in_streaming_style_are_extracted() {
    // Every entry has a data descriptor (sizes come *after* the data) and some carry a ZIP64
    // extra field in the local header: exactly what git/GitHub, Java and `zip -fd` produce.
    let fx = fixture("streamed");
    let server = TestServer::start(&fx.dir, no_range());
    let out = tempfile::tempdir().unwrap();

    let summary = run_stream(&server, &fx.zip_name, out.path(), &[]).unwrap();

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(summary.files as usize, fx.files.len());
}

#[test]
fn include_patterns_skip_the_other_entries() {
    for kind in ["small", "streamed"] {
        let fx = fixture(kind);
        let server = TestServer::start(&fx.dir, no_range());
        let out = tempfile::tempdir().unwrap();

        let summary = run_stream(&server, &fx.zip_name, out.path(), &["unicode/*"]).unwrap();

        assert_tree_matches(out.path(), &fx, |n| n.starts_with("unicode/"), |_| false);
        let expected = fx
            .files
            .iter()
            .filter(|f| f.name.starts_with("unicode/"))
            .count();
        assert!(expected > 0);
        assert_eq!(summary.files as usize, expected, "{kind}");
    }
}

#[test]
fn a_pattern_matching_nothing_is_an_error() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, no_range());
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, &fx.zip_name, out.path(), &["*.does-not-exist"]).unwrap_err();
    assert!(err.contains("match --include"), "{err}");
}

#[test]
fn a_dropped_connection_restarts_and_keeps_finished_files() {
    for kind in ["small", "streamed"] {
        let fx = fixture(kind);
        let server = TestServer::start(
            &fx.dir,
            ServerOptions {
                support_range: false,
                fault: Some(Fault {
                    cut_at_offset: fx.zip_size / 2,
                    times: 1,
                }),
                ..Default::default()
            },
        );
        let out = tempfile::tempdir().unwrap();

        let summary = run_stream(&server, &fx.zip_name, out.path(), &[]).unwrap();

        assert_tree_matches(out.path(), &fx, |_| true, |_| true);
        assert_eq!(summary.retries, 1, "{kind}");
        assert_eq!(summary.requests, 2, "{kind}");
        assert_eq!(
            summary.extracted_bytes,
            fx.files.iter().map(|f| f.size).sum::<u64>(),
            "{kind}: the rolled-back entry must not be counted twice"
        );
        assert!(server.requests().iter().any(|r| r.faulted));
    }
}

#[test]
fn a_connection_that_keeps_dropping_ends_in_an_error_and_no_part_files() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            fault: Some(Fault {
                cut_at_offset: fx.zip_size / 2,
                times: 50,
            }),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, &fx.zip_name, out.path(), &[]).unwrap_err();
    assert!(err.contains("after 5 attempts"), "{err}");
    assert!(list_files(out.path()).iter().all(|f| !f.ends_with(".part")));
}

#[test]
fn a_file_that_changes_between_attempts_is_refused() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            fault: Some(Fault {
                cut_at_offset: fx.zip_size / 2,
                times: 1,
            }),
            change_etag_after: Some(1),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, &fx.zip_name, out.path(), &[]).unwrap_err();
    assert!(err.contains("changed on the server"), "{err}");
}

#[test]
fn cancelling_stops_quickly_and_leaves_no_part_files() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            chunk_delay_ms: 40,
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let mut opts = stream_options(server.url_for(&fx.zip_name), out.path(), &[]);
    opts.cancel = Some(cancel.clone());

    let flag = cancel.clone();
    let stopper = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        flag.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let result = extract::run(&opts);
    stopper.join().unwrap();

    assert!(result.is_err(), "the extraction should have been cancelled");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "took {:?}",
        started.elapsed()
    );
    assert!(list_files(out.path()).iter().all(|f| !f.ends_with(".part")));
}

// ---- hostile and broken input: the same refusals as the Range mode, noticed as entries arrive ----

fn malicious() -> (TestServer, tempfile::TempDir) {
    (
        TestServer::start(&malicious_dir(), no_range()),
        tempfile::tempdir().unwrap(),
    )
}

/// Extract into `<tmp>/dest` so that `../` escapes would land inside `<tmp>`, where we can see them.
fn extract_hostile(zip: &str, include: &[&str]) -> (Result<Summary, String>, tempfile::TempDir) {
    let (server, base) = malicious();
    let result = run_stream(&server, zip, &base.path().join("dest"), include);
    (result, base)
}

fn assert_nothing_escaped(base: &tempfile::TempDir) {
    let siblings: BTreeSet<String> = std::fs::read_dir(base.path())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        siblings.iter().all(|n| n == "dest"),
        "files escaped: {siblings:?}"
    );
    for evil in ["evil.txt", "evil2.txt"] {
        assert!(
            !base.path().parent().unwrap().join(evil).exists(),
            "{evil} escaped"
        );
    }
}

#[test]
fn path_traversal_is_refused() {
    let (result, base) = extract_hostile("zipslip.zip", &[]);
    let err = result.unwrap_err();
    assert!(
        err.contains("../evil.txt") && err.contains("traversal"),
        "{err}"
    );
    assert_nothing_escaped(&base);
}

#[test]
fn absolute_paths_and_drive_letters_are_refused() {
    let (result, base) = extract_hostile("absolute.zip", &[]);
    assert!(result.unwrap_err().contains("absolute"));
    assert_nothing_escaped(&base);
    let (result, base) = extract_hostile("drive.zip", &[]);
    assert!(result.unwrap_err().contains("drive letter"));
    assert_nothing_escaped(&base);
}

#[test]
fn names_that_collide_are_refused() {
    let (result, _base) = extract_hostile("collide.zip", &[]);
    assert!(result.unwrap_err().contains("same file"));
}

#[test]
fn a_zip_bomb_is_cut_off_at_the_declared_size() {
    let (result, base) = extract_hostile("bomb.zip", &[]);
    let err = result.unwrap_err();
    assert!(err.contains("expands beyond"), "{err}");
    let dest = base.path().join("dest");
    let leftover: Vec<_> = if dest.exists() {
        list_files(&dest).into_iter().collect()
    } else {
        vec![]
    };
    assert!(
        leftover.iter().all(|f| !f.ends_with(".part")),
        "{leftover:?}"
    );
}

/// A hostile archive with one field of one entry's *local* header overwritten. (The generator
/// patched only the central directory, which this mode never reads.)
struct Patched {
    _dir: tempfile::TempDir,
    server: TestServer,
}

fn patched(zip: &str, entry: &str, offset: usize, value: &[u8]) -> Patched {
    let mut bytes = std::fs::read(malicious_dir().join(zip)).unwrap();
    let at = (0..bytes.len() - 30)
        .find(|&i| {
            &bytes[i..i + 4] == b"PK" && {
                let n = u16::from_le_bytes([bytes[i + 26], bytes[i + 27]]) as usize;
                &bytes[i + 30..i + 30 + n] == entry.as_bytes()
            }
        })
        .unwrap_or_else(|| panic!("{entry} not found in {zip}"));
    bytes[at + offset..at + offset + value.len()].copy_from_slice(value);
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(zip), bytes).unwrap();
    let server = TestServer::start(dir.path(), no_range());
    Patched { _dir: dir, server }
}

#[test]
fn a_wrong_checksum_is_caught_and_the_bad_file_never_gets_its_name() {
    let p = patched("crc.zip", "b.txt", 14, &0xDEAD_BEEFu32.to_le_bytes());
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&p.server, "crc.zip", out.path(), &[]).unwrap_err();
    assert!(err.contains("CRC-32 mismatch"), "{err}");
    assert!(
        out.path().join("a.txt").is_file(),
        "the entry before it was finished"
    );
    assert!(!out.path().join("b.txt").exists());
    assert!(!out.path().join("b.txt.part").exists());
    assert!(
        !out.path().join("c.txt").exists(),
        "extraction stops at the first bad entry"
    );
}

#[test]
fn encrypted_and_unsupported_entries_are_refused_unless_excluded() {
    let encrypted = |_: ()| patched("encrypted.zip", "secret.txt", 6, &[1, 0]);
    let p = encrypted(());
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&p.server, "encrypted.zip", out.path(), &[]).unwrap_err();
    assert!(err.contains("encrypted"), "{err}");

    let p = encrypted(());
    let out = tempfile::tempdir().unwrap();
    run_stream(&p.server, "encrypted.zip", out.path(), &["ok.txt"]).unwrap();
    assert!(out.path().join("ok.txt").is_file());
    assert!(!out.path().join("secret.txt").exists());

    let p = patched("bzip2.zip", "packed.bin", 8, &[12, 0]);
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&p.server, "bzip2.zip", out.path(), &[]).unwrap_err();
    assert!(err.contains("method 12"), "{err}");
}

#[test]
fn windows_incompatible_names_are_renamed_and_reported() {
    let (result, base) = extract_hostile("reserved.zip", &[]);
    let summary = result.unwrap();
    assert!(!summary.renames.is_empty());
    let dest = base.path().join("dest");
    assert!(
        dest.join("_con").is_file() || dest.join("_con").exists(),
        "{:?}",
        list_files(&dest)
    );
}

// ---- things that are not archives ----

#[test]
fn a_web_page_instead_of_a_zip_gets_a_helpful_message() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("login.zip"),
        "<!DOCTYPE html><html><body>Please sign in</body></html>",
    )
    .unwrap();
    let server = TestServer::start(dir.path(), no_range());
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, "login.zip", out.path(), &[]).unwrap_err();
    assert!(
        err.contains("web page") && err.contains("signed in"),
        "{err}"
    );
}

#[test]
fn some_other_file_type_is_named_as_such() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("doc.zip"), b"%PDF-1.7 not a zip at all").unwrap();
    let server = TestServer::start(dir.path(), no_range());
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, "doc.zip", out.path(), &[]).unwrap_err();
    assert!(err.contains("not a ZIP file"), "{err}");
}

/// One stored entry written in streaming style: sizes and CRC come in a descriptor after the data.
fn stored_streamed_entry(
    name: &str,
    data: &[u8],
    signature: bool,
    wide: bool,
    crc: u32,
) -> Vec<u8> {
    let extra: Vec<u8> = if wide {
        let mut e = vec![1, 0, 16, 0];
        e.extend_from_slice(&[0; 16]);
        e
    } else {
        Vec::new()
    };
    let mut v = Vec::new();
    v.extend_from_slice(b"PK");
    v.extend_from_slice(&[20, 0, 8, 0, 0, 0, 0, 0, 0, 0]); // version, flags (bit 3), method 0, time, date
    v.extend_from_slice(&[0; 12]); // CRC and sizes: unknown here
    v.extend_from_slice(&(name.len() as u16).to_le_bytes());
    v.extend_from_slice(&(extra.len() as u16).to_le_bytes());
    v.extend_from_slice(name.as_bytes());
    v.extend_from_slice(&extra);
    v.extend_from_slice(data);
    if signature {
        v.extend_from_slice(b"PK");
    }
    v.extend_from_slice(&crc.to_le_bytes());
    let len = data.len();
    if wide {
        v.extend_from_slice(&(len as u64).to_le_bytes());
        v.extend_from_slice(&(len as u64).to_le_bytes());
    } else {
        v.extend_from_slice(&(len as u32).to_le_bytes());
        v.extend_from_slice(&(len as u32).to_le_bytes());
    }
    v
}

fn crc(data: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(data);
    h.finalize()
}

fn serve_bytes(name: &str, bytes: &[u8]) -> (tempfile::TempDir, TestServer) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(name), bytes).unwrap();
    let server = TestServer::start(dir.path(), no_range());
    (dir, server)
}

#[test]
fn stored_entries_in_streaming_style_find_their_own_end() {
    // The second file's *data* contains something that looks like a descriptor signature; the
    // real end is only accepted where the CRC-32 and both sizes match what was copied.
    let tricky = b"before PK       after".to_vec();
    let big: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect(); // spans several buffer refills
    for wide in [false, true] {
        let mut zip = Vec::new();
        zip.extend(stored_streamed_entry(
            "a.txt",
            b"hello",
            true,
            wide,
            crc(b"hello"),
        ));
        zip.extend(stored_streamed_entry(
            "dir/tricky.bin",
            &tricky,
            true,
            wide,
            crc(&tricky),
        ));
        zip.extend(stored_streamed_entry("empty.txt", b"", true, wide, 0));
        zip.extend(stored_streamed_entry(
            "big.bin",
            &big,
            true,
            wide,
            crc(&big),
        ));
        zip.extend_from_slice(b"PK central directory starts here");
        let (_dir, server) = serve_bytes("s.zip", &zip);
        let out = tempfile::tempdir().unwrap();

        let summary = run_stream(&server, "s.zip", out.path(), &[]).unwrap();

        assert_eq!(summary.files, 4, "wide={wide}");
        assert_eq!(std::fs::read(out.path().join("a.txt")).unwrap(), b"hello");
        assert_eq!(
            std::fs::read(out.path().join("dir/tricky.bin")).unwrap(),
            tricky
        );
        assert_eq!(std::fs::read(out.path().join("empty.txt")).unwrap(), b"");
        assert_eq!(std::fs::read(out.path().join("big.bin")).unwrap(), big);

        // And skipping them (not selected) must find the same ends.
        let only = tempfile::tempdir().unwrap();
        let summary = run_stream(&server, "s.zip", only.path(), &["big.bin"]).unwrap();
        assert_eq!(summary.files, 1, "wide={wide}");
        assert_eq!(std::fs::read(only.path().join("big.bin")).unwrap(), big);
    }
}

#[test]
fn a_stored_streaming_entry_whose_end_cannot_be_found_is_an_error() {
    // The descriptor's CRC is wrong, so it is not accepted as the end of the data.
    let mut zip = stored_streamed_entry("a.txt", b"hello", true, false, 0x1234_5678);
    zip.extend_from_slice(b"PK central directory");
    let (_dir, server) = serve_bytes("s.zip", &zip);
    let out = tempfile::tempdir().unwrap();
    let err = run_stream(&server, "s.zip", out.path(), &[]).unwrap_err();
    assert!(err.contains("stored entry"), "{err}");
    assert!(!out.path().join("a.txt").exists());
    assert!(list_files(out.path()).iter().all(|f| !f.ends_with(".part")));
}
