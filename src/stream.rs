//! Sequential mode (`--stream`): extract a ZIP from a server that cannot do Range requests.
//!
//! Some servers build the archive while they send it (GitHub's "Download ZIP" does) and so can
//! only send it from the first byte. There is no way to read the index at the end first, so this
//! mode reads the file once, front to back, and extracts each entry as its bytes arrive. The ZIP
//! itself is still never written to disk.
//!
//! What changes compared with the Range mode:
//!
//! * one connection, no parallelism;
//! * no preview: the entry count, total size and free-space check are unknown up front. Instead
//!   it stops if the free space falls below a reserve while writing (unless `force`);
//! * unsafe names are noticed when they arrive, so entries before them may already be on disk;
//! * a dropped connection restarts the download from the beginning and skips what is finished;
//! * entries are read from their local headers. An entry written "streaming style" (flag bit 3)
//!   has its sizes in a data descriptor *after* the data, so deflate entries are inflated until
//!   their own end marker. A *stored* entry in that style has no end marker at all: its end is
//!   found by looking for a data descriptor whose CRC-32 and sizes match the bytes read so far.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use anyhow::{Context, Result, anyhow, bail};
use flate2::bufread::DeflateDecoder;

use crate::disk;
use crate::error::{Coded, ErrorCode, Failure, gave_up, io_failure, retry};
use crate::extract::{
    BUF_SIZE, CopyError, Counter, ExtractOptions, Summary, copy_limited, part_path,
    rename_into_place, sleep_unless_aborted, with_reporters,
};
use crate::fmt::human_bytes;
use crate::http::{Download, Sequential};
use crate::plan::{Filter, unsupported_message};
use crate::resume;
use crate::safety;
use crate::stats::Stats;
use crate::zip::central::{METHOD_DEFLATE, METHOD_STORED, decode_name};
use crate::zip::local::{LOCAL_FIXED_LEN, LOCAL_SIG};
use crate::zip::{Entry, u16_at, u32_at, u64_at};

const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_EOCD_SIG: u32 = 0x0606_4b50;
const DESCRIPTOR_SIG: u32 = 0x0807_4b50;
const ZIP64_EXTRA_ID: u16 = 0x0001;
/// General-purpose flag bit 3: CRC and sizes follow the data in a "data descriptor".
const FLAG_DESCRIPTOR: u16 = 1 << 3;

/// Stop writing when the drive has less free space than this (unless `force`).
const RESERVE: u64 = 256 << 20;
/// How many bytes to write between free-space checks.
const CHECK_EVERY: u64 = 32 << 20;

// ------------------------------------------------------------------------------------------
// Reading the response
// ------------------------------------------------------------------------------------------

/// A buffered reader over the HTTP body that can look ahead (`peek`) without consuming, counts
/// what was consumed and received, and remembers whether the *network* failed.
struct Input<'a, R> {
    inner: R,
    buf: Vec<u8>,
    pos: usize,
    end: usize,
    /// Bytes consumed by the parser so far.
    consumed: u64,
    /// The body ended (`read` returned 0).
    eof: bool,
    /// A read returned an I/O error (connection reset, timeout, ...).
    io_failed: bool,
    /// Every byte received from the network is added here (the progress bar).
    received: &'a AtomicU64,
}

impl<'a, R: Read> Input<'a, R> {
    fn new(inner: R, received: &'a AtomicU64) -> Self {
        Input {
            inner,
            buf: vec![0; BUF_SIZE],
            pos: 0,
            end: 0,
            consumed: 0,
            eof: false,
            io_failed: false,
            received,
        }
    }

    /// Read more from the network into the free tail of the buffer.
    fn pull(&mut self) -> io::Result<()> {
        loop {
            match self.inner.read(&mut self.buf[self.end..]) {
                Ok(0) => {
                    self.eof = true;
                    return Ok(());
                }
                Ok(n) => {
                    self.end += n;
                    self.received.fetch_add(n as u64, Ordering::Relaxed);
                    return Ok(());
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    self.io_failed = true;
                    return Err(e);
                }
            }
        }
    }

    /// Up to `n` upcoming bytes without consuming them (fewer only at the end of the body).
    fn peek(&mut self, n: usize) -> io::Result<&[u8]> {
        while self.end - self.pos < n && !self.eof {
            if self.pos > 0 {
                self.buf.copy_within(self.pos..self.end, 0);
                self.end -= self.pos;
                self.pos = 0;
            }
            if self.end == self.buf.len() {
                self.buf.resize(self.buf.len() * 2, 0);
            }
            self.pull()?;
        }
        Ok(&self.buf[self.pos..self.end.min(self.pos + n)])
    }

    fn network_failed(&self) -> bool {
        self.io_failed || self.eof
    }

    fn take_vec(&mut self, n: usize) -> Result<Vec<u8>, Failure> {
        let mut v = vec![0u8; n];
        self.read_exact(&mut v).map_err(net_error)?;
        Ok(v)
    }

    /// Discard `n` bytes.
    fn skip(&mut self, mut n: u64, abort: &AtomicBool) -> Result<(), Failure> {
        while n > 0 {
            if abort.load(Ordering::Relaxed) {
                return Err(Failure::fatal(anyhow!("cancelled")));
            }
            let available = self.fill_buf().map_err(net_error)?.len();
            if available == 0 {
                return Err(Failure::transient(anyhow!(
                    "the download ended while skipping a file"
                )));
            }
            let step = (available as u64).min(n);
            self.consume(step as usize);
            n -= step;
        }
        Ok(())
    }
}

