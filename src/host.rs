//! Chrome native-messaging host: lets the browser extension drive LinkUnzip.
//!
//! Chrome starts `linkunzip.exe chrome-extension://<id>/` and talks to it over stdin/stdout. Each
//! message is a 4-byte little-endian length followed by that many bytes of UTF-8 JSON, in both
//! directions. Nothing except protocol messages may ever be written to stdout.
//!
//! Requests (`type`): `hello`, `inspect`, `extract`, `cancel`, `reveal`, `list`, `search`,
//! `measure`, `pick_folder`.
//! Replies: `hello`, `inspected`, `started`, `progress`, `done`, `cancelled`, `listing`,
//! `search_results`, `measured`, `picked`, `error`.
//! Every request except `hello` carries an `id` chosen by the extension, and every reply to it
//! carries the same `id`, so any number of jobs can run side by side.
//!
//! Failures are `{type: "error", id?, code, message, detail, http_status?, host?}`: `code` is one
//! of [`ErrorCode`]'s names, `message` plain English, `detail` the technical chain of causes, and
//! `host` only the archive's host name (never its path or query, which can hold tokens).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::browse::{self, Tree};
use crate::disk;
use crate::error::{self, Coded, ErrorCode, RetryPolicy};
use crate::extract::{self, ExtractOptions, ProgressFn};
use crate::http;
use crate::inspect::{self, Report};
use crate::picker;
use crate::plan::{Filter, Selection};
use crate::stats::Stats;
use crate::ui::RateMeter;

/// The name Chrome uses to find this host (`chrome.runtime.connectNative("com.linkunzip.host")`).
pub const HOST_NAME: &str = "com.linkunzip.host";
/// ID of the bundled extension (fixed by the `key` in `extension/manifest.json`).
pub const EXTENSION_ID: &str = "mgmhodmhlmedihmpiofacdffdekaehhk";

/// Chrome refuses replies above 1 MiB; keep ours well below.
const MAX_REPLY: usize = 1 << 20;
/// Requests are tiny (a URL, a few headers). Anything bigger is a bug or an attack.
const MAX_REQUEST: usize = 1 << 20;
/// Headers the extension may forward. Anything else is refused.
const ALLOWED_HEADERS: [&str; 4] = ["cookie", "referer", "user-agent", "authorization"];

// ------------------------------------------------------------------------------------------
// Wire format
// ------------------------------------------------------------------------------------------

/// Read one framed message; `Ok(None)` means the browser closed the pipe.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(len) as usize;
    if n > MAX_REQUEST {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("message of {n} bytes is too large"),
        ));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

