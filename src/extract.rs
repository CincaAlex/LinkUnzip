//! The extraction engine: stream each entry's bytes from an HTTP Range response, decompress them
//! and write them straight into the output folder.
//!
//! One Range request covers a whole *span* of neighbouring entries (see `plan`). For each entry
//! in the span we:
//!
//! 1. skip to its local header (there may be a data descriptor or padding from the entry before),
//! 2. read the 30-byte local header, then skip its name and extra field; their lengths can
//!    differ from the central directory's copy, so we must use the local ones,
//! 3. stream exactly `compressed_size` bytes (from the central directory, so data descriptors
//!    never matter) through a raw-deflate decoder, or copy them if stored, into `<name>.part`,
//! 4. check size and CRC-32, then rename `<name>.part` to `<name>`.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use flate2::bufread::DeflateDecoder;
use reqwest::blocking::Response;

use crate::disk;
use crate::error::{Failure, RetryPolicy, gave_up, io_failure};
use crate::http::{Headers, Source};
use crate::plan::{self, Filter, PlannedFile, Selection, Span};
use crate::resume::{self, Identity, Journal};
use crate::safety;
use crate::stats::Stats;
use crate::ui;
use crate::zip::central::{METHOD_DEFLATE, METHOD_STORED};
use crate::zip::index::read_index;
use crate::zip::local::{LOCAL_FIXED_LEN, LocalHeader};

/// Size of the read buffer in front of the decoder and of the copy buffer.
pub(crate) const BUF_SIZE: usize = 128 * 1024;

/// Called a few times a second while extracting, and once more when the work is done.
pub type ProgressFn = Arc<dyn Fn(&Stats) + Send + Sync>;

pub struct ExtractOptions {
    pub url: String,
    pub output: PathBuf,
    /// Glob patterns on entry names; empty = everything.
    pub include: Vec<String>,
    /// The browser file list's selection (entry paths, folders ending in `/`); applied together
    /// with `include`. `None` = everything.
    pub select: Option<Selection>,
    pub jobs: usize,
    /// Extract even if the free-space check fails.
    pub force: bool,
    pub retry: RetryPolicy,
    /// Draw the live progress display on stderr (it draws nothing if stderr is not a terminal).
    pub progress: bool,
    /// Extra request headers for the archive URL (e.g. the browser's `Cookie`).
    pub headers: Headers,
    /// Set this from another thread to stop the extraction; unfinished files are removed.
    pub cancel: Option<Arc<AtomicBool>>,
    /// Receives the live counters; used by the browser extension's native host.
    pub on_progress: Option<ProgressFn>,
    /// Read the file once from start to finish instead of using Range requests: for servers
    /// that cannot do ranges (e.g. GitHub's "Download ZIP"). One connection, no index preview.
    pub stream: bool,
    /// Skip the files that are already in the output folder with the right size and CRC-32
    /// (see `resume`). Off = extract everything again (`--overwrite`).
    pub resume: bool,
}

#[derive(Debug)]
pub struct Summary {
    /// Files extracted (each one's size and CRC-32 checked before it got its name).
    pub files: u64,
    pub dirs: u64,
    pub extracted_bytes: u64,
    /// Everything received from the server: the index reads plus the files' compressed data
    /// (in stream mode, the whole file).
    pub downloaded_bytes: u64,
    /// The part of `downloaded_bytes` spent on the probe, the end records and the central
    /// directory (0 in stream mode).
    pub index_bytes: u64,
    /// Files whose size and CRC-32 were verified: the extracted ones plus the skipped ones.
    pub verified_files: u64,
    /// Selected files that were already in the folder with the right size and CRC-32 (resume),
    /// so they were not downloaded again, and their size.
    pub skipped_files: u64,
    pub skipped_bytes: u64,
    pub archive_size: u64,
    pub elapsed: Duration,
    pub retries: u64,
    pub spans: usize,
    /// HTTP requests made: the index reads, one per span and one per retry.
    pub requests: u64,
    /// ZIP bytes this run wrote to disk: always 0, there is no code path that writes them.
    pub zip_bytes_on_disk: u64,
    /// (name in archive, name on disk) for entries renamed for Windows compatibility.
    pub renames: Vec<(String, String)>,
    /// The archive was read front to back in one request (`--stream`), not with Range requests.
    pub sequential: bool,
}

