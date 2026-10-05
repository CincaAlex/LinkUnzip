//! Resume: running the same link into the same folder again skips the files that are already
//! there and correct, so a stopped or failed job picks up where it ended.
//!
//! A file counts as done when it exists with the entry's size and
//!
//! * the journal of an earlier run lists it with the same size and CRC-32 (fast: nothing is read),
//!   or
//! * its CRC-32, computed from the disk, matches the entry's (no journal, e.g. the folder came
//!   from another tool, or the journal belongs to another archive).
//!
//! The journal is `<output>\.linkunzip-resume.jsonl`: a first line with the archive's identity
//! (`{"v":1,"size":..,"etag":..,"last_modified":..}`), then one line per finished entry
//! (`{"path":..,"size":..,"crc32":..}`, `path` = the entry's name as stored in the archive),
//! appended right after the file got its name. It is deleted when the job completes. Writing it is
//! best effort: if it cannot be written, resuming falls back to reading the files.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::extract::{BUF_SIZE, part_path};
use crate::plan::PlannedFile;
use crate::safety;
use crate::zip::Entry;

/// The journal's file name, at the top of the output folder.
pub const JOURNAL_NAME: &str = ".linkunzip-resume.jsonl";

/// Which archive the journal belongs to. A journal from another file, or from another version of
/// the same URL, says nothing about this one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub v: u32,
    pub size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

impl Identity {
    pub fn new(size: u64, etag: Option<String>, last_modified: Option<String>) -> Identity {
        Identity {
            v: 1,
            size,
            // A weak ETag (`W/"x"`) names the same version as `"x"`.
            etag: etag.map(|e| e.trim().trim_start_matches("W/").to_string()),
            last_modified,
        }
    }
}

/// One finished entry.
#[derive(Debug, Serialize, Deserialize)]
struct Finished {
    path: String,
    size: u64,
    crc32: u32,
}

pub fn journal_path(root: &Path) -> PathBuf {
    root.join(JOURNAL_NAME)
}

/// The entries an earlier run of this archive finished: name -> (size, CRC-32). Empty if there is
/// no journal or it belongs to another archive. Later lines win, and a damaged line (the disk
/// filled up mid-write) is ignored.
pub fn load(root: &Path, identity: &Identity) -> HashMap<String, (u64, u32)> {
    let mut done = HashMap::new();
    let Ok(file) = File::open(journal_path(root)) else {
        return done;
    };
    let mut lines = BufReader::new(file).lines();
    let same_archive = lines
        .next()
        .and_then(|l| l.ok())
        .and_then(|l| serde_json::from_str::<Identity>(&l).ok())
        .is_some_and(|id| id == *identity);
    if !same_archive {
        return done;
    }
    for line in lines.map_while(|l| l.ok()) {
        if let Ok(f) = serde_json::from_str::<Finished>(&line) {
            done.insert(f.path, (f.size, f.crc32));
        }
    }
    done
}

/// The journal of the running job.
pub struct Journal {
    path: PathBuf,
    file: Mutex<File>,
}

impl Journal {
    /// Open the journal for this run. With `keep`, the lines of an earlier run of the same
    /// archive stay (they still describe files on disk); otherwise it starts over. `None` if it
    /// cannot be written (resuming then falls back to reading the files).
    pub fn open(root: &Path, identity: &Identity, keep: bool) -> Option<Journal> {
        let path = journal_path(root);
        let keep = keep && {
            let mut first = String::new();
            File::open(&path)
                .and_then(|f| BufReader::new(f).read_line(&mut first))
                .is_ok_and(|_| {
                    serde_json::from_str::<Identity>(&first).is_ok_and(|id| id == *identity)
                })
        };
        let file = if keep {
            hidden(OpenOptions::new().append(true)).open(&path).ok()?
        } else {
            let mut f = hidden(OpenOptions::new().write(true).create(true).truncate(true))
                .open(&path)
                .ok()?;
            writeln!(f, "{}", serde_json::to_string(identity).ok()?).ok()?;
            f
        };
        Some(Journal {
            path,
            file: Mutex::new(file),
        })
    }

