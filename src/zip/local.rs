//! The local file header that sits in front of each entry's data.

use anyhow::{Result, ensure};

use super::{u16_at, u32_at};

/// "PK\x03\x04": local file header.
pub const LOCAL_SIG: u32 = 0x0403_4b50;
/// Fixed part of the local header; the name and extra field follow, then the entry data.
pub const LOCAL_FIXED_LEN: usize = 30;

/// The only parts of the local header we need: how long the variable part is.
///
/// Everything else (sizes, CRC, method) comes from the central directory. That is deliberate:
/// when the "data descriptor" flag (bit 3) is set, the local header's sizes are zero. Also,
/// the local *extra field* can have a different length than the central directory's copy of it
/// (e.g. a ZIP64 block only in one of them), so we must read the length from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalHeader {
    pub name_len: u16,
    pub extra_len: u16,
}

impl LocalHeader {
    pub fn parse(b: &[u8; LOCAL_FIXED_LEN]) -> Result<Self> {
        // Local file header layout:
        //   0  u32 signature 0x04034b50     4  u16 version needed     6  u16 flags
        //   8  u16 method                   10 u16 mod time           12 u16 mod date
        //   14 u32 CRC-32                   18 u32 compressed size    22 u32 uncompressed size
        //   26 u16 name length              28 u16 extra field length
        //   30 name, then extra field, then the entry data
        ensure!(
            u32_at(b, 0) == LOCAL_SIG,
            "expected a local file header (PK\\x03\\x04) but found something else: wrong offset or corrupt archive"
        );
        Ok(LocalHeader {
            name_len: u16_at(b, 26),
            extra_len: u16_at(b, 28),
        })
    }

    /// Bytes between the end of the fixed header and the start of the entry data.
    pub fn variable_len(&self) -> u64 {
        self.name_len as u64 + self.extra_len as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(name_len: u16, extra_len: u16) -> [u8; LOCAL_FIXED_LEN] {
        let mut h = [0u8; LOCAL_FIXED_LEN];
        h[0..4].copy_from_slice(&LOCAL_SIG.to_le_bytes());
        h[26..28].copy_from_slice(&name_len.to_le_bytes());
        h[28..30].copy_from_slice(&extra_len.to_le_bytes());
        h
    }

    #[test]
    fn parses_name_and_extra_lengths() {
        let lh = LocalHeader::parse(&header(9, 20)).unwrap();
        assert_eq!((lh.name_len, lh.extra_len), (9, 20));
        assert_eq!(lh.variable_len(), 29);
    }

    #[test]
    fn rejects_wrong_signature() {
        let mut h = header(1, 1);
        h[0] = 0;
        assert!(LocalHeader::parse(&h).is_err());
    }
}