/// Write one framed message and flush it.
pub fn write_frame(w: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_REPLY {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "reply is larger than the 1 MiB native-messaging limit",
        ));
    }
    w.write_all(&(bytes.len() as u32).to_le_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

/// Shared handle for sending replies from any thread.
#[derive(Clone)]
struct Sender(Arc<Mutex<Box<dyn Write + Send>>>);

impl Sender {
    fn send(&self, value: Value) {
        let mut out = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // If the browser is gone there is nobody to tell; the read loop will see the EOF.
        let _ = write_frame(&mut *out, &value);
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Request {
    Hello,
    Inspect {
        id: String,
        url: String,
        #[serde(default)]
        output: Option<String>,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Extract {
        id: String,
        url: String,
        output: String,
        #[serde(default)]
        include: Vec<String>,
        #[serde(default = "default_jobs")]
        jobs: usize,
        #[serde(default)]
        force: bool,
        /// Read the file front to back (for servers without Range support).
        #[serde(default)]
        stream: bool,
        /// Skip files already in the folder with the right size and CRC-32.
        #[serde(default = "yes")]
        resume: bool,
        /// The file list's selection (combined with `include`: both must match).
        #[serde(default)]
        select: Option<Selection>,
        #[serde(default)]
        headers: BTreeMap<String, String>,
    },
    Cancel {
        id: String,
    },
    Reveal {
        path: String,
    },
    /// One page of a folder of an inspected archive (`id` = the `inspect` request's id).
    List {
        id: String,
        /// "" = the top, otherwise a folder path ending in "/".
        #[serde(default)]
        dir: String,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_list_limit")]
        limit: usize,
    },
    /// Files of an inspected archive whose path contains `query` (case-insensitive).
    Search {
        id: String,
        query: String,
        #[serde(default = "default_search_limit")]
        limit: usize,
    },
    /// What extracting a selection of an inspected archive would write.
    Measure {
        id: String,
        #[serde(default)]
        select: Selection,
    },
    /// Show the folder picker (opening in `start` if it exists) and answer `picked`.
    PickFolder {
        id: String,
        #[serde(default)]
        start: Option<String>,
    },
}

fn default_jobs() -> usize {
    4
}

fn default_list_limit() -> usize {
    browse::DEFAULT_LIMIT
}

fn default_search_limit() -> usize {
    browse::DEFAULT_SEARCH_LIMIT
}

fn yes() -> bool {
    true
}

/// One running job, shared between the read loop (which can cancel it) and its worker thread.
struct Job {
    cancel: Arc<AtomicBool>,
    user_cancelled: AtomicBool,
}

/// How many inspected archives stay in memory for `list`, `search` and `measure`.
const KEEP_INSPECTED: usize = 8;

/// The folder trees of the last [`KEEP_INSPECTED`] inspected archives, by the `inspect` id. They
/// live as long as the helper: after it closes (30 s idle) the extension inspects again.
#[derive(Default)]
struct Inspected {
    trees: VecDeque<(String, Arc<Tree>)>,
}

impl Inspected {
    fn insert(&mut self, id: String, tree: Arc<Tree>) {
        self.trees.retain(|(other, _)| *other != id);
        self.trees.push_back((id, tree));
        while self.trees.len() > KEEP_INSPECTED {
            self.trees.pop_front();
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Tree>> {
        self.trees
            .iter()
            .find(|(other, _)| other == id)
            .map(|(_, tree)| tree.clone())
    }
}

// ------------------------------------------------------------------------------------------
// The main loop
// ------------------------------------------------------------------------------------------

/// Serve the native-messaging protocol on stdin/stdout until the browser disconnects.
/// `parent_window` is the browser window from `--parent-window=` (see [`parent_window_arg`]).
pub fn run_stdio(parent_window: Option<isize>) -> Result<()> {
    serve(io::stdin().lock(), Box::new(io::stdout()), parent_window)
}

/// The window handle Chrome passes on Windows as `--parent-window=<decimal>` when it starts the
/// helper (0 when the caller has no window, e.g. the extension's service worker).
pub fn parent_window_arg<S: AsRef<str>>(args: &[S]) -> Option<isize> {
    args.iter()
        .find_map(|a| a.as_ref().strip_prefix("--parent-window="))
        .and_then(|n| n.parse().ok())
}

/// The protocol loop, generic over the pipes so tests can drive it directly.
pub fn serve(
    mut input: impl Read,
    output: Box<dyn Write + Send>,
    parent_window: Option<isize>,
) -> Result<()> {
    let send = Sender(Arc::new(Mutex::new(output)));
    let jobs: Arc<Mutex<HashMap<String, Arc<Job>>>> = Arc::default();
    let inspected: Arc<Mutex<Inspected>> = Arc::default();
    let mut workers: Vec<JoinHandle<()>> = Vec::new();

    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                let e = bad_request(format!("bad message framing: {e}"));
                send.send(error_reply(None, &e, None));
                break;
            }
        };
        let request: Request = match serde_json::from_slice(&frame) {
            Ok(r) => r,
            Err(e) => {
                // Echo the id back if there is one, so the extension can fail the right job.
                let value = serde_json::from_slice::<Value>(&frame).ok();
                let id = value
                    .as_ref()
                    .and_then(|v| v.get("id"))
                    .and_then(|id| id.as_str());
                let e = bad_request(format!("could not understand the request: {e}"));
                send.send(error_reply(id, &e, None));
                continue;
            }
        };
        match request {
            Request::Hello => send.send(hello()),
            Request::Cancel { id } => {
                let found = jobs
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&id)
                    .cloned();
                if let Some(job) = found {
                    job.user_cancelled.store(true, Ordering::SeqCst);
                    job.cancel.store(true, Ordering::SeqCst);
                }
            }
            Request::Reveal { path } => {
                if let Err(e) = reveal(Path::new(&path)) {
                    send.send(error_reply(None, &e, None));
                }
            }
            Request::Inspect {
                id,
                url,
                output,
                headers,
            } => {
                let inspected = inspected.clone();
                workers.push(spawn_job(&send, &jobs, id, move |send, _job, id| {
                    inspect_job(send, &inspected, id, url, output, headers)
                }));
            }
            Request::Extract {
                id,
                url,
                output,
                include,
                jobs: connections,
                force,
                stream,
                resume,
                select,
                headers,
            } => {
                workers.push(spawn_job(&send, &jobs, id, move |send, job, id| {
                    let request = ExtractRequest {
                        url,
                        output,
                        include,
                        connections,
                        force,
                        stream,
                        resume,
                        select,
                        headers,
                    };
                    extract_job(send, job, id, request)
                }));
            }
            // Browsing an inspected archive is quick (a slice of a sorted list, or one pass over
            // the entries), so it is answered right here, in order.
            Request::List {
                id,
                dir,
                offset,
                limit,
            } => send.send(with_tree(&inspected, &id, |tree| {
                let listing = listing(tree, &dir, offset, limit, LISTING_BUDGET)?;
                Ok(reply("listing", &id, listing))
            })),
            Request::Search { id, query, limit } => send.send(with_tree(&inspected, &id, |tree| {
                let (total, items) = tree.search(&query, limit.min(browse::MAX_LIMIT));
                let items = browse::within_budget(items, LISTING_BUDGET);
                Ok(json!({
                    "type": "search_results", "id": id, "query": query,
                    "total": total, "items": items,
                }))
            })),
            Request::Measure { id, select } => send.send(with_tree(&inspected, &id, |tree| {
                let m = tree.measure(&Filter::with_selection(&[], Some(&select))?);
                Ok(json!({
                    "type": "measured", "id": id, "files": m.files, "extracted": m.extracted,
                    "compressed": m.compressed, "unsupported": m.unsupported,
                }))
            })),
            // The dialog waits for the user, so it gets a thread (and COM apartment) of its own
            // and the loop keeps answering. Not joined at the end: if the browser goes away, the
            // dialog goes with the process.
            Request::PickFolder { id, start } => {
                let send = send.clone();
                std::thread::spawn(move || {
                    let start = start.map(PathBuf::from);
                    let reply = match catch_unwind(AssertUnwindSafe(|| {
                        picker::pick_folder(start.as_deref(), parent_window)
                    })) {
                        Ok(Ok(path)) => picked_reply(&id, path.as_deref()),
                        Ok(Err(e)) => error_reply(Some(&id), &e, None),
                        Err(payload) => {
                            error_reply(Some(&id), &panic_error(payload.as_ref()), None)
                        }
                    };
                    send.send(reply);
                });
            }
        }
        workers.retain(|h| !h.is_finished());
    }

    // The browser went away: stop what is running, but let each job clean up its .part files.
    for job in jobs.lock().unwrap_or_else(|p| p.into_inner()).values() {
        job.user_cancelled.store(true, Ordering::SeqCst);
        job.cancel.store(true, Ordering::SeqCst);
    }
    for handle in workers {
        let _ = handle.join();
    }
    Ok(())
}

/// Register the job, run `body` on its own thread (panics become an `error` reply), unregister it.
fn spawn_job(
    send: &Sender,
    jobs: &Arc<Mutex<HashMap<String, Arc<Job>>>>,
    id: String,
    body: impl FnOnce(&Sender, &Arc<Job>, &str) + Send + 'static,
) -> JoinHandle<()> {
    let job = Arc::new(Job {
        cancel: Arc::new(AtomicBool::new(false)),
        user_cancelled: AtomicBool::new(false),
    });
    jobs.lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), job.clone());
    let (send, jobs) = (send.clone(), jobs.clone());
    std::thread::spawn(move || {
        let outcome = catch_unwind(AssertUnwindSafe(|| body(&send, &job, &id)));
        if let Err(payload) = outcome {
            send.send(error_reply(Some(&id), &panic_error(payload.as_ref()), None));
        }
        jobs.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
    })
}

