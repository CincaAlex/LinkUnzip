//! Deciding *what* to extract and *which byte ranges* to fetch, all before touching the disk.
//!
//! `check` selects entries (`--include`) and refuses anything unsafe or unsupported;
//! `Checked::into_plan` leaves out files that are already done (resume) and groups the rest into
//! **spans**: runs of entries that sit next to each other in the archive, so one Range request can
//! fetch a whole run. `build` does both.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use anyhow::{Result, bail};
use glob::{MatchOptions, Pattern};
use serde::Deserialize;

use crate::error::{Coded, ErrorCode};
use crate::safety;
use crate::zip::Entry;
use crate::zip::index::ArchiveIndex;
use crate::zip::local::LOCAL_FIXED_LEN;

/// If two selected entries are further apart than this, they go into different spans instead of
/// downloading (and throwing away) everything in between. Matters for `--include`.
pub const GAP_THRESHOLD: u64 = 1 << 20;

/// Don't cut a span into smaller pieces than this just to balance threads: one extra HTTP request
/// costs more than the parallelism gains on tiny spans.
pub const MIN_SPAN_BYTES: u64 = 1 << 20;

/// A file entry that passed all checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    pub entry: Entry,
    /// Sanitised path relative to the output folder.
    pub rel_path: PathBuf,
    /// Offset where the *next* thing in the archive starts: this entry's local header, data and
    /// optional data descriptor all lie in `[entry.local_header_offset, region_end)`.
    pub region_end: u64,
}

impl PlannedFile {
    /// Bytes this entry occupies in the archive.
    pub fn region_len(&self) -> u64 {
        self.region_end - self.entry.local_header_offset
    }
}

/// Files that are neighbours in the archive; fetched with a single Range request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub files: Vec<PlannedFile>,
    /// First byte to request (the first file's local header).
    pub start: u64,
    /// Last byte to request, inclusive.
    pub end: u64,
}

#[derive(Debug)]
pub struct Plan {
    pub spans: Vec<Span>,
    /// Folders to create up front (explicit directory entries; empty ones included).
    pub dirs: Vec<PathBuf>,
    /// Files to extract (skipped ones not included), and their sizes.
    pub file_count: u64,
    pub total_compressed: u64,
    pub total_extracted: u64,
    /// (original name, name on disk) for every entry renamed to be valid on Windows.
    pub renames: Vec<(String, String)>,
    /// Selected files left out because they are already in the folder (resume), and their size
    /// extracted and in the zip.
    pub skipped_files: u64,
    pub skipped_bytes: u64,
    pub skipped_compressed: u64,
}

/// The selected entries after every check, before deciding what to download.
#[derive(Debug)]
pub struct Checked {
    /// Selected files, sorted by their position in the archive.
    pub files: Vec<PlannedFile>,
    /// Folders to create up front (explicit directory entries; empty ones included).
    pub dirs: Vec<PathBuf>,
    /// (original name, name on disk) for every entry renamed to be valid on Windows.
    pub renames: Vec<(String, String)>,
}

pub(crate) const GLOB_OPTIONS: MatchOptions = MatchOptions {
    // Windows-first: `*.CSV` should find `data.csv`. `*` may cross `/`, so `--include "*.csv"`
    // matches CSV files in any folder, like most people expect.
    case_sensitive: false,
    require_literal_separator: false,
    require_literal_leading_dot: false,
};

/// What the person ticked in the browser's file list. `paths` are entry paths as stored in the
/// archive (with `/` as the separator even where the archive used `\`); a path ending in `/` is a
/// folder and stands for everything below it. An entry is selected when it equals or lies under
/// one of `paths` (no `paths` = everything) and does not equal or lie under any of `exclude`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Selection {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Selection {
    pub fn is_everything(&self) -> bool {
        self.paths.is_empty() && self.exclude.is_empty()
    }
}

/// An entry's path the way the file list shows it: `\` (written by some Windows tools) becomes
/// `/`, nothing else changes.
pub fn list_path(name: &str) -> Cow<'_, str> {
    if name.contains('\\') {
        Cow::Owned(name.replace('\\', "/"))
    } else {
        Cow::Borrowed(name)
    }
}