impl<R: Read> BufRead for Input<'_, R> {
    fn fill_buf(&mut self) -> io::Result<&[u8]> {
        if self.pos >= self.end && !self.eof {
            self.pos = 0;
            self.end = 0;
            self.pull()?;
        }
        Ok(&self.buf[self.pos..self.end])
    }

    fn consume(&mut self, amt: usize) {
        let amt = amt.min(self.end - self.pos);
        self.pos += amt;
        self.consumed += amt as u64;
    }
}

impl<R: Read> Read for Input<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let available = self.fill_buf()?;
        let n = available.len().min(out.len());
        out[..n].copy_from_slice(&available[..n]);
        self.consume(n);
        Ok(n)
    }
}

fn net_error(e: io::Error) -> Failure {
    Failure::transient(anyhow!("the download was interrupted: {e}"))
}

// ------------------------------------------------------------------------------------------
// Guarding the disk
// ------------------------------------------------------------------------------------------

/// Passes writes through, but every `CHECK_EVERY` bytes checks that the drive still has room.
/// Without an index there is no up-front size, so this is what stops a huge archive from filling
/// the disk to the brim.
struct GuardedWriter<'a, W> {
    inner: W,
    /// `None` = no guard (`force`).
    reserve: Option<u64>,
    since_check: u64,
    free_space: &'a dyn Fn() -> Option<u64>,
}

impl<'a, W> GuardedWriter<'a, W> {
    fn new(inner: W, reserve: Option<u64>, free_space: &'a dyn Fn() -> Option<u64>) -> Self {
        GuardedWriter {
            inner,
            reserve,
            since_check: CHECK_EVERY, // so the very first write checks
            free_space,
        }
    }
}

impl<W: Write> Write for GuardedWriter<'_, W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if let Some(reserve) = self.reserve {
            self.since_check += data.len() as u64;
            if self.since_check >= CHECK_EVERY {
                self.since_check = 0;
                if let Some(free) = (self.free_space)()
                    && free < reserve + data.len() as u64
                {
                    return Err(io::Error::new(
                        io::ErrorKind::StorageFull,
                        format!(
                            "only {} of free space is left, below the {} reserve",
                            human_bytes(free),
                            human_bytes(reserve)
                        ),
                    ));
                }
            }
        }
        self.inner.write(data)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Where an entry's bytes go: normally straight into `<name>.part`. When resuming and a file of
/// that name is already in the folder, the bytes are compared with it instead, and as long as
/// they match nothing is written, so an identical file is never rewritten. (The sizes and CRC-32
/// of a streamed entry often come only after its data, so comparing is the one way to know
/// without writing.) At the first difference the matching part is copied from the old file into
/// `<name>.part` and writing carries on there.
struct Target<'a> {
    part_path: &'a Path,
    /// The file already in the folder, while everything so far has matched it.
    existing: Option<BufReader<File>>,
    /// Bytes that matched so far.
    matched: u64,
    /// `<name>.part`, once there is something to write.
    part: Option<File>,
    scratch: Vec<u8>,
}

/// How an entry ended up on disk.
enum Outcome {
    /// In `<name>.part`, to be renamed into place.
    Written,
    /// The file in the folder already had exactly these bytes.
    Identical,
}

impl<'a> Target<'a> {
    /// `compare`: look for a file at `final_path` (resume). `size`: the entry's size, if the
    /// header says; a file of another size is not worth comparing.
    fn new(
        final_path: &Path,
        part_path: &'a Path,
        compare: bool,
        size: Option<u64>,
    ) -> io::Result<Self> {
        let existing = compare
            .then(|| fs::metadata(final_path).ok())
            .flatten()
            .filter(|m| m.is_file() && size.is_none_or(|s| s == m.len()))
            .and_then(|_| File::open(final_path).ok())
            .map(|f| BufReader::with_capacity(BUF_SIZE, f));
        let part = match existing {
            Some(_) => None,
            None => Some(File::create(part_path)?),
        };
        Ok(Target {
            part_path,
            existing,
            matched: 0,
            part,
            scratch: Vec::new(),
        })
    }

    /// Stop comparing: start `<name>.part` with the bytes that matched so far.
    fn diverge(&mut self) -> io::Result<()> {
        let mut part = File::create(self.part_path)?;
        if let Some(old) = self.existing.take() {
            let mut old = old.into_inner();
            old.seek(SeekFrom::Start(0))?;
            let copied = io::copy(&mut old.take(self.matched), &mut part)?;
            if copied != self.matched {
                return Err(io::Error::other(
                    "the file in the folder changed while it was being compared",
                ));
            }
        }
        self.part = Some(part);
        Ok(())
    }

    /// All bytes are in: was the old file identical (it must not be any longer, either)?
    fn finish(mut self) -> io::Result<Outcome> {
        if let Some(existing) = &mut self.existing {
            if read_full(existing, &mut [0u8; 1]).is_ok_and(|n| n == 0) {
                return Ok(Outcome::Identical);
            }
            self.diverge()?;
        }
        if let Some(part) = &mut self.part {
            part.flush()?;
        }
        Ok(Outcome::Written)
    }
}