/// An `internal` error carrying what the panic said.
fn panic_error(payload: &(dyn std::any::Any + Send)) -> anyhow::Error {
    let what = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string());
    Coded::new(ErrorCode::Internal, format!("panic: {what}")).into()
}

/// The protocol this helper speaks (the extension offers an update below its minimum). Protocol
/// 1 helpers (v0.2 and older) sent no `protocol` at all.
pub const PROTOCOL: u32 = 2;

/// What the extension may use, announced in `hello`.
pub fn features() -> Vec<&'static str> {
    let mut features = vec![
        "list",
        "search",
        "measure",
        "select",
        "resume",
        "error_codes",
    ];
    if cfg!(windows) {
        features.insert(0, "pick_folder");
    }
    features
}

fn hello() -> Value {
    json!({
        "type": "hello",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": PROTOCOL,
        "features": features(),
        "os": std::env::consts::OS,
        "downloads_dir": downloads_dir().to_string_lossy(),
    })
}

/// `picked {id, path}`: the chosen folder, or `null` when the user cancelled.
fn picked_reply(id: &str, path: Option<&Path>) -> Value {
    json!({"type": "picked", "id": id, "path": path.map(disk::display_path)})
}

/// `%USERPROFILE%\Downloads` (the usual place), else the home folder, else the temp folder.
pub fn downloads_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    match home {
        Some(h) if h.join("Downloads").is_dir() => h.join("Downloads"),
        Some(h) => h,
        None => std::env::temp_dir(),
    }
}

// ------------------------------------------------------------------------------------------
// Jobs
// ------------------------------------------------------------------------------------------

/// The `error` reply: `{type, id?, code, message, detail, http_status?, host?}`. `url` is the
/// archive's URL when the request had one; only its host name is ever sent back, and URLs inside
/// `message` and `detail` lose their path and query (they can hold access tokens, and the
/// extension's "Copy details" puts `detail` into bug reports).
fn error_reply(id: Option<&str>, e: &anyhow::Error, url: Option<&str>) -> Value {
    let host = url.and_then(http::host_of);
    let d = error::describe(e, host.as_deref());
    let mut reply = json!({
        "type": "error",
        "code": d.code.as_str(),
        "message": redact_urls(&d.message),
        "detail": redact_urls(&d.detail),
    });
    if let Some(id) = id {
        reply["id"] = id.into();
    }
    if let Some(status) = d.http_status {
        reply["http_status"] = status.into();
    }
    if let Some(host) = host {
        reply["host"] = host.into();
    }
    reply
}

