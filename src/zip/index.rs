//! Read the archive's index over HTTP with as few Range requests as possible.

use std::borrow::Cow;

use anyhow::{Context, Result, ensure};

use super::central::{Entry, parse_central_directory};
use super::eocd::{self, TAIL_WINDOW, TailInfo, ZIP64_EOCD_MIN_LEN};
use crate::error::{Coded, ErrorCode};
use crate::http::{Source, looks_like_html};

/// A central directory bigger than this is treated as hostile (it would be held in memory).
const MAX_CENTRAL_DIR_BYTES: u64 = 1 << 30;

/// The parsed central directory plus where it starts (everything before that offset is entry data).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveIndex {
    pub entries: Vec<Entry>,
    pub central_dir_offset: u64,
}

/// Fetch and parse the central directory of the remote archive.
///
/// Requests: (1) the last ~64 KB, which holds the EOCD (and usually the ZIP64 locator);
/// (2) for ZIP64 archives whose ZIP64 EOCD record is not in that tail, 56 bytes at its offset;
/// (3) the whole central directory in one request, unless it already fits in the tail we have.
pub fn read_index(src: &Source) -> Result<ArchiveIndex> {
    let size = src.size;
    if size < 22 {
        return Err(Coded::new(
            ErrorCode::NotZip,
            format!("the file is only {size} bytes: too small to be a ZIP archive"),
        )
        .into());
    }

    let tail_start = size - size.min(TAIL_WINDOW);
    let tail = src
        .get_bytes(tail_start, size - 1)
        .context("reading the end of the archive")?;

    let tail_info = eocd::parse_tail(&tail).map_err(|e| {
        // A small web page served with Range support and no Content-Type gets past the one-byte
        // probe; here the whole file is in hand and can be recognised.
        if tail_start == 0 && looks_like_html(None, &tail) {
            Coded::new(
                ErrorCode::HtmlPage,
                "the server sent a web page (HTML), not a ZIP file",
            )
            .with_status(206)
            .into()
        } else {
            e
        }
    })?;
    let loc = match tail_info {
        TailInfo::Classic(loc) => loc,
        TailInfo::Zip64 { zip64_eocd_offset } => {
            let rec = slice_of(
                &tail,
                tail_start,
                zip64_eocd_offset,
                ZIP64_EOCD_MIN_LEN as u64,
            );
            let rec = match rec {
                Some(r) => Cow::Borrowed(r),
                None => {
                    let end = zip64_eocd_offset.checked_add(ZIP64_EOCD_MIN_LEN as u64);
                    ensure!(
                        end.is_some_and(|e| e <= size),
                        "the ZIP64 locator points outside the file"
                    );
                    Cow::Owned(
                        src.get_bytes(
                            zip64_eocd_offset,
                            zip64_eocd_offset + ZIP64_EOCD_MIN_LEN as u64 - 1,
                        )
                        .context("reading the ZIP64 end-of-central-directory record")?,
                    )
                }
            };
            eocd::parse_zip64_eocd(&rec)?
        }
    };

    ensure!(
        loc.offset
            .checked_add(loc.size)
            .is_some_and(|end| end <= size),
        "the central directory (offset {}, {} bytes) lies outside the {size}-byte file",
        loc.offset,
        loc.size
    );
    ensure!(
        loc.size <= MAX_CENTRAL_DIR_BYTES,
        "the central directory claims to be {} bytes: refusing",
        loc.size
    );
    if loc.entry_count == 0 {
        return Ok(ArchiveIndex {
            entries: Vec::new(),
            central_dir_offset: loc.offset,
        });
    }

    let cd = match slice_of(&tail, tail_start, loc.offset, loc.size) {
        Some(bytes) => Cow::Borrowed(bytes), // small archive: already downloaded with the tail
        None => Cow::Owned(
            src.get_bytes(loc.offset, loc.offset + loc.size - 1)
                .context("reading the central directory")?,
        ),
    };
    let entries = parse_central_directory(&cd, loc.entry_count)?;
    Ok(ArchiveIndex {
        entries,
        central_dir_offset: loc.offset,
    })
}

/// `buf` holds the file bytes starting at `buf_start`; return `len` bytes at absolute `offset`
/// if they are all inside `buf`.
fn slice_of(buf: &[u8], buf_start: u64, offset: u64, len: u64) -> Option<&[u8]> {
    let rel = offset.checked_sub(buf_start)?;
    let end = rel.checked_add(len)?;
    buf.get(usize::try_from(rel).ok()?..usize::try_from(end).ok()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_of_only_returns_fully_contained_ranges() {
        let buf = [10u8, 11, 12, 13, 14];
        assert_eq!(slice_of(&buf, 100, 101, 3), Some(&buf[1..4]));
        assert_eq!(slice_of(&buf, 100, 100, 5), Some(&buf[..]));
        assert_eq!(slice_of(&buf, 100, 99, 2), None, "starts before the buffer");
        assert_eq!(slice_of(&buf, 100, 103, 3), None, "runs past the buffer");
        assert_eq!(slice_of(&buf, 100, u64::MAX, 2), None, "overflow");
    }
}