    /// Note that `entry` is finished. Called right after the file got its real name; one write
    /// per line, so a crash leaves at most one damaged line behind.
    pub fn record(&self, entry: &Entry) {
        let line = serde_json::to_string(&Finished {
            path: entry.name.clone(),
            size: entry.uncompressed_size,
            crc32: entry.crc32,
        });
        if let Ok(mut line) = line {
            line.push('\n');
            let mut file = self.file.lock().unwrap_or_else(|p| p.into_inner());
            let _ = file.write_all(line.as_bytes()).and_then(|()| file.flush());
        }
    }

    /// The job completed: the journal is not needed any more.
    pub fn finish(self) {
        drop(self.file);
        let _ = fs::remove_file(&self.path);
    }
}

/// Remove the journal of a completed job that did not need one of its own (nothing was left to
/// extract, or stream mode).
pub fn remove_journal(root: &Path) {
    let _ = fs::remove_file(journal_path(root));
}

/// Keep the journal out of sight in Explorer.
fn hidden(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        options.attributes(FILE_ATTRIBUTE_HIDDEN);
    }
    options
}

/// For each of `files`, is it already in `root` and correct? Also removes the `.part` files an
/// interrupted run left behind for them. Runs on `threads` threads (files are read to compute
/// their CRC-32 when the journal does not vouch for them); stops early if `abort` is raised.
pub fn already_done(
    root: &Path,
    files: &[PlannedFile],
    journal: &HashMap<String, (u64, u32)>,
    threads: usize,
    abort: &AtomicBool,
) -> Result<Vec<bool>> {
    let done: Vec<AtomicBool> = files.iter().map(|_| AtomicBool::new(false)).collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..threads.clamp(1, files.len().max(1)) {
            scope.spawn(|| {
                let mut buf = vec![0u8; BUF_SIZE];
                while !abort.load(Ordering::Relaxed) {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(file) = files.get(i) else { break };
                    if is_done(root, file, journal, &mut buf, abort) {
                        done[i].store(true, Ordering::Relaxed);
                    }
                }
            });
        }
    });
    if abort.load(Ordering::Relaxed) {
        return Err(anyhow!("cancelled"));
    }
    Ok(done.into_iter().map(AtomicBool::into_inner).collect())
}

fn is_done(
    root: &Path,
    file: &PlannedFile,
    journal: &HashMap<String, (u64, u32)>,
    buf: &mut [u8],
    abort: &AtomicBool,
) -> bool {
    let Ok(path) = safety::join_under(root, &file.rel_path) else {
        return false;
    };
    // A stale `.part` would only be overwritten if this entry is extracted again: remove it now.
    let _ = fs::remove_file(part_path(&path));
    let entry = &file.entry;
    let size_ok =
        fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() == entry.uncompressed_size);
    if !size_ok {
        return false;
    }
    if journal.get(&entry.name) == Some(&(entry.uncompressed_size, entry.crc32)) {
        return true;
    }
    crc_of_file(&path, buf, abort).is_ok_and(|crc| crc == entry.crc32)
}

