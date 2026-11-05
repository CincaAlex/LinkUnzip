//! `drop_top` (asked for by the browser extension): when everything in proj-main.zip sits in
//! proj-main/ and the output folder is called proj-main too, that folder's contents go straight
//! into it. Both with Range requests and in one pass, and Resume keeps an earlier layout.

mod common;

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use common::server::{ServerOptions, TestServer};
use common::{bytes_of, list_files, stored_zip};
use linkunzip::extract::{self, ExtractOptions, Summary};
use linkunzip::plan::Selection;

fn files() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("a.txt", b"top level\n".to_vec()),
        ("src/b.rs", bytes_of(41, 150_000)),
        ("src/deep/c.bin", bytes_of(42, 90_000)),
    ]
}

/// `<top>/`, `<top>/a.txt`, `<top>/src/`, ... plus `extra` entries as they are.
fn zip_in(top: &str, extra: &[(&str, &[u8])]) -> Vec<u8> {
    let named: Vec<(String, Vec<u8>)> = [
        (format!("{top}/"), Vec::new()),
        (format!("{top}/src/"), Vec::new()),
    ]
    .into_iter()
    .chain(files().into_iter().map(|(n, d)| (format!("{top}/{n}"), d)))
    .collect();
    let mut all: Vec<(&str, &[u8])> = named
        .iter()
        .map(|(n, d)| (n.as_str(), d.as_slice()))
        .collect();
    all.extend_from_slice(extra);
    stored_zip(&all)
}

struct Setup {
    _zips: tempfile::TempDir,
    server: TestServer,
    out: tempfile::TempDir,
}

fn serve(name: &str, zip: &[u8], opts: ServerOptions) -> Setup {
    let zips = tempfile::tempdir().unwrap();
    std::fs::write(zips.path().join(name), zip).unwrap();
    let server = TestServer::start(zips.path(), opts);
    Setup {
        _zips: zips,
        server,
        out: tempfile::tempdir().unwrap(),
    }
}

fn extract_into(
    s: &Setup,
    zip: &str,
    folder: &str,
    tweak: impl FnOnce(&mut ExtractOptions),
) -> (PathBuf, Summary) {
    let out = s.out.path().join(folder);
    let mut opts = common::options(s.server.url_for(zip), &out, &[], 2);
    opts.drop_top = true;
    tweak(&mut opts);
    let summary = extract::run(&opts).expect("extraction");
    (out, summary)
}

fn under(prefix: &str) -> BTreeSet<String> {
    files()
        .into_iter()
        .map(|(n, _)| format!("{prefix}{n}"))
        .collect()
}

fn same_bytes(out: &Path, prefix: &str) {
    for (n, d) in files() {
        assert_eq!(
            std::fs::read(out.join(format!("{prefix}{n}"))).unwrap(),
            d,
            "{prefix}{n}"
        );
    }
}

#[test]
fn the_top_folder_goes_straight_into_a_folder_of_its_name() {
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions::default(),
    );
    let (out, summary) = extract_into(&s, "proj-main.zip", "proj-main", |_| {});
    assert_eq!(list_files(&out), under(""));
    same_bytes(&out, "");
    assert!(summary.renames.is_empty(), "{:?}", summary.renames);
}

#[test]
fn also_in_one_pass() {
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    let (out, summary) = extract_into(&s, "proj-main.zip", "Proj-Main", |o| o.stream = true);
    assert!(summary.sequential);
    assert_eq!(list_files(&out), under(""), "the name in another case too");
    same_bytes(&out, "");
}

#[test]
fn one_pass_keeps_the_path_of_a_file_outside_it_that_comes_later() {
    let s = serve(
        "late.zip",
        &zip_in("late", &[("late.txt", b"after")]),
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    let (out, _) = extract_into(&s, "late.zip", "late", |o| o.stream = true);
    let mut want = under("");
    want.insert("late.txt".into());
    assert_eq!(list_files(&out), want);
}

#[test]
fn kept_without_drop_top_another_name_or_a_file_outside() {
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions::default(),
    );
    let (out, _) = extract_into(&s, "proj-main.zip", "proj-main", |o| o.drop_top = false);
    assert_eq!(list_files(&out), under("proj-main/"), "the command line");
    let (out, _) = extract_into(&s, "proj-main.zip", "elsewhere", |_| {});
    assert_eq!(list_files(&out), under("proj-main/"));

    let s = serve(
        "loose.zip",
        &zip_in("loose", &[("NOTICE", b"outside")]),
        ServerOptions::default(),
    );
    let (out, _) = extract_into(&s, "loose.zip", "loose", |_| {});
    let mut want = under("loose/");
    want.insert("NOTICE".into());
    assert_eq!(list_files(&out), want);
}

#[test]
fn resume_of_an_earlier_versions_extraction_keeps_its_layout() {
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions::default(),
    );
    let earlier = s.out.path().join("proj-main").join("proj-main");
    std::fs::create_dir_all(&earlier).unwrap();
    std::fs::write(earlier.join("a.txt"), b"top level\n").unwrap();
    let (out, summary) = extract_into(&s, "proj-main.zip", "proj-main", |_| {});
    assert_eq!(list_files(&out), under("proj-main/"));
    assert_eq!(summary.skipped_files, 1, "a.txt was already there");
    same_bytes(&out, "proj-main/");

    // And one of this version: its files are found without the folder.
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions::default(),
    );
    let out = s.out.path().join("proj-main");
    std::fs::create_dir_all(out.join("src")).unwrap();
    std::fs::write(out.join("src").join("b.rs"), bytes_of(41, 150_000)).unwrap();
    let (out, summary) = extract_into(&s, "proj-main.zip", "proj-main", |_| {});
    assert_eq!(list_files(&out), under(""));
    assert_eq!(summary.skipped_files, 1);
}

#[test]
fn ticks_from_the_file_list_with_the_top_folder_left_out() {
    let s = serve(
        "proj-main.zip",
        &zip_in("proj-main", &[]),
        ServerOptions::default(),
    );
    let marks = HashMap::from([
        (String::new(), false),
        ("proj-main/src/".to_string(), true),
        ("proj-main/src/deep/".to_string(), false),
    ]);
    let (out, _) = extract_into(&s, "proj-main.zip", "proj-main", |o| {
        o.select = Some(Selection {
            marks: Some(marks),
            ..Selection::default()
        })
    });
    assert_eq!(list_files(&out), BTreeSet::from(["src/b.rs".to_string()]));
}

#[test]
fn a_file_named_like_the_journal_gets_an_underscore() {
    let zip = stored_zip(&[
        ("jr/.linkunzip-resume.jsonl", b"not ours"),
        ("jr/x.txt", b"x"),
    ]);
    let s = serve("jr.zip", &zip, ServerOptions::default());
    let (out, summary) = extract_into(&s, "jr.zip", "jr", |_| {});
    assert_eq!(
        list_files(&out),
        BTreeSet::from(["_.linkunzip-resume.jsonl".to_string(), "x.txt".to_string()])
    );
    assert_eq!(
        std::fs::read(out.join("_.linkunzip-resume.jsonl")).unwrap(),
        b"not ours"
    );
    assert_eq!(summary.renames.len(), 1, "{:?}", summary.renames);
}