impl Write for Target<'_> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if let Some(existing) = &mut self.existing {
            self.scratch.resize(data.len(), 0);
            let same = read_full(existing, &mut self.scratch).is_ok_and(|n| n == data.len())
                && self.scratch[..] == *data;
            if same {
                self.matched += data.len() as u64;
                return Ok(data.len());
            }
            self.diverge()?;
        }
        match &mut self.part {
            Some(part) => part.write(data),
            None => Err(io::Error::other("no file to write to")),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match &mut self.part {
            Some(part) => part.flush(),
            None => Ok(()),
        }
    }
}

/// Fill `buf` as far as the reader allows; fewer bytes only at its end.
fn read_full(r: &mut impl Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(filled)
}

// ------------------------------------------------------------------------------------------
// Parsing a local header
// ------------------------------------------------------------------------------------------

/// What the local header (plus its ZIP64 extra field) tells us about an entry.
struct Header {
    entry: Entry,
    /// Compressed size from the header; meaningless for deflate entries with a descriptor.
    csize: u64,
    usize: u64,
    /// The extra field has a ZIP64 block, so a data descriptor carries 8-byte sizes.
    zip64: bool,
}

impl Header {
    fn has_descriptor(&self) -> bool {
        self.entry.flags & FLAG_DESCRIPTOR != 0
    }

    /// Do we know how many bytes the entry's data occupies before reading it?
    fn data_len_known(&self) -> bool {
        match self.entry.method {
            METHOD_DEFLATE => !self.has_descriptor(),
            // A stored entry's data is as long as its size; with a descriptor the header must
            // have carried it anyway, otherwise the end cannot be found.
            _ => self.csize != 0 || !self.has_descriptor(),
        }
    }
}

fn parse_header(fixed: &[u8; LOCAL_FIXED_LEN], name: &[u8], extra: &[u8]) -> Result<Header> {
    let flags = u16_at(fixed, 6);
    let method = u16_at(fixed, 8);
    let comp32 = u32_at(fixed, 18);
    let uncomp32 = u32_at(fixed, 22);
    let (mut csize, mut usize, zip64) = local_sizes(extra, comp32, uncomp32)?;
    if flags & FLAG_DESCRIPTOR != 0 && !zip64 && (comp32 == u32::MAX || uncomp32 == u32::MAX) {
        // "Sizes follow the data" written as 0xFFFFFFFF placeholders: not real sizes.
        (csize, usize) = (0, 0);
    }
    Ok(Header {
        entry: Entry {
            name: decode_name(name, flags),
            flags,
            method,
            crc32: u32_at(fixed, 14),
            compressed_size: csize,
            uncompressed_size: usize,
            local_header_offset: 0,
        },
        csize,
        usize,
        zip64,
    })
}

/// Sizes of an entry, replacing 0xFFFFFFFF fields with the ZIP64 extra field's values (uncompressed
/// first, then compressed, only those that were 0xFFFFFFFF). Also reports whether a ZIP64 block exists.
fn local_sizes(extra: &[u8], comp32: u32, uncomp32: u32) -> Result<(u64, u64, bool)> {
    let (mut csize, mut usize) = (comp32 as u64, uncomp32 as u64);
    let mut block = None;
    let mut pos = 0;
    while pos + 4 <= extra.len() {
        let id = u16_at(extra, pos);
        let len = u16_at(extra, pos + 2) as usize;
        let Some(data) = extra.get(pos + 4..pos + 4 + len) else {
            bail!("extra field block is truncated");
        };
        pos += 4 + len;
        if id == ZIP64_EXTRA_ID {
            block = Some(data);
            break;
        }
    }
    // No ZIP64 block: the 32-bit values stand. (0xFFFFFFFF without a block is only legal for an
    // entry whose real sizes come in a data descriptor after the data.)
    let Some(data) = block else {
        return Ok((csize, usize, false));
    };
    let mut at = 0;
    let mut next = |wanted: bool| -> Option<u64> {
        if !wanted || at + 8 > data.len() {
            return None;
        }
        at += 8;
        Some(u64_at(data, at - 8))
    };
    if let Some(v) = next(uncomp32 == u32::MAX) {
        usize = v;
    }
    if let Some(v) = next(comp32 == u32::MAX) {
        csize = v;
    }
    Ok((csize, usize, true))
}

/// Find the data descriptor in `bytes` (the bytes right after an entry's data) by trying the
/// layouts writers use (with or without the optional signature, 4- or 8-byte sizes) and
/// accepting the one whose sizes match what was actually read. Returns (length, CRC-32).
fn match_descriptor(
    bytes: &[u8],
    csize: u64,
    usize: u64,
    zip64_hint: bool,
) -> Option<(usize, u32)> {
    let start = if bytes.len() >= 4 && u32_at(bytes, 0) == DESCRIPTOR_SIG {
        4
    } else {
        0
    };
    let widths = if zip64_hint { [8, 4] } else { [4, 8] };
    for width in widths {
        let need = start + 4 + 2 * width;
        if bytes.len() < need {
            continue;
        }
        let (c, u) = if width == 8 {
            (u64_at(bytes, start + 4), u64_at(bytes, start + 12))
        } else {
            (
                u32_at(bytes, start + 4) as u64,
                u32_at(bytes, start + 8) as u64,
            )
        };
        if c == csize && u == usize {
            return Some((need, u32_at(bytes, start)));
        }
    }
    None
}

// ------------------------------------------------------------------------------------------
// The extraction
// ------------------------------------------------------------------------------------------

