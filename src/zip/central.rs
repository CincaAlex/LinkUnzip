//! The central directory: one record per entry, holding everything we need to extract it.

use anyhow::{Result, bail, ensure};

use super::{u16_at, u32_at, u64_at};

/// "PK\x01\x02": central directory file header.
pub const CENTRAL_SIG: u32 = 0x0201_4b50;
/// Fixed part of a central directory record; name, extra field and comment follow.
const CENTRAL_FIXED_LEN: usize = 46;
/// Header id of the ZIP64 "extended information" extra field.
const ZIP64_EXTRA_ID: u16 = 0x0001;

/// General-purpose flag bit 0: the entry is encrypted.
const FLAG_ENCRYPTED: u16 = 1 << 0;
/// General-purpose flag bit 6: strong encryption (also counts as encrypted).
const FLAG_STRONG_ENCRYPTION: u16 = 1 << 6;
/// General-purpose flag bit 11: the name (and comment) are UTF-8; otherwise they are CP437.
const FLAG_UTF8: u16 = 1 << 11;

pub const METHOD_STORED: u16 = 0;
pub const METHOD_DEFLATE: u16 = 8;

/// One file or directory in the archive, as described by the central directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Name exactly as stored (decoded to Unicode, but not sanitised: it may contain `..`).
    pub name: String,
    pub flags: u16,
    /// 0 = stored, 8 = deflate, anything else is unsupported.
    pub method: u16,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
    /// Offset of this entry's *local* file header from the start of the archive.
    pub local_header_offset: u64,
}

impl Entry {
    /// Directory entries are stored as a name ending in `/` (some Windows tools use `\`).
    pub fn is_dir(&self) -> bool {
        self.name.ends_with('/') || self.name.ends_with('\\')
    }

    pub fn is_encrypted(&self) -> bool {
        self.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION) != 0
    }

    /// Why this entry cannot be extracted by this tool, if it can't. Directories never matter.
    pub fn unsupported_reason(&self) -> Option<String> {
        if self.is_dir() {
            return None;
        }
        if self.is_encrypted() {
            return Some("encrypted".to_string());
        }
        match self.method {
            METHOD_STORED | METHOD_DEFLATE => None,
            m => Some(format!("compression method {m} ({})", method_name(m))),
        }
    }
}

fn method_name(method: u16) -> &'static str {
    match method {
        1 => "shrink",
        6 => "implode",
        9 => "deflate64",
        12 => "bzip2",
        14 => "lzma",
        93 => "zstd",
        95 => "xz",
        98 => "ppmd",
        99 => "AES encryption",
        _ => "unknown",
    }
}

/// Parse `expected_count` central directory records out of `buf` (the whole central directory).
pub fn parse_central_directory(buf: &[u8], expected_count: u64) -> Result<Vec<Entry>> {
    // Don't trust the count for pre-allocation: a hostile server could claim billions.
    let mut entries =
        Vec::with_capacity((expected_count as usize).min(buf.len() / CENTRAL_FIXED_LEN));
    let mut pos = 0usize;
    for index in 0..expected_count {
        let (entry, used) = parse_record(&buf[pos..]).map_err(|e| {
            e.context(format!(
                "central directory entry #{} (at byte {pos})",
                index + 1
            ))
        })?;
        entries.push(entry);
        pos += used;
    }
    Ok(entries)
}

