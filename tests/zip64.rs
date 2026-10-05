//! ZIP64 with a genuinely huge entry. Ignored by default because it writes several GB to disk:
//!
//!     cargo test --release --test zip64 -- --ignored
//!
//! By default the big entry is 2.1 GiB: Python switches to ZIP64 structures above 2 GiB, so this
//! already exercises the 0xFFFFFFFF size/offset sentinels and the ZIP64 extra field (needs about
//! 5 GiB of free space for the archive plus the extraction). For the "over 4 GiB" case from the
//! spec, set LINKUNZIP_ZIP64_GIB=4.5 (about 10 GiB of free space).

mod common;

use common::server::{ServerOptions, TestServer};
use common::{assert_tree_matches, fixture_with_args, options};
use linkunzip::extract;
use linkunzip::http::Source;
use linkunzip::zip::index::read_index;

fn big_gib() -> String {
    std::env::var("LINKUNZIP_ZIP64_GIB").unwrap_or_else(|_| "2.1".to_string())
}

#[test]
#[ignore = "writes several GB; run with --ignored"]
fn zip64_archive_with_a_huge_entry_extracts_correctly() {
    let gib = big_gib();
    let fx = fixture_with_args("zip64", &["--big-gib", &gib]);
    let server = TestServer::start(&fx.dir, ServerOptions::default());

    // The index must report the true 64-bit values, not the 0xFFFFFFFF sentinels.
    let src = Source::probe(&server.url_for(&fx.zip_name), Default::default()).unwrap();
    let index = read_index(&src).unwrap();
    for f in &fx.files {
        let e = index.entries.iter().find(|e| e.name == f.name).unwrap();
        assert_eq!(
            (
                e.uncompressed_size,
                e.compressed_size,
                e.local_header_offset
            ),
            (f.size, f.compressed_size, f.header_offset),
            "{}",
            f.name
        );
    }
    let big = fx.files.iter().max_by_key(|f| f.size).unwrap();
    assert!(big.size > 2 << 30, "the big entry should be over 2 GiB");
    assert!(
        fx.files.iter().any(|f| f.header_offset > 2 << 30),
        "some entries must start past the 2 GiB mark so their offsets need the ZIP64 field"
    );

    let out = tempfile::tempdir().unwrap();
    let summary = extract::run(&options(server.url_for(&fx.zip_name), out.path(), &[], 4)).unwrap();
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert_eq!(
        summary.extracted_bytes,
        fx.files.iter().map(|f| f.size).sum::<u64>()
    );
}