struct Ctx<'a> {
    opts: &'a ExtractOptions,
    root: &'a Path,
    stats: &'a Stats,
    abort: &'a AtomicBool,
    filter: Filter,
}

/// What survives from one connection to the next.
#[derive(Default)]
struct State {
    /// Lower-cased relative paths of files that are complete (skipped when the download restarts).
    done: HashSet<String>,
    dirs: HashSet<String>,
    renames: Vec<(String, String)>,
    /// Files that were already in the folder, identical (resume), and their size.
    skipped: u64,
    skipped_bytes: u64,
}

pub fn run(opts: &ExtractOptions) -> Result<Summary> {
    let started = Instant::now();
    let seq = Sequential::new(&opts.url, opts.retry, &opts.headers)?;
    let filter = Filter::with_selection(&opts.include, opts.select.as_ref())?;

    let first = retry(opts.retry, || seq.open())
        .with_context(|| format!("could not reach {}", seq.url()))?;
    let length = first.length;
    let (etag, last_modified) = (first.etag.clone(), first.last_modified.clone());

    let root = safety::prepare_root(&opts.output)?;
    let stats = Stats::new(0, length.unwrap_or(0), 0);
    let own_abort = AtomicBool::new(false);
    let abort: &AtomicBool = opts.cancel.as_deref().unwrap_or(&own_abort);
    let ctx = Ctx {
        opts,
        root: &root,
        stats: &stats,
        abort,
        filter,
    };
    let mut state = State::default();

    let outcome = with_reporters(opts, &stats, &root, || -> Result<()> {
        let mut buf = vec![0u8; BUF_SIZE];
        let mut first = Some(first);
        let mut attempt = 1;
        loop {
            stats.requests.fetch_add(1, Ordering::Relaxed);
            let download = match first.take() {
                Some(d) => Ok(d),
                None => seq
                    .open()
                    .and_then(|d| same_file(&etag, &last_modified, &d).map(|()| d)),
            };
            let result = download.and_then(|d| run_attempt(&ctx, &mut state, d, &mut buf));
            match result {
                Ok(()) => return Ok(()),
                Err(Failure::Transient(_))
                    if attempt < opts.retry.max_attempts && !abort.load(Ordering::Relaxed) =>
                {
                    stats.retries.fetch_add(1, Ordering::Relaxed);
                    stats.downloaded.store(0, Ordering::Relaxed); // the file starts over
                    sleep_unless_aborted(abort, opts.retry.delay_after(attempt));
                    attempt += 1;
                }
                Err(failure) => {
                    stats.clear_active(0);
                    return Err(if failure.is_transient() {
                        let text = format!("extracting failed after {attempt} attempts");
                        gave_up(failure.into_error(), text)
                    } else {
                        failure.into_error().context("extracting failed")
                    });
                }
            }
        }
    });
    outcome?;

    if stats.files_done() == 0 && state.skipped == 0 && state.dirs.is_empty() {
        bail!("{}", ctx.filter.nothing_selected());
    }
    // A journal a Range-mode run left in this folder is not needed any more.
    resume::remove_journal(&root);
    Ok(Summary {
        files: stats.files_done(),
        dirs: state.dirs.len() as u64,
        extracted_bytes: stats.extracted(),
        // The whole file is the download; there is no separate index read.
        downloaded_bytes: stats.downloaded(),
        index_bytes: 0,
        // Skipped files were compared byte for byte, and their CRC-32 checked on the way.
        verified_files: stats.files_done() + state.skipped,
        skipped_files: state.skipped,
        skipped_bytes: state.skipped_bytes,
        archive_size: length.unwrap_or_else(|| stats.downloaded()),
        elapsed: started.elapsed(),
        retries: stats.retries.load(Ordering::Relaxed),
        spans: 1,
        requests: stats.requests.load(Ordering::Relaxed),
        zip_bytes_on_disk: stats.zip_bytes_on_disk.load(Ordering::Relaxed),
        renames: state.renames,
        sequential: true,
    })
}

/// A restarted download must be the same file, or skipping "finished" entries would mix two versions.
fn same_file(
    etag: &Option<String>,
    last_modified: &Option<String>,
    d: &Download,
) -> Result<(), Failure> {
    let changed = match (etag, &d.etag) {
        (Some(old), Some(new)) => old.trim_start_matches("W/") != new.trim_start_matches("W/"),
        _ => matches!((last_modified, &d.last_modified), (Some(old), Some(new)) if old != new),
    };
    if changed {
        return Err(Failure::fatal(anyhow!(
            "the file changed on the server while it was being downloaded"
        )));
    }
    Ok(())
}

/// One pass over one connection: entry after entry until the central directory starts.
fn run_attempt(
    ctx: &Ctx,
    st: &mut State,
    download: Download,
    buf: &mut [u8],
) -> Result<(), Failure> {
    let content_type = download.content_type.clone().unwrap_or_default();
    let mut input = Input::new(download.response, &ctx.stats.downloaded);
    let mut taken: HashMap<String, String> = HashMap::new();
    let mut first_entry = true;

    loop {
        if ctx.abort.load(Ordering::Relaxed) {
            return Err(Failure::fatal(anyhow!("cancelled")));
        }
        let head = input.peek(64).map_err(net_error)?.to_vec();
        if head.len() < 4 {
            return Err(if first_entry && input.consumed == 0 && head.is_empty() {
                Failure::fatal(Coded::new(
                    ErrorCode::NotZip,
                    "the server sent an empty response",
                ))
            } else {
                Failure::transient(anyhow!("the download ended before the end of the archive"))
            });
        }
        match u32_at(&head, 0) {
            LOCAL_SIG => {
                entry(ctx, st, &mut taken, &mut input, buf)?;
                first_entry = false;
            }
            CENTRAL_SIG | EOCD_SIG | ZIP64_EOCD_SIG => return Ok(()),
            _ => {
                return Err(Failure::fatal(not_a_zip(
                    &head,
                    &content_type,
                    first_entry,
                    input.consumed,
                )));
            }
        }
    }
}

