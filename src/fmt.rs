//! Small formatting helpers shared by `inspect`, the progress UI and the summary.

use std::time::Duration;

/// Format a byte count the way Windows Explorer does: 1024-based steps, labelled
/// KB/MB/GB/TB. The demo compares our numbers with Explorer's drive bar, so the units must match.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if n < 1024 {
        return format!("{n} B");
    }
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    // Two decimals from GB up (that is where the demo's numbers live), one below.
    if unit >= 3 {
        format!("{value:.2} {}", UNITS[unit])
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// `83` -> `00:01:23`. Used for elapsed time and ETA.
pub fn hms(d: Duration) -> String {
    let s = d.as_secs();
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

/// `1.4s`, `1m 23s`, `2h 05m`, for the final summary.
pub fn human_duration(d: Duration) -> String {
    let s = d.as_secs_f64();
    if s < 60.0 {
        format!("{s:.1}s")
    } else if s < 3600.0 {
        format!("{}m {:02}s", (s / 60.0) as u64, (s % 60.0) as u64)
    } else {
        format!(
            "{}h {:02}m",
            (s / 3600.0) as u64,
            ((s % 3600.0) / 60.0) as u64
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_use_explorer_style_units() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024 + 512 * 1024), "5.5 MB");
        assert_eq!(human_bytes(24 * 1024 * 1024 * 1024), "24.00 GB");
    }

    #[test]
    fn durations() {
        assert_eq!(hms(Duration::from_secs(83)), "00:01:23");
        assert_eq!(human_duration(Duration::from_millis(1400)), "1.4s");
        assert_eq!(human_duration(Duration::from_secs(83)), "1m 23s");
    }
}