/// A request the helper refuses to carry out as asked.
fn bad_request(detail: impl Into<String>) -> anyhow::Error {
    Coded::new(ErrorCode::BadRequest, detail).into()
}

/// Replace the path and query of every http(s) URL in `text` with `/...`, and drop any user name
/// and password in it: `https://user:pw@host/a?token=x` becomes `https://host/...`.
fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = ["http://", "https://"]
        .iter()
        .filter_map(|scheme| rest.find(scheme))
        .min()
    {
        out.push_str(&rest[..start]);
        let url = &rest[start..];
        let token = url
            .find(|c: char| c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '>' | '`'))
            .unwrap_or(url.len());
        // "could not reach https://x/a.zip: ..." - the colon belongs to the sentence.
        let end = url[..token].trim_end_matches([':', ',', '.', ';']).len();
        let after_scheme = url.find("://").map_or(0, |i| i + 3);
        let host_end = url[after_scheme..end]
            .find(['/', '?', '#'])
            .map_or(end, |i| after_scheme + i);
        let authority = &url[after_scheme..host_end];
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        out.push_str(&url[..after_scheme]);
        out.push_str(host);
        if host_end < end {
            out.push_str("/...");
        }
        rest = &url[end..];
    }
    out.push_str(rest);
    out
}

/// Header map from the request, limited to the names the extension is allowed to forward.
fn checked_headers(headers: BTreeMap<String, String>) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for (name, value) in headers {
        if !ALLOWED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(bad_request(format!(
                "the header {name:?} is not allowed (allowed: {})",
                ALLOWED_HEADERS.join(", ")
            )));
        }
        out.push((name, value));
    }
    Ok(out)
}

fn inspect_job(
    send: &Sender,
    inspected: &Mutex<Inspected>,
    id: &str,
    url: String,
    output: Option<String>,
    headers: BTreeMap<String, String>,
) {
    let result = checked_headers(headers).and_then(|headers| {
        let target = output.map(PathBuf::from).unwrap_or_else(downloads_dir);
        inspect::inspect_with(&url, &target, RetryPolicy::default(), &headers)
    });
    let mut report = match result {
        Ok(report) => report,
        Err(e) => return send.send(error_reply(Some(id), &e, Some(&url))),
    };
    let mut json = report_json(&report);
    // Keep the index for `list`, `search` and `measure`, and show the top folder right away,
    // in whatever room the rest of the report leaves under the 1 MB limit.
    let tree = Arc::new(Tree::new(std::mem::take(&mut report.entries)));
    let used = serde_json::to_vec(&json).map_or(MAX_REPLY, |b| b.len());
    let room = MAX_REPLY.saturating_sub(used + 16 * 1024);
    json["root_dirs"] = listing(
        &tree,
        "",
        0,
        browse::DEFAULT_LIMIT,
        room.min(LISTING_BUDGET),
    )
    .unwrap_or_else(|_| json!({"dir": "", "offset": 0, "total": 0, "items": []}));
    inspected
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.to_string(), tree);
    send.send(json!({"type": "inspected", "id": id, "report": json}));
}

/// The most JSON a page of `list` or `search` items may take, leaving room for the rest of the
/// reply under the browser's 1 MB limit. Pages with very long names hold fewer items than asked
/// for; the next page starts at `offset + items.length`.
const LISTING_BUDGET: usize = 1_000_000;

/// `{dir, offset, total, items}` for one page of a folder.
fn listing(tree: &Tree, dir: &str, offset: usize, limit: usize, budget: usize) -> Result<Value> {
    let (total, items) = tree
        .list(dir, offset, limit.min(browse::MAX_LIMIT))
        .ok_or_else(|| bad_request(format!("there is no folder {dir:?} in the archive")))?;
    Ok(json!({
        "dir": dir,
        "offset": offset,
        "total": total,
        "items": browse::within_budget(items, budget),
    }))
}

/// `body` with `type` and `id` added.
fn reply(kind: &str, id: &str, mut body: Value) -> Value {
    body["type"] = kind.into();
    body["id"] = id.into();
    body
}