fn not_a_zip(head: &[u8], content_type: &str, first: bool, at: u64) -> anyhow::Error {
    if !first {
        return anyhow!("unexpected data at byte {at} of the archive (corrupt archive?)");
    }
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start();
    if content_type.contains("html") || trimmed.starts_with('<') {
        return Coded::new(
            ErrorCode::HtmlPage,
            "the server sent a web page (HTML), not a ZIP file. The link may need you to be \
             signed in, or it has expired",
        )
        .into();
    }
    let hex: Vec<String> = head.iter().take(8).map(|b| format!("{b:02x}")).collect();
    Coded::new(
        ErrorCode::NotZip,
        format!(
            "the response is not a ZIP file (it starts with {}); the link may point at a web page or another file type",
            hex.join(" ")
        ),
    )
    .into()
}

/// Handle the entry whose local header starts at the reader's position.
fn entry<R: Read>(
    ctx: &Ctx,
    st: &mut State,
    taken: &mut HashMap<String, String>,
    input: &mut Input<R>,
    buf: &mut [u8],
) -> Result<(), Failure> {
    let mut fixed = [0u8; LOCAL_FIXED_LEN];
    input.read_exact(&mut fixed).map_err(net_error)?;
    let lh = crate::zip::local::LocalHeader::parse(&fixed).map_err(Failure::fatal)?;
    let name = input.take_vec(lh.name_len as usize)?;
    let extra = input.take_vec(lh.extra_len as usize)?;
    let header = parse_header(&fixed, &name, &extra).map_err(Failure::fatal)?;
    let name = header.entry.name.clone();

    if !ctx.filter.matches(&name) {
        return discard(ctx, input, &header, buf);
    }

    if let Some(reason) = header.entry.unsupported_reason() {
        return Err(Failure::fatal(
            Coded::new(
                ErrorCode::UnsupportedEntries,
                format!(
                    "{name}: {reason}. LinkUnzip cannot extract this entry; skip it with --include"
                ),
            )
            .with_message(unsupported_message(&[(name.clone(), reason)])),
        ));
    }
    let safe = safety::sanitize_entry_name(&name)
        .map_err(|reason| Failure::fatal(anyhow!("{name:?}: unsafe path, {reason}")))?;
    let key = safe.path.to_string_lossy().to_lowercase();
    if safe.changed && !st.renames.iter().any(|(from, _)| *from == name) {
        st.renames
            .push((name.clone(), safe.path.to_string_lossy().replace('\\', "/")));
    }
    let keys = if header.entry.is_dir() {
        vec![key.clone()]
    } else {
        vec![key.clone(), format!("{key}.part")]
    };
    for k in keys {
        if let Some(other) = taken.insert(k, name.clone()) {
            return Err(Failure::fatal(anyhow!(
                "{name:?} and {other:?} would be written to the same file"
            )));
        }
    }

    if header.entry.is_dir() {
        let path = safety::join_under(ctx.root, &safe.path).map_err(Failure::fatal)?;
        fs::create_dir_all(&path).map_err(|e| {
            Failure::fatal(io_failure(
                e,
                format!("could not create folder {}", disk::display_path(&path)),
            ))
        })?;
        st.dirs.insert(key);
        return discard(ctx, input, &header, buf);
    }
    if st.done.contains(&key) {
        return discard(ctx, input, &header, buf); // finished before the connection dropped
    }

    ctx.stats.set_active(0, &name);
    let final_path = safety::join_under(ctx.root, &safe.path).map_err(Failure::fatal)?;
    let part = part_path(&final_path);
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            Failure::fatal(io_failure(
                e,
                format!("could not create folder {}", disk::display_path(parent)),
            ))
        })?;
    }
    // Resuming: a file already there is compared rather than rewritten (see `Target`).
    let size_hint = header.data_len_known().then_some(header.usize);
    let target = Target::new(&final_path, &part, ctx.opts.resume, size_hint).map_err(|e| {
        Failure::fatal(io_failure(
            e,
            format!("could not create {}", disk::display_path(&part)),
        ))
    })?;

    let mut written_here = 0u64;
    let result = (|| -> Result<Outcome, Failure> {
        let free = || disk::free_space(ctx.root).ok();
        let mut out = GuardedWriter::new(target, (!ctx.opts.force).then_some(RESERVE), &free);
        let counter = Counter {
            shared: &ctx.stats.extracted,
            mine: &mut written_here,
        };
        let data = read_data(ctx, input, &header, &mut out, counter, buf)?;
        out.flush()
            .map_err(|e| Failure::fatal(io_failure(e, "writing to disk failed")))?;
        verify(input, &header, &data)?;
        out.inner
            .finish()
            .map_err(|e| Failure::fatal(io_failure(e, "writing to disk failed")))
    })();

    match result {
        Ok(Outcome::Identical) => {
            // Already there, byte for byte: nothing was written, and an old `.part` goes.
            let _ = fs::remove_file(&part);
            ctx.stats
                .extracted
                .fetch_sub(written_here, Ordering::Relaxed);
            ctx.stats.clear_active(0);
            st.skipped += 1;
            st.skipped_bytes += written_here;
            st.done.insert(key);
            Ok(())
        }
        Ok(Outcome::Written) => {
            rename_into_place(&part, &final_path).map_err(|e| {
                Failure::fatal(io_failure(
                    e,
                    format!("could not move {} into place", disk::display_path(&part)),
                ))
            })?;
            ctx.stats.files_done.fetch_add(1, Ordering::Relaxed);
            ctx.stats.clear_active(0);
            st.done.insert(key);
            Ok(())
        }
        Err(failure) => {
            let _ = fs::remove_file(&part);
            ctx.stats
                .extracted
                .fetch_sub(written_here, Ordering::Relaxed);
            ctx.stats.clear_active(0);
            Err(failure)
        }
    }
}