impl Summary {
    /// What "download the zip, then extract" would have needed on disk.
    pub fn normal_needs(&self) -> u64 {
        self.archive_size + self.extracted_bytes
    }
}

/// Everything a worker needs besides the span itself.
struct Ctx<'a> {
    src: &'a Source,
    root: &'a Path,
    stats: &'a Stats,
    abort: &'a AtomicBool,
    /// Where finished entries are noted for a later resume.
    journal: Option<&'a Journal>,
}

/// Extract the archive at `opts.url` into `opts.output`.
pub fn run(opts: &ExtractOptions) -> Result<Summary> {
    if opts.stream {
        return crate::stream::run(opts);
    }
    let started = Instant::now();
    let src = Source::probe_with(&opts.url, opts.retry, &opts.headers)?;
    let index = read_index(&src)?;
    // A caller-supplied cancel flag doubles as the abort flag: raising it stops every worker.
    let own_abort = AtomicBool::new(false);
    let abort: &AtomicBool = opts.cancel.as_deref().unwrap_or(&own_abort);

    // Everything is validated before the first byte is written.
    let filter = Filter::with_selection(&opts.include, opts.select.as_ref())?;
    let checked = plan::check(&index, &filter)?;
    let identity = Identity::new(src.size, src.etag.clone(), src.last_modified.clone());
    // Resume: what an earlier run (or anything else) already put into the folder correctly is
    // neither downloaded nor written again.
    let done: HashSet<u64> = match existing_folder(&opts.output) {
        Some(folder) if opts.resume => {
            let journal = resume::load(&folder, &identity);
            let done = resume::already_done(&folder, &checked.files, &journal, opts.jobs, abort)?;
            checked
                .files
                .iter()
                .zip(done)
                .filter(|(_, done)| *done)
                .map(|(f, _)| f.entry.local_header_offset)
                .collect()
        }
        _ => HashSet::new(),
    };
    let plan = checked.into_plan(opts.jobs, |f| done.contains(&f.entry.local_header_offset));
    let free = disk::free_space(&opts.output)?;
    disk::check_fits(free, plan.total_extracted, opts.force)?;

    let root = safety::prepare_root(&opts.output)?;
    for dir in &plan.dirs {
        let path = safety::join_under(&root, dir)?;
        fs::create_dir_all(&path)
            .with_context(|| format!("could not create folder {}", disk::display_path(&path)))?;
    }
    let journal = if plan.file_count > 0 {
        Journal::open(&root, &identity, opts.resume)
    } else {
        None
    };

    let stats = Stats::with_index(
        plan.file_count,
        plan.total_compressed,
        plan.total_extracted,
        src.index_bytes(),
        src.index_requests(),
    )
    .with_skipped(
        plan.skipped_files,
        plan.skipped_compressed,
        plan.skipped_bytes,
    );
    let ctx = Ctx {
        src: &src,
        root: &root,
        stats: &stats,
        abort,
        journal: journal.as_ref(),
    };

    let outcome = with_reporters(opts, &stats, &root, || {
        execute(&ctx, &plan.spans, opts.jobs)
    });
    outcome?;
    // Cancelled between two spans: no worker saw an error, but the job is not complete.
    if stats.files_done() < plan.file_count {
        bail!("cancelled");
    }
    match journal {
        Some(journal) => journal.finish(),
        None => resume::remove_journal(&root),
    }

    Ok(Summary {
        files: stats.files_done(),
        dirs: plan.dirs.len() as u64,
        extracted_bytes: stats.extracted(),
        downloaded_bytes: stats.index_bytes + stats.downloaded(),
        index_bytes: stats.index_bytes,
        verified_files: stats.files_done() + plan.skipped_files,
        skipped_files: plan.skipped_files,
        skipped_bytes: plan.skipped_bytes,
        archive_size: src.size,
        elapsed: started.elapsed(),
        retries: stats.retries.load(Ordering::Relaxed),
        spans: plan.spans.len(),
        requests: stats.requests.load(Ordering::Relaxed),
        zip_bytes_on_disk: stats.zip_bytes_on_disk.load(Ordering::Relaxed),
        renames: plan.renames,
        sequential: false,
    })
}