/// Answer a browsing request about the archive inspected as `id`; `unknown_job` if the helper no
/// longer has it (it restarted, or it has inspected 8 others since).
fn with_tree(
    inspected: &Mutex<Inspected>,
    id: &str,
    answer: impl FnOnce(&Tree) -> Result<Value>,
) -> Value {
    let tree = inspected.lock().unwrap_or_else(|p| p.into_inner()).get(id);
    let Some(tree) = tree else {
        let e = Coded::new(
            ErrorCode::UnknownJob,
            format!(
                "no inspected archive with id {id:?} (the helper keeps the last {KEEP_INSPECTED})"
            ),
        );
        return error_reply(Some(id), &e.into(), None);
    };
    match catch_unwind(AssertUnwindSafe(|| answer(&tree))) {
        Ok(Ok(value)) => value,
        Ok(Err(e)) => error_reply(Some(id), &e, None),
        Err(payload) => error_reply(Some(id), &panic_error(payload.as_ref()), None),
    }
}

/// The numbers the popup shows before the user commits to anything.
fn report_json(r: &Report) -> Value {
    let t = &r.totals;
    let fits = |needed: u64| r.free.map(|free| needed <= free);
    json!({
        "url": r.url,
        "mode": "range",
        "archive_size": r.archive_size,
        "etag": r.etag,
        "last_modified": r.last_modified,
        "files": t.files,
        "dirs": t.dirs,
        "entries_total": r.entries.len(),
        "dirs_total": t.folders,
        "index_bytes": r.index_bytes,
        "compressed": t.compressed,
        "extracted": t.extracted,
        "normal_needs": r.normal_needs(),
        "linkunzip_needs": r.linkunzip_needs(),
        "free": r.free,
        "drive": disk::drive_label(&r.target),
        "normal_fits": fits(r.normal_needs()),
        "linkunzip_fits": fits(r.linkunzip_needs()),
        "unsupported": t.unsupported.len(),
        "unsupported_sample": t.unsupported.iter().take(3)
            .map(|(name, reason)| json!({"name": name, "reason": reason}))
            .collect::<Vec<_>>(),
        "largest": r.largest(5).iter()
            .map(|e| json!({"name": e.name, "size": e.uncompressed_size}))
            .collect::<Vec<_>>(),
    })
}

struct ExtractRequest {
    url: String,
    output: String,
    include: Vec<String>,
    connections: usize,
    force: bool,
    stream: bool,
    resume: bool,
    select: Option<Selection>,
    headers: BTreeMap<String, String>,
}

fn extract_job(send: &Sender, job: &Arc<Job>, id: &str, request: ExtractRequest) {
    let ExtractRequest {
        url,
        output,
        include,
        connections,
        force,
        stream,
        resume,
        select,
        headers,
    } = request;
    let prepared = checked_headers(headers).and_then(|headers| {
        if !(1..=64).contains(&connections) {
            return Err(bad_request("jobs must be between 1 and 64"));
        }
        let output = PathBuf::from(&output);
        if !output.is_absolute() {
            return Err(bad_request(format!(
                "the output folder must be an absolute path (got {:?})",
                output.display().to_string()
            )));
        }
        Ok((headers, output))
    });
    let (headers, output) = match prepared {
        Ok(p) => p,
        Err(e) => return send.send(error_reply(Some(id), &e, Some(&url))),
    };

    send.send(json!({"type": "started", "id": id, "output": disk::display_path(&output)}));

    let started = Instant::now();
    let files_done = Arc::new(AtomicU64::new(0));
    let extracted = Arc::new(AtomicU64::new(0));
    let on_progress: ProgressFn = {
        let (send, id, dest) = (send.clone(), id.to_string(), output.clone());
        let (files_done, extracted) = (files_done.clone(), extracted.clone());
        let meter = Mutex::new((RateMeter::new(), Instant::now()));
        Arc::new(move |stats: &Stats| {
            let rate = {
                let mut guard = meter.lock().unwrap_or_else(|p| p.into_inner());
                let (rate_meter, last) = &mut *guard;
                let now = Instant::now();
                let rate = rate_meter.update(now - *last, stats.downloaded());
                *last = now;
                rate
            };
            files_done.store(stats.files_done(), Ordering::Relaxed);
            extracted.store(stats.extracted(), Ordering::Relaxed);
            send.send(progress_json(&id, stats, rate, &dest, started));
        })
    };

    let opts = ExtractOptions {
        url: url.clone(),
        output: output.clone(),
        include,
        select,
        jobs: connections,
        force,
        retry: RetryPolicy::default(),
        progress: false, // stdout belongs to the protocol; stderr is not a terminal here anyway
        headers,
        cancel: Some(job.cancel.clone()),
        on_progress: Some(on_progress),
        stream,
        resume,
    };
    match extract::run(&opts) {
        Ok(s) => send.send(json!({
            "type": "done",
            "id": id,
            "output": disk::display_path(&output),
            "files": s.files,
            "dirs": s.dirs,
            "extracted_bytes": s.extracted_bytes,
            "downloaded_bytes": s.downloaded_bytes,
            "index_bytes": s.index_bytes,
            "verified_files": s.verified_files,
            "skipped_existing": s.skipped_files,
            "skipped_bytes": s.skipped_bytes,
            "archive_size": s.archive_size,
            "normal_needs": s.normal_needs(),
            "elapsed_ms": s.elapsed.as_millis() as u64,
            "retries": s.retries,
            "requests": s.requests,
            "zip_bytes_on_disk": s.zip_bytes_on_disk,
            "renamed": s.renames.len(),
            "stream": s.sequential,
        })),
        Err(_) if job.user_cancelled.load(Ordering::SeqCst) => send.send(json!({
            "type": "cancelled",
            "id": id,
            "output": disk::display_path(&output),
            "files_done": files_done.load(Ordering::Relaxed),
            "extracted_bytes": extracted.load(Ordering::Relaxed),
        })),
        Err(e) => send.send(error_reply(Some(id), &e, Some(&url))),
    }
}

