//! The archive replaced on the server by another version of the same length while it is read:
//! after the index was read, and across a retried file. Every case must stop, and whatever got
//! its real name in the output folder must be the first version's file, byte for byte.

mod common;

use std::path::Path;

use common::server::{Fault, IfRangeMode, ServerOptions, TestServer, Validators};
use common::{bytes_of, stored_zip};
use linkunzip::extract;
use linkunzip::http::Source;
use sha2::{Digest, Sha256};

const SIZE: usize = 1_500_000;

struct Pair {
    dir: tempfile::TempDir,
    a: Vec<(String, Vec<u8>)>,
    len: usize,
}

/// `swap.zip` and its second version `swap.zip.v2`: two.bin and three.bin differ.
fn pair() -> Pair {
    let v = |two, three| {
        vec![
            ("one.bin".to_string(), bytes_of(1, SIZE)),
            ("two.bin".to_string(), bytes_of(two, SIZE)),
            ("three.bin".to_string(), bytes_of(three, SIZE)),
        ]
    };
    let zip = |files: &[(String, Vec<u8>)]| {
        stored_zip(
            &files
                .iter()
                .map(|(n, d)| (n.as_str(), d.as_slice()))
                .collect::<Vec<_>>(),
        )
    };
    let (a, b) = (v(2, 3), v(22, 33));
    let (za, zb) = (zip(&a), zip(&b));
    assert_eq!(
        za.len(),
        zb.len(),
        "both versions must have the same length"
    );
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("swap.zip"), &za).unwrap();
    std::fs::write(dir.path().join("swap.zip.v2"), &zb).unwrap();
    Pair {
        dir,
        a,
        len: za.len(),
    }
}

/// Every file in `out` is version A's, byte for byte (the resume journal a stopped run leaves
/// aside). Returns how many there are.
fn only_first_version(out: &Path, pair: &Pair) -> usize {
    let mut files = common::list_files(out);
    files.remove(".linkunzip-resume.jsonl");
    for f in &files {
        let want = &pair
            .a
            .iter()
            .find(|(n, _)| n == f)
            .unwrap_or_else(|| panic!("unexpected file {f}"))
            .1;
        let got = Sha256::digest(std::fs::read(out.join(f)).unwrap());
        assert_eq!(
            got.as_slice(),
            Sha256::digest(want).as_slice(),
            "{f} is not the first version's"
        );
    }
    files.len()
}

/// Extract with the archive swapped at the `swap_at`th data request; the error text.
fn swapped(
    opts: ServerOptions,
    swap_at: usize,
) -> (String, usize, Vec<common::server::RequestLog>) {
    let pair = pair();
    let server = TestServer::start(
        pair.dir.path(),
        ServerOptions {
            swap_at_data_request: Some(swap_at),
            ..opts
        },
    );
    let out = tempfile::tempdir().unwrap();
    let err = extract::run(&common::options(
        server.url_for("swap.zip"),
        out.path(),
        &[],
        1,
    ))
    .expect_err("a swapped archive must not extract");
    let kept = only_first_version(out.path(), &pair);
    (format!("{err:#}"), kept, server.requests())
}

/// Cut the first data request inside two.bin, so the retry is the second data request.
fn cut_in_two() -> Option<Fault> {
    Some(Fault {
        cut_at_offset: (30 + 7 + SIZE + 30 + 7 + 700_000) as u64,
        times: 1,
    })
}

#[test]
fn strong_etag_swapped_after_the_index_read_is_refused_by_if_range() {
    let (err, kept, log) = swapped(ServerOptions::default(), 1);
    assert!(err.contains("changed on the server since"), "{err}");
    assert_eq!(kept, 0);
    // Every request after the probe named the version it wanted.
    assert!(
        log.iter()
            .skip(1)
            .all(|r| r.if_range.as_deref() == Some("\"v1\"")),
        "{log:?}"
    );
}

#[test]
fn strong_etag_swapped_across_a_retried_file() {
    let (err, kept, _) = swapped(
        ServerOptions {
            fault: cut_in_two(),
            ..Default::default()
        },
        2,
    );
    assert!(err.contains("changed on the server since"), "{err}");
    assert_eq!(kept, 1, "one.bin was finished before the drop");
}