/// Does `set` hold `path` itself or one of the folders it lies in (`a/`, `a/b/`, ...)?
fn in_set(set: &HashSet<String>, path: &str) -> bool {
    set.contains(path)
        || path
            .match_indices('/')
            .any(|(i, _)| set.contains(&path[..=i]))
}

/// Which entries to extract: `--include` globs (empty = everything) and the file list's
/// selection; an entry must pass both.
#[derive(Debug, Default)]
pub struct Filter {
    includes: Vec<String>,
    patterns: Vec<Pattern>,
    paths: HashSet<String>,
    exclude: HashSet<String>,
}

impl Filter {
    pub fn new(includes: &[String]) -> Result<Filter> {
        Filter::with_selection(includes, None)
    }

    pub fn with_selection(includes: &[String], selection: Option<&Selection>) -> Result<Filter> {
        let selection = selection.cloned().unwrap_or_default();
        let mut filter = Filter::globs(includes)?;
        filter.paths = selection.paths.into_iter().collect();
        filter.exclude = selection.exclude.into_iter().collect();
        Ok(filter)
    }

    fn globs(includes: &[String]) -> Result<Filter> {
        let patterns = includes
            .iter()
            .map(|p| {
                Pattern::new(p).map_err(|e| {
                    Coded::new(
                        ErrorCode::BadRequest,
                        format!("invalid --include pattern {p:?}: {e}"),
                    )
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Filter {
            includes: includes.to_vec(),
            patterns,
            ..Filter::default()
        })
    }

    /// Is the entry called `name` (as stored in the archive) selected?
    pub fn matches(&self, name: &str) -> bool {
        let globs = self.patterns.is_empty()
            || self
                .patterns
                .iter()
                .any(|p| p.matches_with(name, GLOB_OPTIONS));
        if !globs {
            return false;
        }
        if self.paths.is_empty() && self.exclude.is_empty() {
            return true;
        }
        let path = list_path(name);
        (self.paths.is_empty() || in_set(&self.paths, &path)) && !in_set(&self.exclude, &path)
    }

    /// Why nothing was selected.
    pub(crate) fn nothing_selected(&self) -> String {
        if !self.paths.is_empty() || !self.exclude.is_empty() {
            "nothing in the archive matches the selection".to_string()
        } else if self.patterns.is_empty() {
            "the archive contains no entries".to_string()
        } else {
            format!(
                "no entries in the archive match --include {}",
                self.includes.join(", ")
            )
        }
    }
}

/// Build the plan, or explain everything that is wrong with the selection in one error.
pub fn build(index: &ArchiveIndex, includes: &[String], jobs: usize) -> Result<Plan> {
    Ok(check(index, &Filter::new(includes)?)?.into_plan(jobs, |_| false))
}

/// Select the entries and refuse anything unsafe or unsupported, all before touching the disk.
pub fn check(index: &ArchiveIndex, filter: &Filter) -> Result<Checked> {
    let mut problems: Vec<String> = Vec::new();
    // (name, reason) of selected entries that are encrypted or use an unsupported method.
    let mut unsupported: Vec<(String, String)> = Vec::new();
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    let mut renames = Vec::new();
    let mut taken: HashMap<String, String> = HashMap::new(); // lower-cased output path -> entry name

    // Where each entry's region ends: the next entry's header, or the central directory.
    let mut offsets: Vec<u64> = index
        .entries
        .iter()
        .map(|e| e.local_header_offset)
        .collect();
    offsets.push(index.central_dir_offset);
    offsets.sort_unstable();
    offsets.dedup();

    for entry in index.entries.iter().filter(|e| filter.matches(&e.name)) {
        if let Some(reason) = entry.unsupported_reason() {
            problems.push(format!("{}: {reason}", entry.name));
            unsupported.push((entry.name.clone(), reason));
            continue;
        }
        let safe = match safety::sanitize_entry_name(&entry.name) {
            Ok(s) => s,
            Err(reason) => {
                problems.push(format!("{:?}: unsafe path, {reason}", entry.name));
                continue;
            }
        };
        if safe.changed {
            renames.push((
                entry.name.clone(),
                safe.path.to_string_lossy().replace('\\', "/"),
            ));
        }

        // Windows file names are case-insensitive: "A.txt" and "a.txt" are the same file. Also
        // reserve the ".part" temp name so a file called "x.part" can't clobber the temp of "x".
        let key = safe.path.to_string_lossy().to_lowercase();
        let keys = if entry.is_dir() {
            vec![key]
        } else {
            vec![key.clone(), format!("{key}.part")]
        };
        let mut clash = None;
        for k in keys {
            if let Some(other) = taken.insert(k, entry.name.clone()) {
                clash = Some(other);
            }
        }
        if let Some(other) = clash {
            problems.push(format!(
                "{:?} and {other:?} would be written to the same file",
                entry.name
            ));
            continue;
        }

        if entry.is_dir() {
            dirs.push(safe.path);
            continue;
        }
        let region_end = offsets[offsets.partition_point(|&o| o <= entry.local_header_offset)];
        // The data cannot be shorter than: local header + compressed bytes. If it is, entries overlap.
        let min_end = entry.local_header_offset + LOCAL_FIXED_LEN as u64 + entry.compressed_size;
        if min_end > region_end {
            problems.push(format!(
                "{:?}: its data overlaps the next entry (corrupt or hostile archive)",
                entry.name
            ));
            continue;
        }
        if entry.method == 0 && entry.compressed_size != entry.uncompressed_size {
            problems.push(format!(
                "{:?}: stored entry whose compressed and uncompressed sizes differ",
                entry.name
            ));
            continue;
        }
        files.push(PlannedFile {
            entry: entry.clone(),
            rel_path: safe.path,
            region_end,
        });
    }

    if !problems.is_empty() {
        let detail = describe_problems(&problems);
        // Only unsupported files (no hostile names): the person can simply leave them out.
        if unsupported.len() == problems.len() {
            return Err(Coded::new(ErrorCode::UnsupportedEntries, detail)
                .with_message(unsupported_message(&unsupported))
                .into());
        }
        bail!("{detail}");
    }
    if files.is_empty() && dirs.is_empty() {
        bail!("{}", filter.nothing_selected());
    }
    // Two entries pointing at the same local header would be extracted from the same bytes.
    files.sort_by_key(|f| f.entry.local_header_offset);
    if let Some(pair) = files
        .windows(2)
        .find(|w| w[0].entry.local_header_offset == w[1].entry.local_header_offset)
    {
        bail!(
            "{:?} and {:?} share the same data in the archive (hostile archive)",
            pair[0].entry.name,
            pair[1].entry.name
        );
    }

    Ok(Checked {
        files,
        dirs,
        renames,
    })
}

impl Checked {
    /// Group the files into spans for `jobs` connections, leaving out those `skip` says are
    /// already done. The spans (and the "a gap over 1 MiB starts a new span" rule) are worked out
    /// from the remaining files only, so skipped files are not downloaded.
    pub fn into_plan(self, jobs: usize, skip: impl Fn(&PlannedFile) -> bool) -> Plan {
        let (skipped, files): (Vec<_>, Vec<_>) = self.files.into_iter().partition(|f| skip(f));
        Plan {
            file_count: files.len() as u64,
            total_compressed: files.iter().map(|f| f.entry.compressed_size).sum(),
            total_extracted: files.iter().map(|f| f.entry.uncompressed_size).sum(),
            skipped_files: skipped.len() as u64,
            skipped_bytes: skipped.iter().map(|f| f.entry.uncompressed_size).sum(),
            skipped_compressed: skipped.iter().map(|f| f.entry.compressed_size).sum(),
            spans: split_spans(files, jobs),
            dirs: self.dirs,
            renames: self.renames,
        }
    }
}

fn describe_problems(problems: &[String]) -> String {
    const SHOWN: usize = 10;
    let mut msg = format!(
        "{} selected entr{} cannot be extracted:\n",
        problems.len(),
        if problems.len() == 1 { "y" } else { "ies" }
    );
    for p in problems.iter().take(SHOWN) {
        msg.push_str(&format!("  - {p}\n"));
    }
    if problems.len() > SHOWN {
        msg.push_str(&format!("  ... and {} more\n", problems.len() - SHOWN));
    }
    msg.push_str("Nothing was written. Use --include to select only the entries you want.");
    msg
}

/// "2 of the selected files can't be extracted: a.txt (encrypted), b.bin (compression method
/// 12 (bzip2)). Leave them out and try again."
pub fn unsupported_message(unsupported: &[(String, String)]) -> String {
    const SHOWN: usize = 5;
    let n = unsupported.len();
    let mut names = unsupported
        .iter()
        .take(SHOWN)
        .map(|(name, reason)| format!("{name} ({reason})"))
        .collect::<Vec<_>>()
        .join(", ");
    if n > SHOWN {
        names.push_str(&format!(" and {} more", n - SHOWN));
    }
    let (count, them) = if n == 1 {
        ("1 of the selected files".to_string(), "it")
    } else {
        (format!("{n} of the selected files"), "them")
    };
    format!("{count} can't be extracted by LinkUnzip: {names}. Leave {them} out and try again.")
}

/// Group files (sorted by offset, non-overlapping) into spans: at most about `jobs` of similar
/// size, and never one that bridges a large gap between selected entries.
pub fn split_spans(files: Vec<PlannedFile>, jobs: usize) -> Vec<Span> {
    let jobs = jobs.max(1) as u64;
    let total: u64 = files.iter().map(PlannedFile::region_len).sum();

    let mut spans: Vec<Span> = Vec::new();
    let mut current: Vec<PlannedFile> = Vec::new();
    let mut current_bytes = 0u64;
    let mut closed_bytes = 0u64;

    for file in files {
        if let Some(prev) = current.last() {
            let gap = file
                .entry
                .local_header_offset
                .saturating_sub(prev.region_end);
            // Close the span once everything so far has reached this span's share of the total.
            let share = total * (spans.len() as u64 + 1) / jobs;
            let balanced = (spans.len() as u64 + 1) < jobs
                && current_bytes >= MIN_SPAN_BYTES
                && closed_bytes + current_bytes >= share;
            if gap > GAP_THRESHOLD || balanced {
                closed_bytes += current_bytes;
                spans.push(make_span(std::mem::take(&mut current)));
                current_bytes = 0;
            }
        }
        current_bytes += file.region_len();
        current.push(file);
    }
    if !current.is_empty() {
        spans.push(make_span(current));
    }
    spans
}

fn make_span(files: Vec<PlannedFile>) -> Span {
    let start = files.first().map_or(0, |f| f.entry.local_header_offset);
    let end = files.last().map_or(0, |f| f.region_end - 1);
    Span { files, start, end }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1 << 20;

    fn entry(name: &str, offset: u64, comp: u64, uncomp: u64) -> Entry {
        Entry {
            name: name.into(),
            flags: 0,
            method: 8,
            crc32: 0,
            compressed_size: comp,
            uncompressed_size: uncomp,
            local_header_offset: offset,
        }
    }

    /// Entries laid out back to back, each `size` bytes of data plus a 40-byte header.
    fn laid_out(sizes: &[(&str, u64)]) -> ArchiveIndex {
        let mut offset = 0;
        let mut entries = Vec::new();
        for (name, size) in sizes {
            entries.push(entry(name, offset, *size, size * 2));
            offset += 40 + size;
        }
        ArchiveIndex {
            entries,
            central_dir_offset: offset,
        }
    }

    fn names(span: &Span) -> Vec<&str> {
        span.files.iter().map(|f| f.entry.name.as_str()).collect()
    }

    #[test]
    fn selects_everything_by_default_and_records_totals() {
        let idx = laid_out(&[("a.txt", 100), ("b/c.txt", 200)]);
        let plan = build(&idx, &[], 4).unwrap();
        assert_eq!(
            (plan.file_count, plan.total_compressed, plan.total_extracted),
            (2, 300, 600)
        );
        assert_eq!(plan.spans.len(), 1);
        assert_eq!(names(&plan.spans[0]), ["a.txt", "b/c.txt"]);
        assert_eq!(plan.spans[0].start, 0);
        assert_eq!(
            plan.spans[0].end,
            idx.central_dir_offset - 1,
            "the last span ends right before the central directory"
        );
    }

    #[test]
    fn include_globs_match_case_insensitively_across_folders() {
        let idx = laid_out(&[("a.csv", 10), ("dir/B.CSV", 10), ("dir/c.txt", 10)]);
        let plan = build(&idx, &["*.csv".into()], 1).unwrap();
        let all: Vec<_> = plan.spans.iter().flat_map(names).collect();
        assert_eq!(all, ["a.csv", "dir/B.CSV"]);
        let plan = build(&idx, &["dir/*".into(), "a.*".into()], 1).unwrap();
        assert_eq!(plan.file_count, 3);
    }

    #[test]
    fn include_that_matches_nothing_is_an_error() {
        let idx = laid_out(&[("a.txt", 10)]);
        let err = build(&idx, &["*.zip".into()], 1).unwrap_err().to_string();
        assert!(err.contains("no entries"), "{err}");
        assert!(
            build(&idx, &["[".into()], 1)
                .unwrap_err()
                .to_string()
                .contains("invalid --include")
        );
    }

    #[test]
    fn selection_takes_paths_and_folders_and_exclude_wins() {
        let sel = |paths: &[&str], exclude: &[&str]| Selection {
            paths: paths.iter().map(|s| s.to_string()).collect(),
            exclude: exclude.iter().map(|s| s.to_string()).collect(),
        };
        let f = Filter::with_selection(&[], Some(&sel(&["a/", "top.txt"], &["a/b/", "a/x.txt"])))
            .unwrap();
        assert!(f.matches("a/y.txt"));
        assert!(f.matches("a/c/d.txt"));
        assert!(f.matches("a/"), "the folder entry itself");
        assert!(f.matches("top.txt"));
        assert!(!f.matches("a/x.txt"), "excluded file");
        assert!(!f.matches("a/b/deep/e.txt"), "under an excluded folder");
        assert!(!f.matches("a/b/"));
        assert!(!f.matches("other.txt"));
        assert!(
            !f.matches("ab/c.txt"),
            "\"a/\" is a folder, not a prefix of names"
        );
        assert!(!f.matches("top.txt.bak"));
        assert!(f.matches(r"a\win.txt"), "backslashes count as separators");

        // No paths = everything, minus what is excluded.
        let f = Filter::with_selection(&[], Some(&sel(&[], &["big/"]))).unwrap();
        assert!(f.matches("x.txt") && !f.matches("big/y.bin"));

        // Combined with --include: both must agree.
        let f =
            Filter::with_selection(&["*.csv".to_string()], Some(&sel(&["data/"], &[]))).unwrap();
        assert!(f.matches("data/x.csv"));
        assert!(!f.matches("data/x.txt") && !f.matches("other/x.csv"));
    }

    #[test]
    fn a_selection_that_matches_nothing_says_so() {
        let idx = laid_out(&[("a.txt", 10)]);
        let f = Filter::with_selection(
            &[],
            Some(&Selection {
                paths: vec!["missing/".into()],
                exclude: vec![],
            }),
        )
        .unwrap();
        let err = check(&idx, &f).unwrap_err().to_string();
        assert!(err.contains("matches the selection"), "{err}");
    }

    #[test]
    fn region_end_is_the_next_entry_even_when_it_is_not_selected() {
        let idx = laid_out(&[("keep.txt", 100), ("skip.txt", 100), ("keep2.txt", 100)]);
        let plan = build(&idx, &["keep*".into()], 1).unwrap();
        let files: Vec<_> = plan.spans.iter().flat_map(|s| s.files.iter()).collect();
        assert_eq!(files[0].region_end, idx.entries[1].local_header_offset);
        assert_eq!(files[1].region_end, idx.central_dir_offset);
    }

    #[test]
    fn unsupported_entries_are_reported_unless_excluded() {
        let mut idx = laid_out(&[("ok.txt", 10), ("secret.txt", 10), ("packed.bz2", 10)]);
        idx.entries[1].flags = 1; // encrypted
        idx.entries[2].method = 12; // bzip2
        let e = build(&idx, &[], 1).unwrap_err();
        let err = e.to_string();
        assert!(err.contains("secret.txt: encrypted"), "{err}");
        assert!(err.contains("packed.bz2: compression method 12"), "{err}");
        assert!(err.contains("Nothing was written"), "{err}");
        let coded = e.downcast_ref::<Coded>().unwrap();
        assert_eq!(coded.code, ErrorCode::UnsupportedEntries);
        let message = coded.message.as_deref().unwrap();
        assert!(
            message.starts_with("2 of the selected files")
                && message.contains("secret.txt (encrypted)"),
            "{message}"
        );
        assert!(
            build(&idx, &["ok.txt".into()], 1).is_ok(),
            "excluding them makes extraction possible"
        );
    }

    #[test]
    fn unsafe_paths_refuse_the_whole_extraction() {
        let idx = laid_out(&[("fine.txt", 10), ("../evil.txt", 10), ("C:/x.txt", 10)]);
        let err = build(&idx, &[], 1).unwrap_err().to_string();
        assert!(
            err.contains("../evil.txt") && err.contains("traversal"),
            "{err}"
        );
        assert!(err.contains("drive letter"), "{err}");
        assert!(build(&idx, &["fine.txt".into()], 1).is_ok());
    }

    #[test]
    fn windows_unfriendly_names_are_renamed_and_reported() {
        let idx = laid_out(&[("con.txt", 10), ("dir/a:b.txt", 10), ("ok.txt", 10)]);
        let plan = build(&idx, &[], 1).unwrap();
        assert_eq!(
            plan.renames,
            [
                ("con.txt".to_string(), "_con.txt".to_string()),
                ("dir/a:b.txt".to_string(), "dir/a_b.txt".to_string())
            ]
        );
    }

    #[test]
    fn colliding_output_names_are_refused() {
        // Case-insensitive file systems would merge these.
        let idx = laid_out(&[("Readme.txt", 10), ("README.TXT", 10)]);
        assert!(
            build(&idx, &[], 1)
                .unwrap_err()
                .to_string()
                .contains("same file")
        );
        // Sanitising can create collisions too.
        let idx = laid_out(&[("dir/a:b", 10), ("dir/a_b", 10)]);
        assert!(
            build(&idx, &[], 1)
                .unwrap_err()
                .to_string()
                .contains("same file")
        );
        // "x.part" would collide with the temp file of "x".
        let idx = laid_out(&[("x", 10), ("x.part", 10)]);
        assert!(
            build(&idx, &[], 1)
                .unwrap_err()
                .to_string()
                .contains("same file")
        );
    }

    #[test]
    fn overlapping_entries_are_refused() {
        let mut idx = laid_out(&[("a", 100), ("b", 100)]);
        idx.entries[0].compressed_size = 5000; // claims to extend into "b"
        let err = build(&idx, &[], 1).unwrap_err().to_string();
        assert!(err.contains("overlaps"), "{err}");

        let mut idx = laid_out(&[("a", 100), ("b", 100)]);
        idx.entries[1].local_header_offset = idx.entries[0].local_header_offset;
        assert!(build(&idx, &[], 1).is_err());
    }

    #[test]
    fn directories_are_collected_even_without_files() {
        let mut idx = laid_out(&[("empty/", 0), ("docs/", 0)]);
        for e in &mut idx.entries {
            e.method = 0;
        }
        let plan = build(&idx, &[], 1).unwrap();
        assert_eq!(plan.dirs, [PathBuf::from("empty"), PathBuf::from("docs")]);
        assert!(plan.spans.is_empty());
    }

    // ---- span splitting ----

    fn files_of_sizes(sizes: &[u64]) -> Vec<PlannedFile> {
        let mut offset = 0;
        sizes
            .iter()
            .enumerate()
            .map(|(i, &size)| {
                let f = PlannedFile {
                    entry: entry(&format!("f{i}"), offset, size, size),
                    rel_path: PathBuf::from(format!("f{i}")),
                    region_end: offset + size,
                };
                offset += size;
                f
            })
            .collect()
    }

    #[test]
    fn splits_into_roughly_equal_spans() {
        let spans = split_spans(files_of_sizes(&[10 * MIB; 8]), 4);
        assert_eq!(spans.len(), 4);
        assert!(
            spans.iter().all(|s| s.files.len() == 2),
            "{:?}",
            spans.iter().map(|s| s.files.len()).collect::<Vec<_>>()
        );
        // Spans tile the archive: each starts where the previous one ended.
        for pair in spans.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }

    #[test]
    fn never_more_spans_than_jobs_on_a_contiguous_run() {
        for jobs in 1..=6 {
            let spans = split_spans(files_of_sizes(&[3 * MIB; 25]), jobs);
            assert!(
                spans.len() <= jobs,
                "jobs={jobs} gave {} spans",
                spans.len()
            );
            assert_eq!(spans.iter().map(|s| s.files.len()).sum::<usize>(), 25);
        }
    }

    #[test]
    fn small_archives_stay_in_one_span() {
        assert_eq!(split_spans(files_of_sizes(&[1000; 50]), 8).len(), 1);
    }

    #[test]
    fn one_huge_file_cannot_be_split() {
        let spans = split_spans(files_of_sizes(&[500 * MIB]), 4);
        assert_eq!(spans.len(), 1);
    }

    #[test]
    fn large_gaps_between_selected_files_start_a_new_span() {
        let mut files = files_of_sizes(&[100, 100, 100]);
        // push the third file 5 MiB further into the archive: something unselected sits in between
        files[2].entry.local_header_offset += 5 * MIB;
        files[2].region_end += 5 * MIB;
        let spans = split_spans(files, 1);
        assert_eq!(spans.len(), 2, "the 5 MiB gap must not be downloaded");
        assert_eq!(spans[0].files.len(), 2);
        assert_eq!(spans[1].start, 200 + 5 * MIB);
    }

    #[test]
    fn small_gaps_are_bridged() {
        let mut files = files_of_sizes(&[100, 100]);
        files[1].entry.local_header_offset += 1000;
        files[1].region_end += 1000;
        assert_eq!(split_spans(files, 1).len(), 1);
    }

    #[test]
    fn skipped_files_are_left_out_of_the_spans_and_counted() {
        // Three 2 MiB files back to back; the middle one is already done.
        let idx = laid_out(&[("a", 2 * MIB), ("b", 2 * MIB), ("c", 2 * MIB)]);
        let checked = check(&idx, &Filter::default()).unwrap();
        let plan = checked.into_plan(1, |f| f.entry.name == "b");
        assert_eq!((plan.file_count, plan.skipped_files), (2, 1));
        assert_eq!(plan.skipped_bytes, 4 * MIB, "b's extracted size");
        assert_eq!(plan.total_compressed, 4 * MIB);
        // The skipped file leaves a 2 MiB hole: two requests instead of downloading it.
        assert_eq!(plan.spans.len(), 2);
        assert!(plan.spans.iter().all(|s| s.files.len() == 1));

        // Everything done: nothing to download, but the plan is still valid.
        let checked = check(&idx, &Filter::default()).unwrap();
        let plan = checked.into_plan(4, |_| true);
        assert!(plan.spans.is_empty());
        assert_eq!((plan.file_count, plan.skipped_files), (0, 3));
    }

    #[test]
    fn empty_input_gives_no_spans() {
        assert!(split_spans(Vec::new(), 4).is_empty());
    }
}
