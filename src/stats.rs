//! Live counters shared by the extraction workers and the progress display.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub struct Stats {
    // Fixed before extraction starts.
    pub total_files: u64,
    /// Compressed bytes we expect to read for the selected files (the progress bar's length).
    pub total_compressed: u64,
    /// Bytes the selected files will occupy once extracted.
    pub total_extracted: u64,
    /// Bytes spent before extracting: the probe, the end records and the central directory.
    /// Not part of `downloaded` (the progress bar measures the files), but part of every
    /// "downloaded" total shown to people.
    pub index_bytes: u64,
    /// Selected files already in the folder from an earlier run (resume): not in the totals
    /// above, so a resumed job's progress can still be shown against the whole selection.
    pub skipped_files: u64,
    pub skipped_compressed: u64,
    pub skipped_extracted: u64,

    // Updated while running.
    /// Compressed payload bytes received and consumed so far.
    pub downloaded: AtomicU64,
    /// Bytes of extracted file data written to disk so far.
    pub extracted: AtomicU64,
    /// Files completely written, CRC-checked and renamed into place.
    pub files_done: AtomicU64,
    /// Entries restarted after a network error.
    pub retries: AtomicU64,
    /// HTTP requests made: the index reads, then one per span plus one per retry.
    pub requests: AtomicU64,
    /// Bytes of ZIP data written to disk by this tool. There is no code path that does this,
    /// so it stays 0. The "Zip stored on disk: 0 B" line in the UI reads this counter.
    pub zip_bytes_on_disk: AtomicU64,
    /// Which file each worker is on right now (for the progress display).
    active: Mutex<BTreeMap<usize, String>>,
}

impl Stats {
    /// Counters for an extraction that has already spent `index_bytes` in `index_requests` on the
    /// index (both 0 in stream mode).
    pub fn with_index(
        total_files: u64,
        total_compressed: u64,
        total_extracted: u64,
        index_bytes: u64,
        index_requests: u64,
    ) -> Self {
        let stats = Stats {
            index_bytes,
            ..Stats::new(total_files, total_compressed, total_extracted)
        };
        stats.requests.store(index_requests, Ordering::Relaxed);
        stats
    }

    /// The same counters, knowing that `files` selected files (`compressed` bytes in the zip,
    /// `extracted` on disk) were already in the folder and are skipped.
    pub fn with_skipped(self, files: u64, compressed: u64, extracted: u64) -> Self {
        Stats {
            skipped_files: files,
            skipped_compressed: compressed,
            skipped_extracted: extracted,
            ..self
        }
    }

    pub fn new(total_files: u64, total_compressed: u64, total_extracted: u64) -> Self {
        Stats {
            total_files,
            total_compressed,
            total_extracted,
            index_bytes: 0,
            skipped_files: 0,
            skipped_compressed: 0,
            skipped_extracted: 0,
            downloaded: AtomicU64::new(0),
            extracted: AtomicU64::new(0),
            files_done: AtomicU64::new(0),
            retries: AtomicU64::new(0),
            requests: AtomicU64::new(0),
            zip_bytes_on_disk: AtomicU64::new(0),
            active: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn set_active(&self, worker: usize, name: &str) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(worker, name.to_string());
    }

    pub fn clear_active(&self, worker: usize) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&worker);
    }

    /// Names of the files being worked on, in worker order.
    pub fn active_names(&self) -> Vec<String> {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }

    pub fn downloaded(&self) -> u64 {
        self.downloaded.load(Ordering::Relaxed)
    }
    pub fn extracted(&self) -> u64 {
        self.extracted.load(Ordering::Relaxed)
    }
    pub fn files_done(&self) -> u64 {
        self.files_done.load(Ordering::Relaxed)
    }
}