/// The output folder in its long-path form, if it exists already (only then can anything in it
/// be resumed).
fn existing_folder(output: &Path) -> Option<PathBuf> {
    output
        .is_dir()
        .then(|| fs::canonicalize(output).ok())
        .flatten()
}

/// Run `work` while the live terminal display and the progress callback (whichever the options
/// ask for) run on their own threads; both get a last update when `work` is done.
pub(crate) fn with_reporters<T>(
    opts: &ExtractOptions,
    stats: &Stats,
    root: &Path,
    work: impl FnOnce() -> T,
) -> T {
    let done = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let display = opts
            .progress
            .then(|| scope.spawn(|| ui::show_progress(stats, root, &done)));
        let reporter = opts.on_progress.as_ref().map(|callback| {
            scope.spawn(|| {
                loop {
                    let finished = done.load(Ordering::Relaxed);
                    callback(stats);
                    if finished {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            })
        });
        let outcome = work();
        done.store(true, Ordering::Relaxed);
        if let Some(handle) = display {
            let _ = handle.join();
        }
        if let Some(handle) = reporter {
            let _ = handle.join();
        }
        outcome
    })
}

/// Run all spans on up to `jobs` threads. Each worker repeatedly takes the next unclaimed span
/// (spans are numbered in archive order) and handles it with one Range request. The first error
/// stops everyone: it is recorded *before* the abort flag is raised, so workers that bail out
/// because of the flag can never replace the real cause.
fn execute(ctx: &Ctx, spans: &[Span], jobs: usize) -> Result<()> {
    let workers = jobs.clamp(1, spans.len().max(1));
    let next_span = AtomicUsize::new(0);
    let first_error: Mutex<Option<anyhow::Error>> = Mutex::new(None);

    std::thread::scope(|scope| {
        for worker in 0..workers {
            let (next_span, first_error) = (&next_span, &first_error);
            scope.spawn(move || {
                let mut buf = vec![0u8; BUF_SIZE];
                while !ctx.abort.load(Ordering::Relaxed) {
                    let Some(span) = spans.get(next_span.fetch_add(1, Ordering::SeqCst)) else {
                        break;
                    };
                    if let Err(e) = run_span(ctx, worker, span, &mut buf) {
                        first_error
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .get_or_insert(e);
                        ctx.abort.store(true, Ordering::SeqCst);
                    }
                }
            });
        }
    });

    match first_error.into_inner().unwrap_or_else(|p| p.into_inner()) {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// What one attempt at one entry added to the shared counters, so a failed attempt can be undone
/// (otherwise a retried entry would be counted twice on the progress bar).
#[derive(Default)]
struct Tally {
    downloaded: u64,
    extracted: u64,
}

impl Tally {
    fn roll_back(&self, stats: &Stats) {
        stats
            .downloaded
            .fetch_sub(self.downloaded, Ordering::Relaxed);
        stats.extracted.fetch_sub(self.extracted, Ordering::Relaxed);
    }
}

/// Fetch one span with a single Range request and extract every entry in it, in order.
///
/// If the network fails in the middle of an entry we drop the connection, wait (exponential
/// backoff) and open a *new* Range request that starts at the beginning of that entry. Entries
/// that already finished are never touched again. Gives up on an entry after
/// `max_attempts` tries; errors that retrying cannot fix (corrupt data, disk full, ...) are
/// reported immediately.
fn run_span(ctx: &Ctx, worker: usize, span: &Span, buf: &mut [u8]) -> Result<()> {
    let policy = ctx.src.retry;
    let mut stream: Option<RangeReader> = None;

    for file in &span.files {
        let name = &file.entry.name;
        ctx.stats.set_active(worker, name);
        let mut attempt = 1;
        loop {
            let mut tally = Tally::default();
            let result = open_if_needed(ctx, &mut stream, file.entry.local_header_offset, span.end)
                .and_then(|open| extract_entry(ctx, open, file, buf, &mut tally));
            match result {
                Ok(()) => break,
                Err(Failure::Transient(_))
                    if attempt < policy.max_attempts && !ctx.abort.load(Ordering::Relaxed) =>
                {
                    tally.roll_back(ctx.stats);
                    ctx.stats.retries.fetch_add(1, Ordering::Relaxed);
                    stream = None;
                    sleep_unless_aborted(ctx.abort, policy.delay_after(attempt));
                    attempt += 1;
                }
                Err(failure) => {
                    ctx.stats.clear_active(worker);
                    return Err(if failure.is_transient() {
                        let text = format!("extracting {name:?} failed after {attempt} attempts");
                        gave_up(failure.into_error(), text)
                    } else {
                        failure
                            .into_error()
                            .context(format!("extracting {name:?} failed"))
                    });
                }
            }
        }
        ctx.stats.clear_active(worker);
    }
    Ok(())
}

/// The span's open connection, or a new Range request starting at `start` if there is none yet
/// (first entry of the span) or it was dropped after a failure.
fn open_if_needed<'a>(
    ctx: &Ctx,
    slot: &'a mut Option<RangeReader>,
    start: u64,
    end: u64,
) -> Result<&'a mut RangeReader, Failure> {
    let reader = match slot.take() {
        Some(r) => r,
        None => {
            ctx.stats.requests.fetch_add(1, Ordering::Relaxed);
            RangeReader::open(ctx.src, start, end)?
        }
    };
    Ok(slot.insert(reader))
}