/// What reading an entry's data produced.
struct Data {
    crc: u32,
    written: u64,
    /// Compressed bytes the data occupied.
    consumed: u64,
    /// (CRC-32, compressed size, uncompressed size) if the data descriptor was already read
    /// (stored entries in streaming style find their end by locating it).
    descriptor: Option<(u32, u64, u64)>,
}

/// Decompress (or copy) the entry's data into `out`. Reads exactly the entry's data and nothing
/// after it; a data descriptor, if any, is left for [`verify`].
fn read_data<R: Read, W: Write>(
    ctx: &Ctx,
    input: &mut Input<R>,
    h: &Header,
    out: &mut W,
    written: Counter,
    buf: &mut [u8],
) -> Result<Data, Failure> {
    let start = input.consumed;
    let mut crc = crc32fast::Hasher::new();
    let declared = if h.data_len_known() {
        h.usize
    } else {
        u64::MAX
    };

    let copied = match h.entry.method {
        METHOD_STORED if !h.data_len_known() => {
            let (total, descriptor) =
                scan_stored(ctx, input, &h.entry.name, out, written, &mut crc, h.zip64)?;
            return Ok(Data {
                crc: descriptor.0,
                written: total,
                consumed: total,
                descriptor: Some(descriptor),
            });
        }
        METHOD_DEFLATE if h.has_descriptor() => {
            // No length to rely on: the deflate stream says where it ends.
            let mut decoder = DeflateDecoder::new(&mut *input);
            copy_limited(
                &mut decoder,
                out,
                declared,
                &mut crc,
                buf,
                written,
                ctx.abort,
            )
        }
        METHOD_DEFLATE => {
            let mut limited = (&mut *input).take(h.csize);
            let result = {
                let mut decoder = DeflateDecoder::new(&mut limited);
                copy_limited(
                    &mut decoder,
                    out,
                    declared,
                    &mut crc,
                    buf,
                    written,
                    ctx.abort,
                )
            };
            let unread = limited.limit();
            if result.is_ok() {
                input.skip(unread, ctx.abort)?; // padding after the deflate stream
            }
            result
        }
        METHOD_STORED => {
            let mut limited = (&mut *input).take(h.csize);
            copy_limited(
                &mut limited,
                out,
                declared,
                &mut crc,
                buf,
                written,
                ctx.abort,
            )
        }
        m => {
            return Err(Failure::fatal(anyhow!(
                "unsupported compression method {m}"
            )));
        }
    };

    let written = match copied {
        Ok(n) => n,
        Err(CopyError::TooMuchData) => {
            return Err(Failure::fatal(anyhow!(
                "the data expands beyond the {declared} bytes declared for this entry (zip bomb or corrupt archive)"
            )));
        }
        Err(CopyError::Write(e)) => {
            return Err(Failure::fatal(io_failure(e, "writing to disk failed")));
        }
        Err(CopyError::Aborted) => return Err(Failure::fatal(anyhow!("cancelled"))),
        Err(CopyError::Read(e)) if input.network_failed() => {
            return Err(Failure::transient(anyhow!(
                "the download was interrupted: {e}"
            )));
        }
        Err(CopyError::Read(e)) => {
            return Err(Failure::fatal(anyhow!(
                "the compressed data is corrupt: {e}"
            )));
        }
    };
    if input.network_failed() && h.data_len_known() && written != h.usize {
        return Err(Failure::transient(anyhow!(
            "the download ended early ({written} of {} bytes)",
            h.usize
        )));
    }
    Ok(Data {
        crc: crc.finalize(),
        written,
        consumed: input.consumed - start,
        descriptor: None,
    })
}

