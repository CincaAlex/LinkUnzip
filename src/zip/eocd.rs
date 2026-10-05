//! The End Of Central Directory record (EOCD), the ZIP64 locator and the ZIP64 EOCD record.
//!
//! Layout at the very end of a ZIP file:
//!
//! ```text
//!   ... central directory | [ZIP64 EOCD record] [ZIP64 locator (20 B)] | EOCD (22 B) + comment
//! ```
//!
//! The EOCD is the only structure with a fixed position relative to the end of the file, so
//! that is where we start. The classic EOCD uses 16/32-bit fields; archives that don't fit set
//! them to 0xFFFF / 0xFFFFFFFF and put the real 64-bit values in the ZIP64 EOCD record, which
//! is found through the locator that sits directly in front of the EOCD.

use anyhow::{Result, bail, ensure};

use super::{u16_at, u32_at, u64_at};
use crate::error::{Coded, ErrorCode};

/// "PK\x05\x06": End Of Central Directory.
pub const EOCD_SIG: u32 = 0x0605_4b50;
/// "PK\x06\x07": ZIP64 EOCD locator.
pub const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
/// "PK\x06\x06": ZIP64 EOCD record.
pub const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;

/// EOCD without its trailing comment.
const EOCD_LEN: usize = 22;
const ZIP64_LOCATOR_LEN: usize = 20;
/// Fixed part of the ZIP64 EOCD record (an "extensible data sector" may follow; we ignore it).
pub const ZIP64_EOCD_MIN_LEN: usize = 56;

/// How many bytes at the end of the file we need to be sure to see the EOCD and the locator:
/// the EOCD comment is at most 65535 bytes, plus the 22-byte record and the 20-byte locator.
/// (That is "the last 64 KB", plus the few bytes a maximum-length comment would push out.)
pub const TAIL_WINDOW: u64 = 65_535 + EOCD_LEN as u64 + ZIP64_LOCATOR_LEN as u64;

/// Where the central directory is and how many entries it has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CentralDirLocation {
    pub entry_count: u64,
    pub size: u64,
    pub offset: u64,
}

/// What the tail of the file told us.
#[derive(Debug, PartialEq, Eq)]
pub enum TailInfo {
    /// A plain archive: the classic EOCD has everything.
    Classic(CentralDirLocation),
    /// A ZIP64 locator was present: the real values live in the ZIP64 EOCD record at this
    /// absolute file offset (fetch it, then call [`parse_zip64_eocd`]).
    Zip64 { zip64_eocd_offset: u64 },
}

/// Parse the last bytes of the file (see [`TAIL_WINDOW`]); `tail` may be the whole file.
pub fn parse_tail(tail: &[u8]) -> Result<TailInfo> {
    let pos = find_eocd(tail)?;
    let rec = &tail[pos..];

    // EOCD layout (offsets from the start of the record):
    //   0  u32 signature 0x06054b50
    //   4  u16 number of this disk
    //   6  u16 disk where the central directory starts
    //   8  u16 central directory entries on this disk
    //   10 u16 central directory entries in total
    //   12 u32 size of the central directory
    //   16 u32 offset of the central directory from the start of the archive
    //   20 u16 comment length, then the comment
    let this_disk = u16_at(rec, 4);
    let cd_disk = u16_at(rec, 6);
    let entries_on_disk = u16_at(rec, 8);
    let entries_total = u16_at(rec, 10);
    let cd_size = u32_at(rec, 12);
    let cd_offset = u32_at(rec, 16);

    // The ZIP64 locator, if any, ends exactly where the EOCD starts.
    if pos >= ZIP64_LOCATOR_LEN {
        let loc = &tail[pos - ZIP64_LOCATOR_LEN..pos];
        // Locator layout: 0 u32 sig 0x07064b50 | 4 u32 disk with ZIP64 EOCD
        //                 | 8 u64 offset of ZIP64 EOCD | 16 u32 total number of disks
        if u32_at(loc, 0) == ZIP64_LOCATOR_SIG {
            ensure!(
                u32_at(loc, 16) <= 1,
                "multi-disk (split) ZIP archives are not supported"
            );
            return Ok(TailInfo::Zip64 {
                zip64_eocd_offset: u64_at(loc, 8),
            });
        }
    }

    if entries_total == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        bail!("the EOCD record says this is a ZIP64 archive, but there is no ZIP64 locator");
    }
    ensure!(
        this_disk == 0 && cd_disk == 0 && entries_on_disk == entries_total,
        "multi-disk (split) ZIP archives are not supported"
    );
    Ok(TailInfo::Classic(CentralDirLocation {
        entry_count: entries_total as u64,
        size: cd_size as u64,
        offset: cd_offset as u64,
    }))
}