fn progress_json(id: &str, stats: &Stats, rate: f64, dest: &Path, started: Instant) -> Value {
    // Sequential mode from a server that does not announce the size has no total (0): then the
    // byte count is not clamped to it and there is no time estimate.
    let known = stats.total_compressed > 0;
    let downloaded = if known {
        stats.downloaded().min(stats.total_compressed)
    } else {
        stats.downloaded()
    };
    let remaining = stats.total_compressed.saturating_sub(downloaded);
    let eta = (known && rate >= 1.0).then(|| (remaining as f64 / rate) as u64);
    let active = stats.active_names();
    json!({
        "type": "progress",
        "id": id,
        "downloaded": downloaded,
        "total_compressed": stats.total_compressed,
        "extracted": stats.extracted(),
        "total_extracted": stats.total_extracted,
        "files_done": stats.files_done(),
        "total_files": stats.total_files,
        // Resume: what was already in the folder, left out of the totals above.
        "skipped_files": stats.skipped_files,
        "skipped_compressed": stats.skipped_compressed,
        "skipped_extracted": stats.skipped_extracted,
        "rate": rate as u64,
        "eta_secs": eta,
        "active": active.iter().take(3).collect::<Vec<_>>(),
        "active_count": active.len(),
        "retries": stats.retries.load(Ordering::Relaxed),
        "requests": stats.requests.load(Ordering::Relaxed),
        "zip_on_disk": stats.zip_bytes_on_disk.load(Ordering::Relaxed),
        "free": disk::free_space(dest).ok(),
        "elapsed_ms": started.elapsed().as_millis() as u64,
    })
}

/// Open a folder in the system file manager.
fn reveal(path: &Path) -> Result<()> {
    if !path.is_dir() {
        bail!("{} is not a folder", disk::display_path(path));
    }
    #[cfg(windows)]
    let mut cmd = Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path)
        .spawn()
        .context("could not open the file manager")?;
    Ok(())
}

// ------------------------------------------------------------------------------------------
// Installing the host for the browser
// ------------------------------------------------------------------------------------------

/// Registry keys (under HKEY_CURRENT_USER) where each Chromium-based browser looks for hosts.
const BROWSER_KEYS: [(&str, &str); 4] = [
    ("Chrome", r"Software\Google\Chrome\NativeMessagingHosts"),
    ("Edge", r"Software\Microsoft\Edge\NativeMessagingHosts"),
    (
        "Brave",
        r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    ),
    ("Chromium", r"Software\Chromium\NativeMessagingHosts"),
];

/// Where the installed copy of the binary and the host manifest live.
pub fn install_dir() -> Result<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .context("LOCALAPPDATA is not set")?;
    Ok(base.join("linkunzip"))
}

/// The JSON that tells the browser which program is the host and which extensions may use it.
pub fn host_manifest(exe: &Path, extension_ids: &[String]) -> Value {
    json!({
        "name": HOST_NAME,
        "description": "LinkUnzip: extract a ZIP straight from a URL without saving the ZIP",
        "path": disk::display_path(exe),
        "type": "stdio",
        "allowed_origins": extension_ids.iter()
            .map(|id| format!("chrome-extension://{id}/"))
            .collect::<Vec<_>>(),
    })
}