/// Copy a stored entry whose length the header does not give. The data ends where a data
/// descriptor appears whose CRC-32 *and* both sizes match everything copied so far; a false match
/// by chance is as unlikely as a CRC-32 and two lengths agreeing at random.
/// Returns (bytes copied, the descriptor's (CRC-32, compressed size, uncompressed size)).
fn scan_stored<R: Read, W: Write>(
    ctx: &Ctx,
    input: &mut Input<R>,
    name: &str,
    out: &mut W,
    mut written: Counter,
    crc: &mut crc32fast::Hasher,
    zip64: bool,
) -> Result<(u64, (u32, u64, u64)), Failure> {
    const CHUNK: usize = 64 * 1024;
    const LOOKAHEAD: usize = 24; // signature + CRC + two 8-byte sizes
    let mut total = 0u64;
    loop {
        if ctx.abort.load(Ordering::Relaxed) {
            return Err(Failure::fatal(anyhow!("cancelled")));
        }
        let window = input.peek(CHUNK + LOOKAHEAD).map_err(net_error)?;
        if window.is_empty() {
            return Err(Failure::transient(anyhow!(
                "the download ended inside the stored entry {name:?}"
            )));
        }
        // A short window means the stream ended, so every position has all the bytes it needs.
        let limit = if window.len() < CHUNK + LOOKAHEAD {
            window.len()
        } else {
            CHUNK
        };

        let mut found = None;
        let mut i = 0;
        while let Some(offset) = window[i..limit].iter().position(|&b| b == b'P') {
            i += offset;
            if window.len() >= i + 4 && u32_at(window, i) == DESCRIPTOR_SIG {
                let copied = total + i as u64;
                let mut so_far = crc.clone();
                so_far.update(&window[..i]);
                if let Some((len, descriptor_crc)) =
                    match_descriptor(&window[i..], copied, copied, zip64)
                    && descriptor_crc == so_far.finalize()
                {
                    found = Some((i, len, descriptor_crc));
                    break;
                }
            }
            i += 1;
        }

        let emit = found.map_or(limit, |(at, _, _)| at);
        out.write_all(&window[..emit])
            .map_err(|e| Failure::fatal(io_failure(e, "writing to disk failed")))?;
        crc.update(&window[..emit]);
        written.add(emit as u64);
        total += emit as u64;
        match found {
            Some((at, len, descriptor_crc)) => {
                input.consume(at + len);
                return Ok((total, (descriptor_crc, total, total)));
            }
            None => input.consume(limit),
        }
        if input.eof && input.peek(1).map_err(net_error)?.is_empty() {
            return Err(Failure::transient(anyhow!(
                "the download ended before the end of the stored entry {name:?} (or its data descriptor has no signature, which cannot be found)"
            )));
        }
    }
}

/// Read the data descriptor (if there is one) and compare sizes and CRC-32 with what was read.
fn verify<R: Read>(input: &mut Input<R>, h: &Header, data: &Data) -> Result<(), Failure> {
    let (expected_crc, expected_c, expected_u) = if let Some(found) = data.descriptor {
        found
    } else if h.has_descriptor() {
        let peeked = input.peek(24).map_err(net_error)?.to_vec();
        match match_descriptor(&peeked, data.consumed, data.written, h.zip64) {
            Some((len, crc)) => {
                input.consume(len);
                (crc, data.consumed, data.written)
            }
            None if input.network_failed() && peeked.len() < 24 => {
                return Err(Failure::transient(anyhow!(
                    "the download ended before the entry's data descriptor"
                )));
            }
            None => {
                return Err(Failure::fatal(anyhow!(
                    "the entry's data descriptor does not match its data (corrupt archive)"
                )));
            }
        }
    } else {
        (h.entry.crc32, h.csize, h.usize)
    };
    if data.written != expected_u || data.consumed != expected_c {
        return Err(Failure::fatal(anyhow!(
            "size mismatch: the archive declares {expected_u} bytes but the data holds {}",
            data.written
        )));
    }
    if data.crc != expected_crc {
        return Err(Failure::fatal(anyhow!(
            "CRC-32 mismatch: expected {expected_crc:08x}, got {:08x}",
            data.crc
        )));
    }
    Ok(())
}

