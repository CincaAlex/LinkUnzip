//! `linkunzip inspect <URL>`: probe the server, read the index, and print what extracting would cost.

use std::collections::HashSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use anyhow::Result;
use console::style;

use crate::disk;
use crate::error::RetryPolicy;
use crate::fmt::human_bytes;
use crate::http::Source;
use crate::zip::Entry;
use crate::zip::index::read_index;

/// Sums over the whole archive.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Totals {
    pub files: u64,
    /// Directory entries (names ending in `/`).
    pub dirs: u64,
    /// Every folder: directory entries plus the folders that only appear in file paths
    /// (many archives have no directory entries at all).
    pub folders: u64,
    pub compressed: u64,
    pub extracted: u64,
    /// (entry name, reason) for every file entry that `extract` would refuse.
    pub unsupported: Vec<(String, String)>,
}

pub fn totals(entries: &[Entry]) -> Totals {
    let mut t = Totals::default();
    let mut folders: HashSet<String> = HashSet::new();
    for e in entries {
        // "a/b/c.txt" lies in "a/" and "a/b/"; the directory entry "a/b/" is the folder "a/b/".
        let name = e.name.replace('\\', "/");
        for (i, _) in name.match_indices('/') {
            if !folders.contains(&name[..=i]) {
                folders.insert(name[..=i].to_string());
            }
        }
        if e.is_dir() {
            t.dirs += 1;
            continue;
        }
        t.files += 1;
        t.compressed += e.compressed_size;
        t.extracted += e.uncompressed_size;
        if let Some(reason) = e.unsupported_reason() {
            t.unsupported.push((e.name.clone(), reason));
        }
    }
    t.folders = folders.len() as u64;
    t
}

pub struct Report {
    pub url: String,
    pub archive_size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub entries: Vec<Entry>,
    pub totals: Totals,
    pub target: PathBuf,
    /// Free bytes on the target drive (None if it could not be read).
    pub free: Option<u64>,
    /// Bytes downloaded to probe the server and read the index.
    pub index_bytes: u64,
    /// Requests that took.
    pub index_requests: u64,
}

pub fn inspect(url: &str, target: &Path, retry: RetryPolicy) -> Result<Report> {
    inspect_with(url, target, retry, &[])
}

/// Like [`inspect`], sending `headers` (e.g. the browser's `Cookie`) with every request.
pub fn inspect_with(
    url: &str,
    target: &Path,
    retry: RetryPolicy,
    headers: &[(String, String)],
) -> Result<Report> {
    let src = Source::probe_with(url, retry, headers)?;
    let entries = read_index(&src)?.entries;
    Ok(Report {
        url: url.to_string(),
        archive_size: src.size,
        etag: src.etag.clone(),
        last_modified: src.last_modified.clone(),
        totals: totals(&entries),
        entries,
        target: target.to_path_buf(),
        free: disk::free_space(target).ok(),
        index_bytes: src.index_bytes(),
        index_requests: src.index_requests(),
    })
}

impl Report {
    /// What a normal "download the zip, then extract it" needs: the zip *and* the extracted files.
    pub fn normal_needs(&self) -> u64 {
        self.archive_size + self.totals.extracted
    }

    /// What LinkUnzip needs: only the extracted files.
    pub fn linkunzip_needs(&self) -> u64 {
        self.totals.extracted
    }

    /// The `n` biggest files by extracted size, biggest first.
    pub fn largest(&self, n: usize) -> Vec<&Entry> {
        let mut files: Vec<&Entry> = self.entries.iter().filter(|e| !e.is_dir()).collect();
        files.sort_by_key(|e| std::cmp::Reverse(e.uncompressed_size));
        files.truncate(n);
        files
    }