/// Copy this binary to a stable place (so rebuilding the project never fights a running host),
/// write the host manifest and register it for the current user in each browser's registry key.
pub fn install(extension_ids: &[String]) -> Result<String> {
    if !cfg!(windows) {
        bail!("host install is only implemented for Windows");
    }
    let dir = install_dir()?;
    std::fs::create_dir_all(&dir).with_context(|| format!("could not create {}", dir.display()))?;
    let exe_src = std::env::current_exe().context("could not find this program's own path")?;
    let exe = dir.join("linkunzip.exe");
    if exe_src != exe {
        std::fs::copy(&exe_src, &exe).with_context(|| {
            format!(
                "could not copy linkunzip.exe to {} (is the extension still connected? close the browser and retry)",
                dir.display()
            )
        })?;
    }
    let manifest = dir.join(format!("{HOST_NAME}.json"));
    let json = serde_json::to_string_pretty(&host_manifest(&exe, extension_ids))?;
    std::fs::write(&manifest, json)
        .with_context(|| format!("could not write {}", manifest.display()))?;

    let mut report = format!(
        "Installed LinkUnzip for the browser extension\n  program    {}\n  manifest   {}\n  extension  {}\n",
        disk::display_path(&exe),
        disk::display_path(&manifest),
        extension_ids.join(", ")
    );
    for (browser, key) in BROWSER_KEYS {
        let full = format!(r"HKCU\{key}\{HOST_NAME}");
        let status = Command::new("reg")
            .args(["add", &full, "/ve", "/t", "REG_SZ", "/d"])
            .arg(&manifest)
            .arg("/f")
            .output()
            .context("could not run reg.exe")?;
        if status.status.success() {
            report.push_str(&format!("  registered for {browser}\n"));
        } else {
            report.push_str(&format!("  could not register for {browser}\n"));
        }
    }
    Ok(report)
}

/// Remove the registry entries, the manifest and the installed copy of the binary.
pub fn uninstall() -> Result<String> {
    if !cfg!(windows) {
        bail!("host uninstall is only implemented for Windows");
    }
    for (_, key) in BROWSER_KEYS {
        let full = format!(r"HKCU\{key}\{HOST_NAME}");
        let _ = Command::new("reg").args(["delete", &full, "/f"]).output();
    }
    let dir = install_dir()?;
    let removed = std::fs::remove_dir_all(&dir).is_ok();
    Ok(if removed {
        format!(
            "Removed the browser registration and {}\n",
            disk::display_path(&dir)
        )
    } else {
        format!(
            "Removed the browser registration. Could not delete {} (still in use? it is safe to delete by hand)\n",
            disk::display_path(&dir)
        )
    })
}