/// Parse the ZIP64 EOCD record (`rec` must start at its signature).
pub fn parse_zip64_eocd(rec: &[u8]) -> Result<CentralDirLocation> {
    ensure!(
        rec.len() >= ZIP64_EOCD_MIN_LEN,
        "ZIP64 EOCD record is truncated"
    );
    ensure!(
        u32_at(rec, 0) == ZIP64_EOCD_SIG,
        "ZIP64 locator points at something that is not a ZIP64 EOCD record"
    );
    // ZIP64 EOCD layout:
    //   0  u32 signature 0x06064b50
    //   4  u64 size of the rest of this record (44 + extensible data)
    //   12 u16 version made by      14 u16 version needed
    //   16 u32 number of this disk  20 u32 disk where the central directory starts
    //   24 u64 entries on this disk 32 u64 entries in total
    //   40 u64 central directory size
    //   48 u64 central directory offset
    ensure!(
        u64_at(rec, 4) >= 44,
        "ZIP64 EOCD record has an invalid size field"
    );
    ensure!(
        u32_at(rec, 16) == 0 && u32_at(rec, 20) == 0 && u64_at(rec, 24) == u64_at(rec, 32),
        "multi-disk (split) ZIP archives are not supported"
    );
    Ok(CentralDirLocation {
        entry_count: u64_at(rec, 32),
        size: u64_at(rec, 40),
        offset: u64_at(rec, 48),
    })
}