    /// Human-readable report; `list` adds one line per entry.
    pub fn render(&self, list: bool) -> String {
        let mut o = String::new();
        let t = &self.totals;
        let ratio = if t.extracted > 0 {
            t.compressed as f64 * 100.0 / t.extracted as f64
        } else {
            100.0
        };

        let _ = writeln!(o, "{}", style(&self.url).bold());
        let _ = writeln!(
            o,
            "  Server             Range requests supported (206 Partial Content)"
        );
        if let Some(etag) = &self.etag {
            let _ = writeln!(o, "  ETag               {etag}");
        }
        if let Some(lm) = &self.last_modified {
            let _ = writeln!(o, "  Last-Modified      {lm}");
        }
        let _ = writeln!(o, "  Archive size       {}", human_bytes(self.archive_size));
        let _ = writeln!(
            o,
            "  Index read         {} in {} request{}",
            human_bytes(self.index_bytes),
            self.index_requests,
            if self.index_requests == 1 { "" } else { "s" }
        );
        let _ = writeln!(o);
        let _ = writeln!(
            o,
            "  Files              {}  (+ {} folders)",
            t.files, t.folders
        );
        let _ = writeln!(o, "  Compressed size    {}", human_bytes(t.compressed));
        let _ = writeln!(
            o,
            "  Extracted size     {}  (compressed is {ratio:.0}% of that)",
            human_bytes(t.extracted)
        );

        if !t.unsupported.is_empty() {
            let _ = writeln!(o);
            let _ = writeln!(
                o,
                "  {} {} file(s) cannot be extracted by LinkUnzip (exclude them with --include):",
                style("!").yellow().bold(),
                t.unsupported.len()
            );
            for (name, reason) in t.unsupported.iter().take(10) {
                let _ = writeln!(o, "      {name}  ({reason})");
            }
            if t.unsupported.len() > 10 {
                let _ = writeln!(o, "      ... and {} more", t.unsupported.len() - 10);
            }
        }

        let _ = writeln!(o);
        let drive = disk::drive_label(&self.target);
        let free_text = self
            .free
            .map_or_else(|| "(unknown)".to_string(), human_bytes);
        // Pad the plain text first, then colour it: ANSI codes would throw the alignment off.
        let num = |bytes: u64| style(format!("{:>10}", human_bytes(bytes))).bold();
        let _ = writeln!(
            o,
            "  {:<34}{}",
            format!("Free space on {drive}"),
            style(format!("{free_text:>10}")).bold()
        );
        let _ = writeln!(o);
        let _ = writeln!(
            o,
            "  {:<34}{}   zip {} + extracted {}",
            "Normal download + extract needs",
            num(self.normal_needs()),
            human_bytes(self.archive_size),
            human_bytes(t.extracted)
        );
        let _ = writeln!(o, "      -> {}", self.verdict(self.normal_needs()));
        let _ = writeln!(
            o,
            "  {:<34}{}   extracted files only",
            "LinkUnzip needs",
            num(self.linkunzip_needs())
        );
        let _ = writeln!(o, "      -> {}", self.verdict(self.linkunzip_needs()));

        if list {
            let _ = writeln!(
                o,
                "\n  {:>12}  {:>12}  {:<8}  name",
                "compressed", "extracted", "method"
            );
            for e in &self.entries {
                let method = match e.method {
                    0 => "stored".to_string(),
                    8 => "deflate".to_string(),
                    m => format!("#{m}"),
                };
                let flag = if e.is_encrypted() {
                    "  [encrypted]"
                } else {
                    ""
                };
                let _ = writeln!(
                    o,
                    "  {:>12}  {:>12}  {:<8}  {}{flag}",
                    human_bytes(e.compressed_size),
                    human_bytes(e.uncompressed_size),
                    method,
                    e.name
                );
            }
        }
        o
    }

    fn verdict(&self, needed: u64) -> String {
        match self.free {
            Some(free) if needed <= free => {
                style(format!("fits, {} to spare", human_bytes(free - needed)))
                    .green()
                    .to_string()
            }
            Some(free) => style(format!(
                "DOES NOT FIT: short by {}",
                human_bytes(needed - free)
            ))
            .red()
            .bold()
            .to_string(),
            None => "free space unknown".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, method: u16, flags: u16, comp: u64, uncomp: u64) -> Entry {
        Entry {
            name: name.to_string(),
            flags,
            method,
            crc32: 0,
            compressed_size: comp,
            uncompressed_size: uncomp,
            local_header_offset: 0,
        }
    }

    #[test]
    fn totals_count_files_dirs_and_unsupported() {
        let entries = vec![
            entry("a/", 0, 0, 0, 0),
            entry("a/x.txt", 8, 0, 10, 100),
            entry("a/y.bin", 0, 0, 50, 50),
            entry("a/z.bz2", 12, 0, 5, 500),
            entry("secret.txt", 8, 1, 7, 70),
        ];
        let t = totals(&entries);
        assert_eq!(
            (t.files, t.dirs, t.compressed, t.extracted),
            (4, 1, 72, 720)
        );
        assert_eq!(t.folders, 1, "a/ is counted once");
        let implied = totals(&[
            entry("x/y/z.txt", 8, 0, 1, 1),
            entry(r"x\w.txt", 8, 0, 1, 1),
            entry("top.txt", 8, 0, 1, 1),
        ]);
        assert_eq!((implied.dirs, implied.folders), (0, 2), "x/ and x/y/");
        assert_eq!(t.unsupported.len(), 2);
        assert!(t.unsupported[0].1.contains("bzip2"));
        assert_eq!(t.unsupported[1].1, "encrypted");
    }

    #[test]
    fn report_numbers_and_verdicts() {
        let entries = vec![entry("big.bin", 8, 0, 600, 1000)];
        let report = Report {
            url: "http://x/y.zip".into(),
            archive_size: 700,
            etag: None,
            last_modified: None,
            totals: totals(&entries),
            entries,
            target: PathBuf::from("."),
            free: Some(1200),
            index_bytes: 4096,
            index_requests: 2,
        };
        assert_eq!(report.normal_needs(), 1700);
        assert_eq!(report.linkunzip_needs(), 1000);
        let text = report.render(false);
        assert!(text.contains("DOES NOT FIT"), "{text}");
        assert!(text.contains("fits"), "{text}");
        assert!(text.contains("Normal download + extract needs"), "{text}");
        assert!(text.contains("LinkUnzip needs"), "{text}");
        assert!(
            text.contains("Index read         4.0 KB in 2 requests"),
            "{text}"
        );
    }
}