/// Sleep, but wake up early if another worker has failed and everything is being aborted.
pub(crate) fn sleep_unless_aborted(abort: &AtomicBool, total: Duration) {
    let end = Instant::now() + total;
    while !abort.load(Ordering::Relaxed) {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(Duration::from_millis(50)));
    }
}

// ------------------------------------------------------------------------------------------
// One entry
// ------------------------------------------------------------------------------------------

fn extract_entry(
    ctx: &Ctx,
    stream: &mut RangeReader,
    file: &PlannedFile,
    buf: &mut [u8],
    tally: &mut Tally,
) -> Result<(), Failure> {
    let entry = &file.entry;

    // 1 + 2: position on the entry's data.
    stream.skip_to(entry.local_header_offset)?;
    let mut header = [0u8; LOCAL_FIXED_LEN];
    stream
        .read_exact(&mut header)
        .map_err(|e| Failure::transient(anyhow!("reading the local header: {e}")))?;
    let local = LocalHeader::parse(&header).map_err(Failure::fatal)?;
    stream.skip(local.variable_len())?;

    // 3: stream the data into <name>.part
    let final_path = safety::join_under(ctx.root, &file.rel_path).map_err(Failure::fatal)?;
    let part_path = part_path(&final_path);
    if let Some(parent) = final_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            Failure::fatal(io_failure(
                e,
                format!("could not create folder {}", disk::display_path(parent)),
            ))
        })?;
    }
    let mut out = File::create(&part_path).map_err(|e| {
        Failure::fatal(io_failure(
            e,
            format!("could not create {}", disk::display_path(&part_path)),
        ))
    })?;

    let result = copy_entry(ctx, stream, file, &mut out, buf, tally);
    drop(out);

    // 4: only a fully verified file gets its real name.
    match result {
        Ok(()) => {
            rename_into_place(&part_path, &final_path).map_err(|e| {
                Failure::fatal(io_failure(
                    e,
                    format!(
                        "could not move {} into place",
                        disk::display_path(&part_path)
                    ),
                ))
            })?;
            if let Some(journal) = ctx.journal {
                journal.record(entry);
            }
            ctx.stats.files_done.fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        Err(failure) => {
            let _ = fs::remove_file(&part_path);
            Err(failure)
        }
    }
}