/// Search backwards for the EOCD signature and return its position in `tail`.
///
/// The record is 22 bytes plus a comment of up to 65535 bytes, and the comment itself may
/// contain the bytes "PK\x05\x06". So we prefer a candidate whose comment length lands exactly
/// on the end of the file; failing that, we accept the last candidate that fits (some tools
/// append trailing junk after the EOCD).
fn find_eocd(tail: &[u8]) -> Result<usize> {
    if tail.len() < EOCD_LEN {
        return Err(Coded::new(ErrorCode::NotZip, "file is too small to be a ZIP archive").into());
    }
    let mut fallback = None;
    for pos in (0..=tail.len() - EOCD_LEN).rev() {
        if u32_at(tail, pos) != EOCD_SIG {
            continue;
        }
        let end = pos + EOCD_LEN + u16_at(tail, pos + 20) as usize;
        if end == tail.len() {
            return Ok(pos);
        }
        if end < tail.len() && fallback.is_none() {
            fallback = Some(pos);
        }
    }
    fallback.ok_or_else(|| {
        Coded::new(
            ErrorCode::NotZip,
            "no End Of Central Directory record found: this does not look like a ZIP file",
        )
        .into()
    })
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    fn classic(entry_count: u64, size: u64, offset: u64) -> TailInfo {
        TailInfo::Classic(CentralDirLocation {
            entry_count,
            size,
            offset,
        })
    }

    #[test]
    fn plain_eocd_at_end_of_a_tiny_file() {
        let mut file = vec![0u8; 100]; // pretend file data + central directory
        file.extend(eocd(3, 40, 60, b""));
        assert_eq!(parse_tail(&file).unwrap(), classic(3, 40, 60));
    }

    #[test]
    fn eocd_with_comment() {
        let mut file = vec![0u8; 10];
        file.extend(eocd(1, 5, 5, b"hello world"));
        assert_eq!(parse_tail(&file).unwrap(), classic(1, 5, 5));
    }

    #[test]
    fn signature_inside_comment_is_not_mistaken_for_the_eocd() {
        // The comment contains a complete fake EOCD signature followed by garbage fields.
        let comment = b"PK\x05\x06 fake fake fake fake fake fake";
        let mut file = vec![0u8; 10];
        file.extend(eocd(7, 123, 456, comment));
        assert_eq!(parse_tail(&file).unwrap(), classic(7, 123, 456));
    }

    #[test]
    fn trailing_junk_after_the_eocd_is_tolerated() {
        let mut file = vec![0u8; 10];
        file.extend(eocd(2, 8, 2, b""));
        file.extend(b"JUNK");
        assert_eq!(parse_tail(&file).unwrap(), classic(2, 8, 2));
    }

    #[test]
    fn missing_eocd_is_an_error() {
        let err = parse_tail(&[0u8; 200]).unwrap_err();
        assert!(
            err.to_string().contains("End Of Central Directory"),
            "{err}"
        );
        assert_eq!(err.downcast_ref::<Coded>().unwrap().code, ErrorCode::NotZip);
        let err = parse_tail(&[0u8; 5]).unwrap_err();
        assert_eq!(err.downcast_ref::<Coded>().unwrap().code, ErrorCode::NotZip);
    }

    #[test]
    fn comment_length_pointing_past_eof_is_rejected() {
        let mut bad = eocd(1, 1, 1, b"");
        bad[20] = 50; // claim a 50-byte comment that is not there
        assert!(parse_tail(&bad).is_err());
    }

    #[test]
    fn zip64_locator_is_detected_and_points_at_the_zip64_record() {
        let mut file = vec![0u8; 30];
        file.extend(zip64_locator(0x1_0000_0000));
        file.extend(eocd(0xFFFF, 0xFFFF_FFFF, 0xFFFF_FFFF, b"c"));
        assert_eq!(
            parse_tail(&file).unwrap(),
            TailInfo::Zip64 {
                zip64_eocd_offset: 0x1_0000_0000
            }
        );
    }

    #[test]
    fn sentinel_values_without_a_locator_are_an_error() {
        let file = eocd(0xFFFF, 10, 10, b"");
        let err = parse_tail(&file).unwrap_err().to_string();
        assert!(err.contains("ZIP64"), "{err}");
    }

    #[test]
    fn multi_disk_archives_are_rejected() {
        let mut file = eocd(1, 1, 1, b"");
        file[4] = 1; // this disk = 1
        assert!(
            parse_tail(&file)
                .unwrap_err()
                .to_string()
                .contains("multi-disk")
        );
    }

    #[test]
    fn zip64_eocd_record_roundtrip() {
        let rec = zip64_eocd(70_000, 5_000_000, 6_000_000_000);
        let loc = parse_zip64_eocd(&rec).unwrap();
        assert_eq!(
            loc,
            CentralDirLocation {
                entry_count: 70_000,
                size: 5_000_000,
                offset: 6_000_000_000
            }
        );
    }

    #[test]
    fn zip64_eocd_record_with_extensible_data_still_parses() {
        let mut rec = zip64_eocd(1, 2, 3);
        rec.extend([0xAA; 10]); // extensible data sector
        assert_eq!(parse_zip64_eocd(&rec).unwrap().offset, 3);
    }

    #[test]
    fn zip64_eocd_record_rejects_bad_input() {
        let good = zip64_eocd(1, 2, 3);
        assert!(parse_zip64_eocd(&good[..40]).is_err(), "truncated");
        let mut bad_sig = good.clone();
        bad_sig[0] = b'X';
        assert!(parse_zip64_eocd(&bad_sig).is_err(), "wrong signature");
        let mut bad_size = good.clone();
        bad_size[4] = 10;
        assert!(parse_zip64_eocd(&bad_size).is_err(), "bad size field");
        let mut split = good;
        split[16] = 1;
        assert!(parse_zip64_eocd(&split).is_err(), "multi-disk");
    }
}