/// Is the host registered for each browser, and where does it point?
pub fn status() -> Result<String> {
    let mut out = String::new();
    for (browser, key) in BROWSER_KEYS {
        let full = format!(r"HKCU\{key}\{HOST_NAME}");
        let result = Command::new("reg").args(["query", &full, "/ve"]).output();
        let line = match result {
            Ok(o) if o.status.success() => {
                let text = String::from_utf8_lossy(&o.stdout);
                text.lines()
                    .find(|l| l.contains("REG_SZ"))
                    .and_then(|l| l.split("REG_SZ").nth(1))
                    .map(|p| p.trim().to_string())
                    .unwrap_or_else(|| "registered".to_string())
            }
            _ => "not registered".to_string(),
        };
        out.push_str(&format!("  {browser:<9} {line}\n"));
    }
    out.push_str(&format!("  extension id   {EXTENSION_ID}\n"));
    out.push_str(&format!(
        "  downloads dir  {}\n",
        disk::display_path(&downloads_dir())
    ));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_of_a_resumed_job_says_what_was_already_there() {
        let stats = Stats::new(3, 300, 600).with_skipped(7, 700, 1400);
        let p = progress_json("j", &stats, 0.0, Path::new("."), Instant::now());
        assert_eq!(
            (p["total_files"].as_u64(), p["total_compressed"].as_u64()),
            (Some(3), Some(300))
        );
        assert_eq!(p["skipped_files"], 7);
        assert_eq!(p["skipped_compressed"], 700);
        assert_eq!(p["skipped_extracted"], 1400);
        let fresh = progress_json(
            "k",
            &Stats::new(3, 300, 600),
            0.0,
            Path::new("."),
            Instant::now(),
        );
        assert_eq!(fresh["skipped_files"], 0);
    }

    #[test]
    fn parent_window_comes_from_chromes_arguments() {
        let args = [
            "linkunzip.exe",
            "chrome-extension://abc/",
            "--parent-window=132456",
        ];
        assert_eq!(parent_window_arg(&args), Some(132456));
        assert_eq!(parent_window_arg(&["x", "--parent-window=0"]), Some(0));
        assert_eq!(parent_window_arg(&["x", "chrome-extension://abc/"]), None);
        assert_eq!(parent_window_arg(&["x", "--parent-window=abc"]), None);
    }

    #[test]
    fn pick_folder_request_and_picked_reply() {
        let r: Request =
            serde_json::from_value(json!({"type": "pick_folder", "id": "p1", "start": "C:\\x"}))
                .unwrap();
        assert!(
            matches!(r, Request::PickFolder { ref id, start: Some(ref s) } if id == "p1" && s == "C:\\x")
        );
        let r: Request =
            serde_json::from_value(json!({"type": "pick_folder", "id": "p2"})).unwrap();
        assert!(matches!(r, Request::PickFolder { start: None, .. }));

        let reply = picked_reply("p1", Some(Path::new("D:\\Games")));
        assert_eq!(
            reply,
            json!({"type": "picked", "id": "p1", "path": "D:\\Games"})
        );
        let reply = picked_reply("p2", None);
        assert_eq!(reply, json!({"type": "picked", "id": "p2", "path": null}));
    }

    #[test]
    fn frames_round_trip() {
        let mut wire = Vec::new();
        write_frame(&mut wire, &json!({"type": "hello"})).unwrap();
        assert_eq!(&wire[..4], &(wire.len() as u32 - 4).to_le_bytes());
        let mut cursor = io::Cursor::new(wire);
        let frame = read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&frame).unwrap()["type"],
            "hello"
        );
        assert!(
            read_frame(&mut cursor).unwrap().is_none(),
            "EOF is a clean end"
        );
    }

    #[test]
    fn oversized_and_truncated_frames_are_errors() {
        let mut big = io::Cursor::new(((MAX_REQUEST as u32) + 1).to_le_bytes().to_vec());
        assert!(read_frame(&mut big).is_err());
        let mut short = io::Cursor::new([10u8, 0, 0, 0, b'{']);
        assert!(read_frame(&mut short).is_err());
    }

    #[test]
    fn only_allowed_headers_pass() {
        let ok = BTreeMap::from([("Cookie".to_string(), "a=b".to_string())]);
        assert_eq!(checked_headers(ok).unwrap().len(), 1);
        let bad = BTreeMap::from([("X-Evil".to_string(), "1".to_string())]);
        assert!(
            checked_headers(bad)
                .unwrap_err()
                .to_string()
                .contains("not allowed")
        );
    }

    #[test]
    fn urls_lose_their_path_query_and_credentials() {
        assert_eq!(
            redact_urls(
                "could not reach https://b.s3.amazonaws.com/x/a.zip?X-Amz-Signature=secret: boom"
            ),
            "could not reach https://b.s3.amazonaws.com/...: boom"
        );
        assert_eq!(
            redact_urls("error sending request for url (http://user:pw@127.0.0.1:9/a.zip?t=1)"),
            "error sending request for url (http://127.0.0.1:9/...)"
        );
        assert_eq!(
            redact_urls("a http://h b https://h2/p \"https://h3?q\""),
            "a http://h b https://h2/... \"https://h3/...\""
        );
        assert_eq!(redact_urls("no links here"), "no links here");
    }

    #[test]
    fn error_replies_carry_code_message_detail_and_host_only() {
        let e = anyhow::Error::from(
            Coded::new(ErrorCode::LinkExpired, "the server answered 403 Forbidden")
                .with_status(403),
        )
        .context("could not reach https://files.example.com/a.zip?token=secret");
        let reply = error_reply(
            Some("7"),
            &e,
            Some("https://files.example.com/a.zip?token=secret"),
        );
        assert_eq!(reply["type"], "error");
        assert_eq!(reply["id"], "7");
        assert_eq!(reply["code"], "link_expired");
        assert_eq!(reply["http_status"], 403);
        assert_eq!(reply["host"], "files.example.com");
        assert!(reply["message"].as_str().unwrap().contains("expired"));
        let text = reply.to_string();
        assert!(
            !text.contains("secret") && !text.contains("a.zip"),
            "{text}"
        );
        assert!(reply["detail"].as_str().unwrap().contains("403 Forbidden"));

        // Without an id, an HTTP status or a URL those keys are left out.
        let plain = error_reply(None, &anyhow::anyhow!("boom"), None);
        assert_eq!(plain["code"], "failed");
        assert_eq!(plain["message"], "boom");
        for key in ["id", "http_status", "host"] {
            assert!(plain.get(key).is_none(), "{key}: {plain}");
        }
    }

    #[test]
    fn a_panic_becomes_an_internal_error() {
        let payload = std::panic::catch_unwind(|| panic!("index out of range")).unwrap_err();
        let reply = error_reply(Some("p"), &panic_error(payload.as_ref()), None);
        assert_eq!(reply["code"], "internal");
        assert!(
            reply["detail"]
                .as_str()
                .unwrap()
                .contains("index out of range")
        );
    }

    #[test]
    fn manifest_lists_the_extension_origin() {
        let m = host_manifest(Path::new(r"C:\x\linkunzip.exe"), &["abc".to_string()]);
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["allowed_origins"][0], "chrome-extension://abc/");
    }

    #[test]
    fn requests_parse_with_defaults() {
        let r: Request = serde_json::from_str(
            r#"{"type":"extract","id":"1","url":"http://x/a.zip","output":"C:\\o"}"#,
        )
        .unwrap();
        match r {
            Request::Extract {
                jobs,
                force,
                include,
                headers,
                ..
            } => {
                assert_eq!(jobs, 4);
                assert!(!force && include.is_empty() && headers.is_empty());
            }
            other => panic!("{other:?}"),
        }
        assert!(serde_json::from_str::<Request>(r#"{"type":"nope"}"#).is_err());
    }
}