/// Decompress the entry's data into `out` and verify size and CRC-32.
fn copy_entry(
    ctx: &Ctx,
    stream: &mut RangeReader,
    file: &PlannedFile,
    out: &mut File,
    buf: &mut [u8],
    tally: &mut Tally,
) -> Result<(), Failure> {
    let entry = &file.entry;
    let declared = entry.uncompressed_size;
    let mut crc = crc32fast::Hasher::new();

    // Never read more than the entry's compressed bytes, so the next entry stays in reach.
    let mut data = CountingReader {
        inner: (&mut *stream).take(entry.compressed_size),
        shared: &ctx.stats.downloaded,
        mine: &mut tally.downloaded,
    };
    let extracted = Counter {
        shared: &ctx.stats.extracted,
        mine: &mut tally.extracted,
    };
    let copied = {
        let mut input = BufReader::with_capacity(BUF_SIZE, &mut data);
        match entry.method {
            METHOD_STORED => copy_limited(
                &mut input, out, declared, &mut crc, buf, extracted, ctx.abort,
            ),
            METHOD_DEFLATE => {
                let mut decoder = DeflateDecoder::new(&mut input);
                copy_limited(
                    &mut decoder,
                    out,
                    declared,
                    &mut crc,
                    buf,
                    extracted,
                    ctx.abort,
                )
            }
            m => {
                return Err(Failure::fatal(anyhow!(
                    "unsupported compression method {m}"
                )));
            }
        }
    };
    // Compressed bytes the decoder never asked for (e.g. padding after the deflate stream).
    let unread = data.inner.limit(); // last use of `data`: its borrow of `stream` ends here
    // They are part of this entry's payload, so count them once they have been skipped below.
    let count_unread = |tally: &mut Tally| {
        tally.downloaded += unread;
        ctx.stats.downloaded.fetch_add(unread, Ordering::Relaxed);
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
        Err(CopyError::Aborted) => {
            return Err(Failure::fatal(anyhow!(
                "aborted because another file failed"
            )));
        }
        Err(CopyError::Read(e)) if stream.network_failed() => {
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

    if written != declared {
        return Err(if stream.network_failed() {
            Failure::transient(anyhow!(
                "the download ended early ({written} of {declared} bytes)"
            ))
        } else {
            Failure::fatal(anyhow!(
                "size mismatch: the archive declares {declared} bytes but the data holds {written}"
            ))
        });
    }
    stream.skip(unread)?;
    count_unread(tally);

    let actual = crc.finalize();
    if actual != entry.crc32 {
        return Err(Failure::fatal(anyhow!(
            "CRC-32 mismatch: expected {:08x}, got {actual:08x}",
            entry.crc32
        )));
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) enum CopyError {
    Read(io::Error),
    Write(io::Error),
    /// The decoder produced more than the entry's declared size.
    TooMuchData,
    Aborted,
}

/// A shared progress counter plus this attempt's own running total (see [`Tally`]).
pub(crate) struct Counter<'a> {
    pub(crate) shared: &'a AtomicU64,
    pub(crate) mine: &'a mut u64,
}

impl Counter<'_> {
    pub(crate) fn add(&mut self, n: u64) {
        self.shared.fetch_add(n, Ordering::Relaxed);
        *self.mine += n;
    }
}

/// Copy `reader` to `writer`, computing the CRC and counting bytes, **never writing more than
/// `declared` bytes**. This is the zip-bomb guard: a stream that expands past the size the
/// archive declared is cut off before the offending chunk is written.
pub(crate) fn copy_limited(
    reader: &mut impl Read,
    writer: &mut impl Write,
    declared: u64,
    crc: &mut crc32fast::Hasher,
    buf: &mut [u8],
    mut written: Counter,
    abort: &AtomicBool,
) -> Result<u64, CopyError> {
    let mut total = 0u64;
    loop {
        let n = match reader.read(buf) {
            Ok(0) => return Ok(total),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(CopyError::Read(e)),
        };
        if total + n as u64 > declared {
            return Err(CopyError::TooMuchData);
        }
        writer.write_all(&buf[..n]).map_err(CopyError::Write)?;
        crc.update(&buf[..n]);
        total += n as u64;
        written.add(n as u64);
        if abort.load(Ordering::Relaxed) {
            return Err(CopyError::Aborted);
        }
    }
}

/// `dir/name.csv` -> `dir/name.csv.part`
pub(crate) fn part_path(final_path: &Path) -> PathBuf {
    let mut s = final_path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

/// Rename with a few quick retries: on Windows, antivirus or the search indexer sometimes holds
/// a freshly written file for a moment and the rename fails with "access denied".
pub(crate) fn rename_into_place(from: &Path, to: &Path) -> io::Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt >= 4 => return Err(e),
            Err(_) => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(50 * attempt));
            }
        }
    }
}