#[test]
fn a_server_that_ignores_if_range_is_still_caught_by_the_etag() {
    let (err, kept, log) = swapped(
        ServerOptions {
            if_range: IfRangeMode::Ignore,
            ..Default::default()
        },
        1,
    );
    assert!(err.contains("ETag changed"), "{err}");
    assert_eq!(kept, 0);
    assert!(
        log.iter().skip(1).all(|r| r.if_range.is_some()),
        "sent, though ignored: {log:?}"
    );
}

#[test]
fn a_server_that_answers_200_to_if_range_gets_none_and_is_still_caught() {
    let (err, _, log) = swapped(
        ServerOptions {
            if_range: IfRangeMode::AlwaysFull,
            ..Default::default()
        },
        1,
    );
    assert!(err.contains("ETag changed"), "{err}");
    // Only the probe's check carried it; it was off after that.
    assert_eq!(
        log.iter().filter(|r| r.if_range.is_some()).count(),
        1,
        "{log:?}"
    );
}

#[test]
fn last_modified_only() {
    let (err, kept, log) = swapped(
        ServerOptions {
            validators: Validators::LastModifiedOnly,
            ..Default::default()
        },
        1,
    );
    assert!(err.contains("changed on the server since"), "{err}");
    assert_eq!(kept, 0);
    assert!(
        log.iter()
            .skip(1)
            .all(|r| r.if_range.as_deref() == Some("Fri, 01 Mar 2024 12:00:00 GMT")),
        "{log:?}"
    );
}

#[test]
fn a_weak_etag_is_never_sent_as_if_range_but_still_compared() {
    let (err, kept, log) = swapped(
        ServerOptions {
            validators: Validators::Weak,
            ..Default::default()
        },
        1,
    );
    assert!(err.contains("ETag changed"), "{err}");
    assert_eq!(kept, 0);
    assert!(log.iter().all(|r| r.if_range.is_none()), "{log:?}");
}

#[test]
fn without_validators_the_crc_catches_the_changed_files() {
    let (err, kept, _) = swapped(
        ServerOptions {
            validators: Validators::None,
            ..Default::default()
        },
        1,
    );
    assert!(
        err.contains("CRC-32 mismatch") && err.contains("two.bin"),
        "{err}"
    );
    assert_eq!(kept, 1, "one.bin is the same in both versions");
}

#[test]
fn without_validators_across_a_retried_file() {
    let (err, kept, _) = swapped(
        ServerOptions {
            validators: Validators::None,
            fault: cut_in_two(),
            ..Default::default()
        },
        2,
    );
    assert!(err.contains("CRC-32 mismatch"), "{err}");
    assert_eq!(kept, 1);
}

#[test]
fn validators_that_do_not_change_with_the_content() {
    let (err, kept, _) = swapped(
        ServerOptions {
            same_validators: true,
            ..Default::default()
        },
        1,
    );
    assert!(err.contains("CRC-32 mismatch"), "{err}");
    assert_eq!(kept, 1);
}

#[test]
fn the_probe_turns_if_range_on_only_where_it_is_honoured() {
    let pair = pair();
    for (opts, want) in [
        (ServerOptions::default(), Some("\"v1\"")),
        (
            ServerOptions {
                if_range: IfRangeMode::AlwaysFull,
                ..Default::default()
            },
            None,
        ),
        (
            ServerOptions {
                validators: Validators::Weak,
                ..Default::default()
            },
            None,
        ),
        (
            ServerOptions {
                validators: Validators::None,
                ..Default::default()
            },
            None,
        ),
    ] {
        let server = TestServer::start(pair.dir.path(), opts.clone());
        let src = Source::probe(
            &server.url_for("swap.zip"),
            linkunzip::error::RetryPolicy::default(),
        )
        .unwrap();
        assert_eq!(src.if_range.as_deref(), want, "{opts:?}");
        assert_eq!(src.size, pair.len as u64);
    }
}