/// Read past an entry without writing it (not selected, a folder, or finished before a retry).
fn discard<R: Read>(
    ctx: &Ctx,
    input: &mut Input<R>,
    h: &Header,
    buf: &mut [u8],
) -> Result<(), Failure> {
    if h.data_len_known() {
        input.skip(h.csize, ctx.abort)?;
        if h.has_descriptor() {
            let peeked = input.peek(24).map_err(net_error)?.to_vec();
            let Some((len, _)) = match_descriptor(&peeked, h.csize, h.usize, h.zip64) else {
                return Err(Failure::fatal(anyhow!(
                    "the entry's data descriptor does not match its data (corrupt archive)"
                )));
            };
            input.consume(len);
        }
        return Ok(());
    }
    let sink_count = AtomicU64::new(0);
    let mut mine = 0u64;
    let counter = Counter {
        shared: &sink_count,
        mine: &mut mine,
    };
    let data = read_data(ctx, input, h, &mut io::sink(), counter, buf)?;
    verify(input, h, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(sig: bool, crc: u32, c: u64, u: u64, wide: bool) -> Vec<u8> {
        let mut v = Vec::new();
        if sig {
            v.extend_from_slice(&DESCRIPTOR_SIG.to_le_bytes());
        }
        v.extend_from_slice(&crc.to_le_bytes());
        if wide {
            v.extend_from_slice(&c.to_le_bytes());
            v.extend_from_slice(&u.to_le_bytes());
        } else {
            v.extend_from_slice(&(c as u32).to_le_bytes());
            v.extend_from_slice(&(u as u32).to_le_bytes());
        }
        v
    }

    #[test]
    fn descriptor_layouts_are_recognised() {
        for (sig, wide) in [(true, false), (false, false), (true, true), (false, true)] {
            let mut bytes = descriptor(sig, 0xDEAD_BEEF, 1234, 5678, wide);
            let len = bytes.len();
            bytes.extend_from_slice(b"PK\x03\x04next entry follows");
            assert_eq!(
                match_descriptor(&bytes[..24.min(bytes.len())], 1234, 5678, wide),
                Some((len, 0xDEAD_BEEF)),
                "sig={sig} wide={wide}"
            );
            // The hint only changes which layout is tried first.
            assert_eq!(
                match_descriptor(&bytes[..24.min(bytes.len())], 1234, 5678, !wide),
                Some((len, 0xDEAD_BEEF)),
                "sig={sig} wide={wide} (wrong hint)"
            );
        }
    }

    #[test]
    fn descriptor_with_wrong_sizes_is_rejected() {
        let bytes = descriptor(true, 1, 10, 20, false);
        assert_eq!(match_descriptor(&bytes, 10, 21, false), None);
        assert_eq!(match_descriptor(&bytes, 11, 20, false), None);
        assert_eq!(match_descriptor(&[], 0, 0, false), None);
    }

    #[test]
    fn zip64_local_sizes() {
        // ZIP64 block with both sizes, both header fields saturated.
        let mut extra = vec![0x01, 0x00, 16, 0];
        extra.extend_from_slice(&5_000_000_000u64.to_le_bytes()); // uncompressed
        extra.extend_from_slice(&3_000_000_000u64.to_le_bytes()); // compressed
        assert_eq!(
            local_sizes(&extra, u32::MAX, u32::MAX).unwrap(),
            (3_000_000_000, 5_000_000_000, true)
        );
        // No ZIP64 block: plain 32-bit values, and a descriptor would use 4-byte sizes.
        assert_eq!(local_sizes(&[], 7, 9).unwrap(), (7, 9, false));
        // A block that is present but unneeded still marks the entry as ZIP64 (descriptor width).
        assert_eq!(local_sizes(&[1, 0, 0, 0], 7, 9).unwrap(), (7, 9, true));
    }

    #[test]
    fn input_peeks_without_consuming_and_counts() {
        let received = AtomicU64::new(0);
        let data: Vec<u8> = (0..=255u8).cycle().take(300_000).collect();
        let mut input = Input::new(io::Cursor::new(data.clone()), &received);
        assert_eq!(input.peek(4).unwrap(), &data[..4]);
        assert_eq!(
            input.peek(4).unwrap(),
            &data[..4],
            "peeking twice changes nothing"
        );
        assert_eq!(input.consumed, 0);
        let mut got = vec![0u8; 10];
        input.read_exact(&mut got).unwrap();
        assert_eq!(got, &data[..10]);
        assert_eq!(input.consumed, 10);
        // Skip across several buffer refills.
        input.skip(250_000, &AtomicBool::new(false)).unwrap();
        assert_eq!(input.peek(3).unwrap(), &data[250_010..250_013]);
        input.skip(49_990, &AtomicBool::new(false)).unwrap();
        assert!(input.peek(1).unwrap().is_empty(), "end of data");
        assert_eq!(received.load(Ordering::Relaxed), 300_000);
        assert!(input.skip(1, &AtomicBool::new(false)).is_err());
    }

    #[test]
    fn free_space_guard_stops_writes_below_the_reserve() {
        let low = || Some(10u64 << 20);
        let plenty = || Some(10u64 << 30);
        let mut guarded = GuardedWriter::new(Vec::new(), Some(RESERVE), &low);
        let err = guarded.write(b"hello").unwrap_err();
        assert!(err.to_string().contains("reserve"), "{err}");

        let mut roomy = GuardedWriter::new(Vec::new(), Some(RESERVE), &plenty);
        assert_eq!(roomy.write(b"hello").unwrap(), 5);

        // `force` turns the guard off.
        let mut forced = GuardedWriter::new(Vec::new(), None, &low);
        assert_eq!(forced.write(b"hello").unwrap(), 5);
    }

    #[test]
    fn explains_html_and_unknown_responses() {
        let code = |e: &anyhow::Error| e.downcast_ref::<Coded>().map(|c| c.code);
        let html = not_a_zip(b"<!DOCTYPE html><html>", "text/html", true, 0);
        assert!(html.to_string().contains("web page"), "{html}");
        assert!(html.to_string().contains("signed in"), "{html}");
        assert_eq!(code(&html), Some(ErrorCode::HtmlPage));
        let other = not_a_zip(b"%PDF-1.7", "application/pdf", true, 0);
        assert!(other.to_string().contains("not a ZIP"), "{other}");
        assert!(other.to_string().contains("25 50 44 46"), "{other}");
        assert_eq!(code(&other), Some(ErrorCode::NotZip));
        let later = not_a_zip(b"garbage", "", false, 1234);
        assert!(later.to_string().contains("byte 1234"), "{later}");
        assert_eq!(code(&later), None, "corrupt, not 'not a zip'");
    }

    #[test]
    fn the_free_space_guard_reports_a_full_disk() {
        let low = || Some(10u64 << 20);
        let mut guarded = GuardedWriter::new(Vec::new(), Some(RESERVE), &low);
        let err = guarded.write(b"hello").unwrap_err();
        assert_eq!(
            crate::error::io_code(&err),
            Some(ErrorCode::DiskFull),
            "{err}"
        );
    }
}