// ------------------------------------------------------------------------------------------
// Reading the HTTP response
// ------------------------------------------------------------------------------------------

/// A Range response that knows where it is in the archive and whether the *network* (as
/// opposed to the data) failed. That is what decides between "retry" and "give up".
struct RangeReader {
    inner: Response,
    /// Archive offset of the next byte this reader will return.
    pos: u64,
    /// A read returned an I/O error (connection reset, timeout, ...).
    io_failed: bool,
    /// The body ended although we asked for more bytes (connection closed early).
    ended_early: bool,
}

impl RangeReader {
    fn open(src: &Source, start: u64, end: u64) -> Result<Self, Failure> {
        let inner = src.open_range(start, end)?;
        Ok(RangeReader {
            inner,
            pos: start,
            io_failed: false,
            ended_early: false,
        })
    }

    fn network_failed(&self) -> bool {
        self.io_failed || self.ended_early
    }

    /// Discard bytes until the next read returns the byte at archive offset `target`.
    fn skip_to(&mut self, target: u64) -> Result<(), Failure> {
        if target < self.pos {
            return Err(Failure::fatal(anyhow!(
                "entries overlap or are out of order in the archive"
            )));
        }
        self.skip(target - self.pos)
    }

    /// Discard `n` bytes.
    fn skip(&mut self, n: u64) -> Result<(), Failure> {
        match io::copy(&mut self.by_ref().take(n), &mut io::sink()) {
            Ok(copied) if copied == n => Ok(()),
            Ok(copied) => Err(Failure::transient(anyhow!(
                "the connection ended early (skipped {copied} of {n} bytes)"
            ))),
            Err(e) => Err(Failure::transient(anyhow!(
                "the download was interrupted: {e}"
            ))),
        }
    }
}

impl Read for RangeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.inner.read(buf) {
            Ok(0) if !buf.is_empty() => {
                self.ended_early = true;
                Ok(0)
            }
            Ok(n) => {
                self.pos += n as u64;
                Ok(n)
            }
            Err(e) => {
                self.io_failed = true;
                Err(e)
            }
        }
    }
}

/// Adds every byte that passes through to the shared "downloaded" counter (the progress bar)
/// and to this attempt's own total.
struct CountingReader<'a, R> {
    inner: R,
    shared: &'a AtomicU64,
    mine: &'a mut u64,
}