/// Parse one record at the start of `rec`; returns the entry and how many bytes it occupied.
fn parse_record(rec: &[u8]) -> Result<(Entry, usize)> {
    ensure!(
        rec.len() >= CENTRAL_FIXED_LEN,
        "central directory is truncated"
    );
    ensure!(
        u32_at(rec, 0) == CENTRAL_SIG,
        "bad central directory signature (corrupt archive?)"
    );

    // Central directory record layout (offsets from the record start):
    //   0  u32 signature 0x02014b50       4  u16 version made by      6  u16 version needed
    //   8  u16 general-purpose flags      10 u16 compression method
    //   12 u16 mod time                   14 u16 mod date
    //   16 u32 CRC-32                     20 u32 compressed size      24 u32 uncompressed size
    //   28 u16 name length                30 u16 extra field length   32 u16 comment length
    //   34 u16 disk number start          36 u16 internal attrs       38 u32 external attrs
    //   42 u32 local header offset        46 name, then extra field, then comment
    let flags = u16_at(rec, 8);
    let method = u16_at(rec, 10);
    let crc32 = u32_at(rec, 16);
    let comp32 = u32_at(rec, 20);
    let uncomp32 = u32_at(rec, 24);
    let name_len = u16_at(rec, 28) as usize;
    let extra_len = u16_at(rec, 30) as usize;
    let comment_len = u16_at(rec, 32) as usize;
    let offset32 = u32_at(rec, 42);

    let total = CENTRAL_FIXED_LEN + name_len + extra_len + comment_len;
    ensure!(
        rec.len() >= total,
        "central directory is truncated inside an entry"
    );
    let name_bytes = &rec[CENTRAL_FIXED_LEN..CENTRAL_FIXED_LEN + name_len];
    let extra = &rec[CENTRAL_FIXED_LEN + name_len..CENTRAL_FIXED_LEN + name_len + extra_len];

    let mut entry = Entry {
        name: decode_name(name_bytes, flags),
        flags,
        method,
        crc32,
        compressed_size: comp32 as u64,
        uncompressed_size: uncomp32 as u64,
        local_header_offset: offset32 as u64,
    };
    apply_zip64_extra(&mut entry, extra, uncomp32, comp32, offset32)
        .map_err(|e| e.context(format!("entry {:?}", entry.name)))?;
    Ok((entry, total))
}

/// Replace 32-bit fields that are 0xFFFFFFFF with the 64-bit values from the ZIP64 extra field.
///
/// The extra field (id 0x0001) contains *only* the values whose 32-bit field was 0xFFFFFFFF,
/// always in this order: uncompressed size, compressed size, local header offset.
fn apply_zip64_extra(
    entry: &mut Entry,
    extra: &[u8],
    uncomp32: u32,
    comp32: u32,
    offset32: u32,
) -> Result<()> {
    let needs_uncomp = uncomp32 == 0xFFFF_FFFF;
    let needs_comp = comp32 == 0xFFFF_FFFF;
    let needs_offset = offset32 == 0xFFFF_FFFF;
    if !(needs_uncomp || needs_comp || needs_offset) {
        return Ok(());
    }

    // The extra area is a list of blocks: u16 id, u16 length, then `length` bytes.
    let mut pos = 0;
    while pos + 4 <= extra.len() {
        let id = u16_at(extra, pos);
        let len = u16_at(extra, pos + 2) as usize;
        let Some(data) = extra.get(pos + 4..pos + 4 + len) else {
            bail!("extra field block is truncated");
        };
        pos += 4 + len;
        if id != ZIP64_EXTRA_ID {
            continue;
        }

        let mut at = 0;
        let mut next = |wanted: bool| -> Result<Option<u64>> {
            if !wanted {
                return Ok(None);
            }
            ensure!(
                at + 8 <= data.len(),
                "ZIP64 extra field is too short for the sizes this entry needs"
            );
            at += 8;
            Ok(Some(u64_at(data, at - 8)))
        };
        if let Some(v) = next(needs_uncomp)? {
            entry.uncompressed_size = v;
        }
        if let Some(v) = next(needs_comp)? {
            entry.compressed_size = v;
        }
        if let Some(v) = next(needs_offset)? {
            entry.local_header_offset = v;
        }
        return Ok(());
    }
    bail!("a size or offset is 0xFFFFFFFF but the entry has no ZIP64 extra field")
}

/// Decode an entry name: UTF-8 if flag bit 11 is set, otherwise the original DOS code page 437.
pub(crate) fn decode_name(raw: &[u8], flags: u16) -> String {
    if flags & FLAG_UTF8 != 0 {
        String::from_utf8_lossy(raw).into_owned()
    } else {
        raw.iter().map(|&b| cp437_char(b)).collect()
    }
}