/// CRC-32 of a file on disk.
pub fn crc_of_file(path: &Path, buf: &mut [u8], abort: &AtomicBool) -> io::Result<u32> {
    let mut file = File::open(path)?;
    let mut crc = crc32fast::Hasher::new();
    loop {
        if abort.load(Ordering::Relaxed) {
            return Err(io::Error::other("cancelled"));
        }
        match file.read(buf) {
            Ok(0) => return Ok(crc.finalize()),
            Ok(n) => crc.update(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, data: &[u8]) -> Entry {
        Entry {
            name: name.into(),
            flags: 0,
            method: 0,
            crc32: crc32fast::hash(data),
            compressed_size: data.len() as u64,
            uncompressed_size: data.len() as u64,
            local_header_offset: 0,
        }
    }

    fn planned(name: &str, data: &[u8]) -> PlannedFile {
        PlannedFile {
            entry: entry(name, data),
            rel_path: PathBuf::from(name),
            region_end: 0,
        }
    }

    fn identity() -> Identity {
        Identity::new(1000, Some("W/\"v1\"".into()), None)
    }

    #[test]
    fn the_journal_round_trips_and_belongs_to_one_archive() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path(), &identity(), true).unwrap();
        journal.record(&entry("a.txt", b"hello"));
        journal.record(&entry("dir/b.txt", b"world!"));
        drop(journal);

        let done = load(dir.path(), &identity());
        assert_eq!(done.len(), 2);
        assert_eq!(done["a.txt"], (5, crc32fast::hash(b"hello")));
        // The weak and the strong form of an ETag are the same version.
        assert_eq!(
            load(
                dir.path(),
                &Identity::new(1000, Some("\"v1\"".into()), None)
            )
            .len(),
            2
        );
        // Another archive (or another version of it) gets nothing.
        assert!(
            load(
                dir.path(),
                &Identity::new(1001, Some("\"v1\"".into()), None)
            )
            .is_empty()
        );
        assert!(
            load(
                dir.path(),
                &Identity::new(1000, Some("\"v2\"".into()), None)
            )
            .is_empty()
        );

        // `keep` carries on with the same archive's journal ...
        let again = Journal::open(dir.path(), &identity(), true).unwrap();
        again.record(&entry("c.txt", b"!"));
        drop(again);
        assert_eq!(load(dir.path(), &identity()).len(), 3);
        // ... and starts over for another archive, or when told to.
        let other = Identity::new(5, None, None);
        drop(Journal::open(dir.path(), &other, true).unwrap());
        assert!(load(dir.path(), &other).is_empty());
        assert!(load(dir.path(), &identity()).is_empty());

        let j = Journal::open(dir.path(), &identity(), false).unwrap();
        j.finish();
        assert!(
            !journal_path(dir.path()).exists(),
            "removed when the job is done"
        );
    }

    #[test]
    fn damaged_lines_are_ignored_and_later_lines_win() {
        let dir = tempfile::tempdir().unwrap();
        let id = serde_json::to_string(&identity()).unwrap();
        fs::write(
            journal_path(dir.path()),
            format!(
                "{id}\n{{\"path\":\"a\",\"size\":1,\"crc32\":7}}\n{{\"path\":\"a\",\"size\":2,\"crc32\":8}}\n{{\"path\":\"b\",\"si"
            ),
        )
        .unwrap();
        let done = load(dir.path(), &identity());
        assert_eq!(done.len(), 1);
        assert_eq!(done["a"], (2, 8));
    }

    #[test]
    fn a_file_is_done_when_its_size_and_crc_match() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let files = [
            planned("same.txt", b"hello"),
            planned("missing.txt", b"hello"),
            planned("short.txt", b"hello"),
            planned("changed.txt", b"hello"),
            planned("journal_only.txt", b"hello"),
        ];
        fs::write(root.join("same.txt"), b"hello").unwrap();
        fs::write(root.join("short.txt"), b"hell").unwrap();
        fs::write(root.join("changed.txt"), b"jello").unwrap();
        // Same size, different bytes, but the journal says it was written correctly: trusted
        // without reading it (that is what makes resuming fast).
        fs::write(root.join("journal_only.txt"), b"HELLO").unwrap();
        let journal = HashMap::from([(
            "journal_only.txt".to_string(),
            (5, crc32fast::hash(b"hello")),
        )]);
        fs::write(root.join("missing.txt.part"), b"he").unwrap();

        let done = already_done(root, &files, &journal, 3, &AtomicBool::new(false)).unwrap();
        assert_eq!(done, [true, false, false, false, true]);
        assert!(
            !root.join("missing.txt.part").exists(),
            "stale .part removed"
        );

        assert!(already_done(root, &files, &journal, 2, &AtomicBool::new(true)).is_err());
    }
}