impl<R: Read> Read for CountingReader<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.shared.fetch_add(n as u64, Ordering::Relaxed);
        *self.mine += n as u64;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /// A reader that produces zeros forever: the zip-bomb stand-in.
    struct Zeros;
    impl Read for Zeros {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            buf.fill(0);
            Ok(buf.len())
        }
    }

    /// A writer that counts what it is given and keeps nothing.
    #[derive(Default)]
    struct CountingWriter(u64);
    impl Write for CountingWriter {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0 += b.len() as u64;
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn copy(
        reader: &mut impl Read,
        declared: u64,
        sink: &mut CountingWriter,
    ) -> Result<u64, CopyError> {
        let mut buf = vec![0u8; 4096];
        let (shared, mut mine) = (AtomicU64::new(0), 0u64);
        copy_limited(
            reader,
            sink,
            declared,
            &mut crc32fast::Hasher::new(),
            &mut buf,
            Counter {
                shared: &shared,
                mine: &mut mine,
            },
            &AtomicBool::new(false),
        )
    }

    #[test]
    fn a_bomb_is_cut_off_and_never_writes_more_than_declared() {
        let mut sink = CountingWriter::default();
        let result = copy(&mut Zeros, 10_000, &mut sink);
        assert!(matches!(result, Err(CopyError::TooMuchData)));
        assert!(
            sink.0 <= 10_000,
            "wrote {} bytes for a declared size of 10000",
            sink.0
        );
    }

    #[test]
    fn exactly_the_declared_size_is_fine() {
        let data = vec![7u8; 10_000];
        let mut sink = CountingWriter::default();
        let n = copy(&mut data.as_slice(), 10_000, &mut sink).unwrap();
        assert_eq!((n, sink.0), (10_000, 10_000));
    }

    #[test]
    fn one_byte_over_is_a_bomb() {
        let data = vec![7u8; 10_001];
        let mut sink = CountingWriter::default();
        assert!(matches!(
            copy(&mut data.as_slice(), 10_000, &mut sink),
            Err(CopyError::TooMuchData)
        ));
        assert!(sink.0 <= 10_000);
    }

    #[test]
    fn zero_declared_size_accepts_only_empty_data() {
        let mut sink = CountingWriter::default();
        assert_eq!(copy(&mut io::empty(), 0, &mut sink).unwrap(), 0);
        assert!(matches!(
            copy(&mut [1u8].as_slice(), 0, &mut sink),
            Err(CopyError::TooMuchData)
        ));
        assert_eq!(sink.0, 0);
    }

    #[test]
    fn crc_and_counters_follow_the_written_data() {
        let data = b"hello linkunzip".repeat(1000);
        let mut crc = crc32fast::Hasher::new();
        let (shared, mut mine) = (AtomicU64::new(0), 0u64);
        let mut sink = CountingWriter::default();
        let mut buf = vec![0u8; 777]; // odd size on purpose
        let counter = Counter {
            shared: &shared,
            mine: &mut mine,
        };
        copy_limited(
            &mut data.as_slice(),
            &mut sink,
            data.len() as u64,
            &mut crc,
            &mut buf,
            counter,
            &AtomicBool::new(false),
        )
        .ok()
        .unwrap();
        assert_eq!(crc.finalize(), crc32fast::hash(&data));
        assert_eq!(shared.load(Ordering::Relaxed), data.len() as u64);
        assert_eq!(
            mine,
            data.len() as u64,
            "the per-attempt total matches the shared counter"
        );
    }

    #[test]
    fn rolling_back_a_failed_attempt_restores_the_shared_counters() {
        let stats = Stats::new(1, 0, 0);
        stats.downloaded.store(1000, Ordering::Relaxed);
        stats.extracted.store(5000, Ordering::Relaxed);
        // another worker's progress is in there too; only this attempt's share is removed
        let attempt = Tally {
            downloaded: 300,
            extracted: 900,
        };
        attempt.roll_back(&stats);
        assert_eq!((stats.downloaded(), stats.extracted()), (700, 4100));
    }

    #[test]
    fn abort_flag_stops_the_copy() {
        let mut sink = CountingWriter::default();
        let mut buf = vec![0u8; 4096];
        let (shared, mut mine) = (AtomicU64::new(0), 0u64);
        let r = copy_limited(
            &mut Zeros,
            &mut sink,
            u64::MAX,
            &mut crc32fast::Hasher::new(),
            &mut buf,
            Counter {
                shared: &shared,
                mine: &mut mine,
            },
            &AtomicBool::new(true),
        );
        assert!(matches!(r, Err(CopyError::Aborted)));
    }

    #[test]
    fn part_path_appends_a_suffix() {
        assert_eq!(
            part_path(Path::new("out/a/b.csv")),
            Path::new("out/a/b.csv.part")
        );
    }
}
