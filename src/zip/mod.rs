//! A minimal ZIP reader: just enough to read the index and find each entry's bytes.
//!
//! A ZIP file looks like this (all integers are little-endian):
//!
//! ```text
//!   [local header 1][data 1][local header 2][data 2] ...      <- entries, in any order
//!   [central dir entry 1][central dir entry 2] ...             <- the index
//!   [ZIP64 EOCD record][ZIP64 EOCD locator]                    <- only for big archives
//!   [End Of Central Directory record (EOCD)]                   <- always last
//! ```
//!
//! Because the index is at the *end*, we can read it with two small HTTP Range requests and
//! then fetch only the entries we want.

pub mod central;
pub mod eocd;
pub mod index;
pub mod local;

pub use central::Entry;

// Little-endian field readers. Every caller checks the buffer length first, so these index freely.
pub(crate) fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
pub(crate) fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([b[o], b[o + 1], b[o + 2], b[o + 3]])
}
pub(crate) fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([
        b[o],
        b[o + 1],
        b[o + 2],
        b[o + 3],
        b[o + 4],
        b[o + 5],
        b[o + 6],
        b[o + 7],
    ])
}

/// Byte-level builders for unit tests: tiny writers for the records the parsers read.
#[cfg(test)]
pub(crate) mod testutil {
    pub fn eocd(entries: u16, cd_size: u32, cd_offset: u32, comment: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        v.extend_from_slice(&0u16.to_le_bytes()); // this disk
        v.extend_from_slice(&0u16.to_le_bytes()); // disk with central dir
        v.extend_from_slice(&entries.to_le_bytes()); // entries on this disk
        v.extend_from_slice(&entries.to_le_bytes()); // entries total
        v.extend_from_slice(&cd_size.to_le_bytes());
        v.extend_from_slice(&cd_offset.to_le_bytes());
        v.extend_from_slice(&(comment.len() as u16).to_le_bytes());
        v.extend_from_slice(comment);
        v
    }

    pub fn zip64_locator(zip64_eocd_offset: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes()); // disk with ZIP64 EOCD
        v.extend_from_slice(&zip64_eocd_offset.to_le_bytes());
        v.extend_from_slice(&1u32.to_le_bytes()); // total disks
        v
    }

    pub fn zip64_eocd(entries: u64, cd_size: u64, cd_offset: u64) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&0x0606_4b50u32.to_le_bytes());
        v.extend_from_slice(&44u64.to_le_bytes()); // size of the rest of this record
        v.extend_from_slice(&45u16.to_le_bytes()); // version made by
        v.extend_from_slice(&45u16.to_le_bytes()); // version needed
        v.extend_from_slice(&0u32.to_le_bytes()); // this disk
        v.extend_from_slice(&0u32.to_le_bytes()); // disk with central dir
        v.extend_from_slice(&entries.to_le_bytes()); // entries on this disk
        v.extend_from_slice(&entries.to_le_bytes()); // entries total
        v.extend_from_slice(&cd_size.to_le_bytes());
        v.extend_from_slice(&cd_offset.to_le_bytes());
        v
    }

    /// One central directory record with caller-chosen raw header values.
    #[allow(clippy::too_many_arguments)]
    pub fn central_record(
        name: &[u8],
        flags: u16,
        method: u16,
        crc: u32,
        comp: u32,
        uncomp: u32,
        offset: u32,
        extra: &[u8],
        comment: &[u8],
    ) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        v.extend_from_slice(&45u16.to_le_bytes()); // version made by
        v.extend_from_slice(&45u16.to_le_bytes()); // version needed
        v.extend_from_slice(&flags.to_le_bytes());
        v.extend_from_slice(&method.to_le_bytes());
        v.extend_from_slice(&0u16.to_le_bytes()); // mod time
        v.extend_from_slice(&0u16.to_le_bytes()); // mod date
        v.extend_from_slice(&crc.to_le_bytes());
        v.extend_from_slice(&comp.to_le_bytes());
        v.extend_from_slice(&uncomp.to_le_bytes());
        v.extend_from_slice(&(name.len() as u16).to_le_bytes());
        v.extend_from_slice(&(extra.len() as u16).to_le_bytes());
        v.extend_from_slice(&(comment.len() as u16).to_le_bytes());
        v.extend_from_slice(&0u16.to_le_bytes()); // disk number start
        v.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
        v.extend_from_slice(&0u32.to_le_bytes()); // external attrs
        v.extend_from_slice(&offset.to_le_bytes());
        v.extend_from_slice(name);
        v.extend_from_slice(extra);
        v.extend_from_slice(comment);
        v
    }

    /// An extra-field block: id, length, payload.
    pub fn extra_field(id: u16, payload: &[u8]) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        v.extend_from_slice(payload);
        v
    }

    /// A ZIP64 extended-information extra field (id 0x0001) holding the given 64-bit values.
    pub fn zip64_extra(values: &[u64]) -> Vec<u8> {
        let payload: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        extra_field(0x0001, &payload)
    }
}
