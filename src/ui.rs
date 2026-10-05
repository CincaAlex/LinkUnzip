//! The demo-friendly output: a live three-line display while extracting and a summary at the end.
//!
//! ```text
//! ⠹ [00:01:12] [██████████████████░░░░░░░░░░░░░░░░░░░░░░]  45%  8.12 GB / 18.00 GB  410.2 MB/s  ETA 00:00:25
//! Files 120/400  |  now: warehouse/csv/transactions_0042.csv, media/raw/capture_0007.bin (+2 more)
//! Zip stored on disk: 0 B | Extracted so far: 10.90 GB | Free space: 19.10 GB
//! ```

use std::fmt::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use indicatif::{MultiProgress, ProgressBar, ProgressDrawTarget, ProgressStyle};

use crate::disk;
use crate::extract::Summary;
use crate::fmt::{hms, human_bytes, human_duration};
use crate::stats::Stats;

/// Smoothed transfer speed: an exponentially weighted moving average, so the number (and the ETA
/// computed from it) doesn't jump around with every update.
pub struct RateMeter {
    last_bytes: u64,
    rate: Option<f64>,
}

impl RateMeter {
    const ALPHA: f64 = 0.3;

    pub fn new() -> Self {
        RateMeter {
            last_bytes: 0,
            rate: None,
        }
    }

    /// Feed the byte total observed `dt` after the previous call; returns bytes per second.
    pub fn update(&mut self, dt: Duration, bytes: u64) -> f64 {
        if dt.is_zero() {
            return self.rate.unwrap_or(0.0);
        }
        // The total can briefly go *down* when a failed attempt is rolled back: count that as 0.
        let instant = bytes.saturating_sub(self.last_bytes) as f64 / dt.as_secs_f64();
        self.last_bytes = bytes;
        let smoothed = match self.rate {
            None => instant,
            Some(old) => Self::ALPHA * instant + (1.0 - Self::ALPHA) * old,
        };
        self.rate = Some(smoothed);
        smoothed
    }
}

impl Default for RateMeter {
    fn default() -> Self {
        Self::new()
    }
}

/// `00:00:25`, or `--:--:--` when we cannot tell yet.
pub fn eta(remaining: u64, bytes_per_sec: f64) -> String {
    if remaining == 0 {
        return hms(Duration::ZERO);
    }
    if bytes_per_sec < 1.0 {
        return "--:--:--".to_string();
    }
    hms(Duration::from_secs_f64(remaining as f64 / bytes_per_sec))
}

/// `a.csv, b.log (+2 more)` for the files currently being extracted.
pub fn active_files_text(names: &[String]) -> String {
    const SHOWN: usize = 3;
    if names.is_empty() {
        return "-".to_string();
    }
    let mut text = names
        .iter()
        .take(SHOWN)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > SHOWN {
        let _ = write!(text, " (+{} more)", names.len() - SHOWN);
    }
    text
}

/// The live status line from the demo script.
pub fn status_line(zip_on_disk: u64, extracted: u64, free: Option<u64>) -> String {
    let free = free.map_or_else(|| "?".to_string(), human_bytes);
    format!(
        "Zip stored on disk: {} | Extracted so far: {} | Free space: {free}",
        human_bytes(zip_on_disk),
        human_bytes(extracted)
    )
}