/// CP437 to Unicode. 0x00-0x7F is plain ASCII; the upper half is this table.
fn cp437_char(b: u8) -> char {
    const HIGH: [char; 128] = [
        'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å', //
        'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ', //
        'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»', //
        '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐', //
        '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧', //
        '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀', //
        'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩', //
        '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', '\u{00a0}',
    ];
    if b < 0x80 {
        b as char
    } else {
        HIGH[(b - 0x80) as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::*;
    use super::*;

    const MAX: u32 = 0xFFFF_FFFF;

    fn one(rec: Vec<u8>) -> Result<Entry> {
        let mut v = parse_central_directory(&rec, 1)?;
        Ok(v.remove(0))
    }

    #[test]
    fn plain_entry() {
        let e = one(central_record(
            b"dir/a.txt",
            FLAG_UTF8,
            8,
            0xDEAD_BEEF,
            100,
            250,
            4096,
            b"",
            b"",
        ))
        .unwrap();
        assert_eq!(e.name, "dir/a.txt");
        assert_eq!((e.method, e.crc32), (8, 0xDEAD_BEEF));
        assert_eq!(
            (
                e.compressed_size,
                e.uncompressed_size,
                e.local_header_offset
            ),
            (100, 250, 4096)
        );
        assert!(!e.is_dir() && !e.is_encrypted() && e.unsupported_reason().is_none());
    }

    #[test]
    fn utf8_name_when_flag_11_is_set() {
        let e = one(central_record(
            "日本語/ファイル.txt".as_bytes(),
            FLAG_UTF8,
            0,
            0,
            0,
            0,
            0,
            b"",
            b"",
        ))
        .unwrap();
        assert_eq!(e.name, "日本語/ファイル.txt");
    }

    #[test]
    fn cp437_name_when_flag_11_is_clear() {
        // 0x82 = é, 0x81 = ü, 0xE1 = ß, 0xB3 = │ in CP437. The same bytes are invalid UTF-8.
        let e = one(central_record(
            b"caf\x82_\x81_\xe1.txt",
            0,
            0,
            0,
            0,
            0,
            0,
            b"",
            b"",
        ))
        .unwrap();
        assert_eq!(e.name, "café_ü_ß.txt");
        assert_eq!(cp437_char(0xB3), '│');
        assert_eq!(cp437_char(0xFF), '\u{a0}');
        assert_eq!(cp437_char(b'A'), 'A');
    }

    #[test]
    fn directory_encrypted_and_unsupported_method() {
        let d = one(central_record(
            b"empty/", FLAG_UTF8, 0, 0, 0, 0, 0, b"", b"",
        ))
        .unwrap();
        assert!(d.is_dir());
        assert!(d.unsupported_reason().is_none());

        let enc = one(central_record(
            b"s.txt",
            FLAG_ENCRYPTED,
            8,
            0,
            1,
            1,
            0,
            b"",
            b"",
        ))
        .unwrap();
        assert_eq!(enc.unsupported_reason().as_deref(), Some("encrypted"));

        let bz = one(central_record(b"b.txt", 0, 12, 0, 1, 1, 0, b"", b"")).unwrap();
        assert!(bz.unsupported_reason().unwrap().contains("bzip2"));
        let aes = one(central_record(b"a.txt", 0, 99, 0, 1, 1, 0, b"", b"")).unwrap();
        assert!(aes.unsupported_reason().unwrap().contains("99"));
    }

    #[test]
    fn zip64_extra_with_all_three_values() {
        let extra = zip64_extra(&[5_000_000_000, 4_500_000_000, 6_000_000_000]);
        let e = one(central_record(
            b"big.bin", FLAG_UTF8, 0, 1, MAX, MAX, MAX, &extra, b"",
        ))
        .unwrap();
        assert_eq!(e.uncompressed_size, 5_000_000_000);
        assert_eq!(e.compressed_size, 4_500_000_000);
        assert_eq!(e.local_header_offset, 6_000_000_000);
    }

    #[test]
    fn zip64_extra_with_only_the_offset() {
        // A small file stored after the 4 GB mark: sizes are normal, only the offset overflowed.
        let extra = zip64_extra(&[7_000_000_000]);
        let e = one(central_record(
            b"after.txt",
            FLAG_UTF8,
            8,
            1,
            10,
            20,
            MAX,
            &extra,
            b"",
        ))
        .unwrap();
        assert_eq!((e.compressed_size, e.uncompressed_size), (10, 20));
        assert_eq!(e.local_header_offset, 7_000_000_000);
    }

    #[test]
    fn zip64_extra_with_only_the_sizes() {
        let extra = zip64_extra(&[9_000_000_000, 8_000_000_000]);
        let e = one(central_record(
            b"x", FLAG_UTF8, 8, 1, MAX, MAX, 1234, &extra, b"",
        ))
        .unwrap();
        assert_eq!(
            (
                e.uncompressed_size,
                e.compressed_size,
                e.local_header_offset
            ),
            (9_000_000_000, 8_000_000_000, 1234)
        );
    }

    #[test]
    fn zip64_extra_is_found_after_other_extra_fields() {
        let mut extra = extra_field(0x5455, b"\x01\x00\x00\x00\x00"); // "UT" timestamp field
        extra.extend(zip64_extra(&[6_000_000_000]));
        let e = one(central_record(
            b"x", FLAG_UTF8, 0, 0, 1, 1, MAX, &extra, b"",
        ))
        .unwrap();
        assert_eq!(e.local_header_offset, 6_000_000_000);
    }

    #[test]
    fn sentinel_without_zip64_extra_is_an_error() {
        let err = format!(
            "{:#}",
            one(central_record(b"x", FLAG_UTF8, 0, 0, MAX, 1, 0, b"", b"")).unwrap_err()
        );
        assert!(err.contains("ZIP64"), "{err}");
    }

    #[test]
    fn zip64_extra_too_short_is_an_error() {
        let extra = zip64_extra(&[1]); // needs two values
        assert!(
            one(central_record(
                b"x", FLAG_UTF8, 0, 0, MAX, MAX, 0, &extra, b""
            ))
            .is_err()
        );
    }

    #[test]
    fn extra_block_running_past_the_end_is_an_error() {
        let mut extra = extra_field(0x0001, &[0; 8]);
        extra[2] = 200; // claims 200 payload bytes
        assert!(
            one(central_record(
                b"x", FLAG_UTF8, 0, 0, MAX, 1, 0, &extra, b""
            ))
            .is_err()
        );
    }

    #[test]
    fn several_entries_with_comments_and_extras() {
        let mut cd = central_record(
            b"a",
            FLAG_UTF8,
            0,
            1,
            1,
            1,
            0,
            &extra_field(0x5455, b"12345"),
            b"comment A",
        );
        cd.extend(central_record(b"b/", FLAG_UTF8, 0, 0, 0, 0, 40, b"", b""));
        cd.extend(central_record(b"c", FLAG_UTF8, 8, 3, 2, 4, 80, b"", b"cc"));
        let entries = parse_central_directory(&cd, 3).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["a", "b/", "c"]);
        assert_eq!(entries[2].local_header_offset, 80);
    }

    #[test]
    fn truncated_or_corrupt_directories_are_errors() {
        let cd = central_record(b"abc", FLAG_UTF8, 0, 0, 0, 0, 0, b"", b"");
        // fewer bytes than the header claims
        assert!(parse_central_directory(&cd[..cd.len() - 1], 1).is_err());
        // fewer bytes than the fixed header
        assert!(parse_central_directory(&cd[..20], 1).is_err());
        // more entries promised than present
        assert!(parse_central_directory(&cd, 2).is_err());
        // wrong signature
        let mut bad = cd.clone();
        bad[0] = b'X';
        let err = format!("{:#}", parse_central_directory(&bad, 1).unwrap_err());
        assert!(err.contains("signature"), "{err}");
        // zero entries is a valid, empty archive
        assert!(parse_central_directory(&[], 0).unwrap().is_empty());
    }

    #[test]
    fn absurd_entry_count_does_not_preallocate() {
        // A hostile server claiming 2^60 entries must not make us allocate; it just fails.
        assert!(parse_central_directory(&[0u8; 10], 1 << 60).is_err());
    }
}