/// Draw the live display until `stop` is set. Run this on its own thread.
/// Draws nothing if stderr is not a terminal.
pub fn show_progress(stats: &Stats, dest: &Path, stop: &AtomicBool) {
    let multi = MultiProgress::with_draw_target(ProgressDrawTarget::stderr_with_hz(10));
    // `--stream` from a server that does not announce the file size has no total to draw a bar for.
    let known_total = stats.total_compressed > 0;
    let bar = multi.add(ProgressBar::new(stats.total_compressed.max(1)));
    bar.set_style(if known_total {
        ProgressStyle::with_template(
            "{spinner:.green} [{elapsed_precise}] [{bar:32.cyan/blue}] {percent:>3}%  {msg}",
        )
        .expect("valid template")
        .progress_chars("█▉▊▋▌▍▎▏ ")
    } else {
        ProgressStyle::with_template("{spinner:.green} [{elapsed_precise}] {msg}")
            .expect("valid template")
    });
    let files = multi.add(ProgressBar::new_spinner());
    let disk_line = multi.add(ProgressBar::new_spinner());
    let plain = ProgressStyle::with_template("{wide_msg}").expect("valid template");
    files.set_style(plain.clone());
    disk_line.set_style(plain);
    bar.enable_steady_tick(Duration::from_millis(100));

    let mut meter = RateMeter::new();
    let mut last = Instant::now();
    loop {
        let finished = stop.load(Ordering::Relaxed);
        let now = Instant::now();
        let downloaded = stats.downloaded();
        let rate = meter.update(now - last, downloaded);
        last = now;

        let total = stats.total_compressed;
        bar.set_position(downloaded.min(total));
        bar.set_message(if known_total {
            format!(
                "{} / {}  {}/s  ETA {}",
                human_bytes(downloaded),
                human_bytes(total),
                human_bytes(rate as u64),
                eta(total.saturating_sub(downloaded), rate)
            )
        } else {
            format!(
                "{} downloaded  {}/s",
                human_bytes(downloaded),
                human_bytes(rate as u64)
            )
        });
        let progress = if stats.total_files > 0 {
            format!("{}/{}", stats.files_done(), stats.total_files)
        } else {
            stats.files_done().to_string() // sequential mode: the count is not known up front
        };
        files.set_message(format!(
            "Files {progress}  |  now: {}",
            active_files_text(&stats.active_names())
        ));
        let zip_on_disk = stats.zip_bytes_on_disk.load(Ordering::Relaxed);
        disk_line.set_message(status_line(
            zip_on_disk,
            stats.extracted(),
            disk::free_space(dest).ok(),
        ));

        if finished {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    // Leave the final numbers on screen (the summary is printed below them).
    bar.abandon();
    files.abandon();
    disk_line.abandon();
}

/// The closing report: time, counts, CRC verification and the headline disk comparison.
pub fn render_summary(s: &Summary) -> String {
    let mut o = String::new();
    let secs = s.elapsed.as_secs_f64().max(0.001);
    let _ = writeln!(o, "\nDone in {}", human_duration(s.elapsed));
    let _ = writeln!(
        o,
        "  Files extracted      {}  (+ {} folders)",
        s.files, s.dirs
    );
    if s.skipped_files > 0 {
        let _ = writeln!(
            o,
            "  Skipped              {} file{} already in the folder (verified), {}",
            s.skipped_files,
            if s.skipped_files == 1 { "" } else { "s" },
            human_bytes(s.skipped_bytes)
        );
    }
    let _ = writeln!(
        o,
        "  CRC-32               all {} files verified OK",
        s.verified_files
    );
    // Everything that came over the network, the index included, so the number matches what
    // a network monitor shows.
    let amount = if s.sequential {
        human_bytes(s.downloaded_bytes)
    } else {
        format!(
            "{} (index {} + files {})",
            human_bytes(s.downloaded_bytes),
            human_bytes(s.index_bytes),
            human_bytes(s.downloaded_bytes.saturating_sub(s.index_bytes))
        )
    };
    let _ = writeln!(
        o,
        "  Downloaded           {amount} in {} {}request{}  (avg {}/s)",
        s.requests,
        if s.sequential { "sequential " } else { "" },
        if s.requests == 1 { "" } else { "s" },
        human_bytes((s.downloaded_bytes as f64 / secs) as u64)
    );
    let _ = writeln!(
        o,
        "  Written to disk      {} (extracted files only)",
        human_bytes(s.extracted_bytes)
    );
    let _ = writeln!(
        o,
        "  Zip stored on disk   {}",
        human_bytes(s.zip_bytes_on_disk)
    );
    if s.retries > 0 {
        let _ = writeln!(
            o,
            "  Network retries      {} (each restarted only the interrupted file)",
            s.retries
        );
    }
    if !s.renames.is_empty() {
        let _ = writeln!(
            o,
            "  Renamed for Windows  {} entr{}:",
            s.renames.len(),
            if s.renames.len() == 1 { "y" } else { "ies" }
        );
        for (from, to) in s.renames.iter().take(5) {
            let _ = writeln!(o, "      {from}  ->  {to}");
        }
        if s.renames.len() > 5 {
            let _ = writeln!(o, "      ... and {} more", s.renames.len() - 5);
        }
    }
    let _ = writeln!(
        o,
        "\nNormal download + extract would have needed {}; LinkUnzip needed {}.",
        human_bytes(s.normal_needs()),
        human_bytes(s.extracted_bytes)
    );
    o
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_meter_smooths_and_survives_rollbacks() {
        let mut m = RateMeter::new();
        let one_sec = Duration::from_secs(1);
        assert_eq!(
            m.update(one_sec, 1000),
            1000.0,
            "first sample is taken as is"
        );
        // 2000 B in the next second: 0.3 * 2000 + 0.7 * 1000 = 1300
        assert!((m.update(one_sec, 3000) - 1300.0).abs() < 1e-6);
        // a rollback (total goes down) counts as zero progress, not a negative rate
        let after_rollback = m.update(one_sec, 2500);
        assert!(
            (after_rollback - 0.7 * 1300.0).abs() < 1e-6,
            "{after_rollback}"
        );
        // zero elapsed time must not divide by zero
        assert_eq!(m.update(Duration::ZERO, 9999), after_rollback);
    }

    #[test]
    fn eta_formatting() {
        assert_eq!(eta(0, 0.0), "00:00:00");
        assert_eq!(eta(100, 0.0), "--:--:--");
        assert_eq!(eta(100 * 1024 * 1024, 10.0 * 1024.0 * 1024.0), "00:00:10");
        assert_eq!(eta(3600, 1.0), "01:00:00");
    }

    #[test]
    fn active_file_names_are_abbreviated() {
        let names: Vec<String> = ["a", "b", "c", "d", "e"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(active_files_text(&[]), "-");
        assert_eq!(active_files_text(&names[..2]), "a, b");
        assert_eq!(active_files_text(&names), "a, b, c (+2 more)");
    }

    #[test]
    fn status_line_matches_the_demo_script() {
        let gb = 1024u64 * 1024 * 1024;
        assert_eq!(
            status_line(0, 10 * gb, Some(19 * gb)),
            "Zip stored on disk: 0 B | Extracted so far: 10.00 GB | Free space: 19.00 GB"
        );
        assert!(status_line(0, 0, None).ends_with("Free space: ?"));
    }

    #[test]
    fn summary_has_everything_the_video_needs() {
        let gb = 1024u64 * 1024 * 1024;
        let s = Summary {
            files: 400,
            dirs: 12,
            extracted_bytes: 24 * gb,
            downloaded_bytes: 18 * gb + 12 * 1024 * 1024,
            index_bytes: 12 * 1024 * 1024,
            verified_files: 400,
            skipped_files: 0,
            skipped_bytes: 0,
            archive_size: 18 * gb,
            elapsed: Duration::from_secs(83),
            retries: 2,
            spans: 4,
            requests: 6,
            zip_bytes_on_disk: 0,
            renames: vec![("con.txt".into(), "_con.txt".into())],
            sequential: false,
        };
        let text = render_summary(&s);
        assert!(text.contains("Done in 1m 23s"), "{text}");
        assert!(text.contains("all 400 files verified OK"), "{text}");
        assert!(text.contains("Zip stored on disk   0 B"), "{text}");
        assert!(text.contains("con.txt  ->  _con.txt"), "{text}");
        assert!(text.contains("Network retries      2"), "{text}");
        assert!(
            text.contains(
                "Downloaded           18.01 GB (index 12.0 MB + files 18.00 GB) in 6 requests"
            ),
            "{text}"
        );
        assert!(
            text.contains(
                "Normal download + extract would have needed 42.00 GB; LinkUnzip needed 24.00 GB."
            ),
            "{text}"
        );

        // Stream mode: the whole file is the download, there is no index line.
        let streamed = render_summary(&Summary {
            downloaded_bytes: 18 * gb,
            index_bytes: 0,
            requests: 1,
            sequential: true,
            ..s
        });
        assert!(
            streamed.contains("Downloaded           18.00 GB in 1 sequential request "),
            "{streamed}"
        );
        assert!(!text.contains("Skipped"), "{text}");

        // A resumed run says what it did not have to download again.
        let resumed = render_summary(&Summary {
            files: 3,
            skipped_files: 397,
            skipped_bytes: 23 * gb,
            verified_files: 400,
            renames: Vec::new(),
            ..streamed_base()
        });
        assert!(
            resumed.contains(
                "Skipped              397 files already in the folder (verified), 23.00 GB"
            ),
            "{resumed}"
        );
        assert!(resumed.contains("all 400 files verified OK"), "{resumed}");
    }

    fn streamed_base() -> Summary {
        Summary {
            files: 0,
            dirs: 0,
            extracted_bytes: 0,
            downloaded_bytes: 0,
            index_bytes: 0,
            verified_files: 0,
            skipped_files: 0,
            skipped_bytes: 0,
            archive_size: 0,
            elapsed: Duration::from_secs(1),
            retries: 0,
            spans: 1,
            requests: 1,
            zip_bytes_on_disk: 0,
            renames: Vec::new(),
            sequential: true,
        }
    }
}
