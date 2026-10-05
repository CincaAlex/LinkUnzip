//! A tiny local HTTP file server for the tests, with HTTP Range support and fault injection.
//!
//! It runs on its own thread with its own tokio runtime so the (blocking) code under test can
//! talk to it from the test thread.

use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use futures_util::{StreamExt, stream};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

/// "Drop the connection mid-file": for the first `times` Range responses whose range contains the
/// archive byte `cut_at_offset` (and starts before it), stop sending right before that byte and
/// abort the connection. A retry that starts earlier than `cut_at_offset` is cut again (while
/// `times` lasts), which lets a test simulate both a one-off blip and a persistent failure.
#[derive(Clone, Debug)]
pub struct Fault {
    pub cut_at_offset: u64,
    pub times: usize,
}

#[derive(Clone, Debug)]
pub struct ServerOptions {
    /// false = behave like a server without Range support (always 200 with the whole file).
    pub support_range: bool,
    pub fault: Option<Fault>,
    /// Change the ETag from the Nth request on, simulating the file being replaced.
    pub change_etag_after: Option<usize>,
    /// Pause this long after every 64 KiB sent, so a transfer takes long enough to interrupt.
    pub chunk_delay_ms: u64,
    /// Answer every request with a 302 to `<this base URL>/<same path>` (e.g. another server).
    pub redirect_to: Option<String>,
    /// Answer every request with this status and a small HTML page (401, 403, 404, 500...).
    pub status: Option<u16>,
    /// The `Content-Type` of every file (none by default), e.g. `text/html` for a login page.
    pub content_type: Option<String>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        ServerOptions {
            support_range: true,
            fault: None,
            change_etag_after: None,
            chunk_delay_ms: 0,
            redirect_to: None,
            status: None,
            content_type: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct RequestLog {
    pub path: String,
    /// Inclusive byte range requested (after clamping to the file size), if any.
    pub range: Option<(u64, u64)>,
    pub status: u16,
    pub faulted: bool,
    /// The `Cookie` request header, if the client sent one.
    pub cookie: Option<String>,
}

struct Shared {
    root: PathBuf,
    opts: ServerOptions,
    log: Mutex<Vec<RequestLog>>,
    faults_left: AtomicUsize,
    requests_seen: AtomicUsize,
}

pub struct TestServer {
    pub base_url: String,
    shared: Arc<Shared>,
    shutdown: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl TestServer {
    pub fn start(root: &Path, opts: ServerOptions) -> TestServer {
        let shared = Arc::new(Shared {
            root: root.to_path_buf(),
            faults_left: AtomicUsize::new(opts.fault.as_ref().map_or(0, |f| f.times)),
            opts,
            log: Mutex::new(Vec::new()),
            requests_seen: AtomicUsize::new(0),
        });
        let (port_tx, port_rx) = std::sync::mpsc::channel();
        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let state = shared.clone();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                port_tx.send(listener.local_addr().unwrap().port()).unwrap();
                let app = Router::new()
                    .route("/{*name}", get(serve))
                    .with_state(state);
                // `select!` (rather than graceful shutdown) so lingering keep-alive connections
                // cannot hold the test process up.
                tokio::select! {
                    _ = axum::serve(listener, app) => {}
                    _ = shutdown_rx => {}
                }
            });
        });
        let port = port_rx.recv().unwrap();
        TestServer {
            base_url: format!("http://127.0.0.1:{port}"),
            shared,
            shutdown: Some(shutdown_tx),
            thread: Some(thread),
        }
    }

    pub fn url_for(&self, name: &str) -> String {
        format!("{}/{}", self.base_url, name)
    }

    pub fn requests(&self) -> Vec<RequestLog> {
        self.shared.log.lock().unwrap().clone()
    }

    /// Total bytes the server was asked to send via Range requests (excluding faulted cut-offs).
    pub fn bytes_requested(&self) -> u64 {
        self.requests()
            .iter()
            .filter_map(|r| r.range)
            .map(|(s, e)| e - s + 1)
            .sum()
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

const LAST_MODIFIED: &str = "Fri, 01 Mar 2024 12:00:00 GMT";

fn status_only(code: StatusCode) -> Response {
    Response::builder()
        .status(code)
        .body(Body::empty())
        .unwrap()
}

/// Parse `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `total` bytes (inclusive range).
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.is_empty(), b.is_empty()) {
        (false, false) => (a.parse().ok()?, b.parse::<u64>().ok()?),
        (false, true) => (a.parse().ok()?, total.checked_sub(1)?),
        (true, false) => {
            let n: u64 = b.parse().ok()?;
            (total.saturating_sub(n), total.checked_sub(1)?)
        }
        (true, true) => return None,
    };
    if start > end || start >= total {
        return None;
    }
    Some((start, end.min(total - 1)))
}

async fn serve(
    State(st): State<Arc<Shared>>,
    UrlPath(name): UrlPath<String>,
    headers: HeaderMap,
) -> Response {
    let seq = st.requests_seen.fetch_add(1, Ordering::SeqCst) + 1;
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if let Some(base) = &st.opts.redirect_to {
        st.log.lock().unwrap().push(RequestLog {
            path: name.clone(),
            range: None,
            status: 302,
            faulted: false,
            cookie,
        });
        return Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, format!("{base}/{name}"))
            .body(Body::empty())
            .unwrap();
    }
    if let Some(code) = st.opts.status {
        st.log.lock().unwrap().push(RequestLog {
            path: name,
            range: None,
            status: code,
            faulted: false,
            cookie,
        });
        return Response::builder()
            .status(code)
            .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
            .body(Body::from(format!(
                "<html><body>Error {code}</body></html>"
            )))
            .unwrap();
    }
    let path = st.root.join(&name);
    let Ok(meta) = tokio::fs::metadata(&path).await else {
        st.log.lock().unwrap().push(RequestLog {
            path: name,
            range: None,
            status: 404,
            faulted: false,
            cookie,
        });
        return status_only(StatusCode::NOT_FOUND);
    };
    let total = meta.len();

    let etag_version = match st.opts.change_etag_after {
        Some(n) if seq > n => 2,
        _ => 1,
    };
    let base = |status: StatusCode| {
        Response::builder()
            .status(status)
            .header(header::ETAG, format!("\"v{etag_version}\""))
            .header(header::LAST_MODIFIED, LAST_MODIFIED)
    };

    let range_header = if st.opts.support_range {
        headers.get(header::RANGE).and_then(|v| v.to_str().ok())
    } else {
        None
    };
    let (status, start, end) = match range_header {
        None => (StatusCode::OK, 0, total.saturating_sub(1)),
        Some(h) => match parse_range(h, total) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
            None => {
                st.log.lock().unwrap().push(RequestLog {
                    path: name,
                    range: None,
                    status: 416,
                    faulted: false,
                    cookie,
                });
                return base(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                    .body(Body::empty())
                    .unwrap();
            }
        },
    };
    let len = if total == 0 { 0 } else { end - start + 1 };

    // Decide whether to cut this response short.
    let mut cut_after = None;
    if (status == StatusCode::PARTIAL_CONTENT || !st.opts.support_range)
        && let Some(f) = &st.opts.fault
        && start < f.cut_at_offset
        && f.cut_at_offset <= end
        && st
            .faults_left
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
    {
        cut_after = Some(f.cut_at_offset - start);
    }
    st.log.lock().unwrap().push(RequestLog {
        path: name,
        range: (status == StatusCode::PARTIAL_CONTENT).then_some((start, end)),
        status: status.as_u16(),
        faulted: cut_after.is_some(),
        cookie,
    });

    let mut file = tokio::fs::File::open(&path).await.unwrap();
    file.seek(SeekFrom::Start(start)).await.unwrap();
    let send_len = cut_after.unwrap_or(len);
    let reader = ReaderStream::with_capacity(file.take(send_len), 64 * 1024);
    let delay = st.opts.chunk_delay_ms;
    let reader = reader.then(move |chunk| async move {
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        chunk
    });
    let body = if cut_after.is_some() {
        // The promised Content-Length is never reached: the stream ends in an error, so the
        // connection is aborted mid-body, which is what a real network drop looks like.
        let boom = stream::once(async {
            Err::<Bytes, std::io::Error>(std::io::Error::other("injected connection drop"))
        });
        Body::from_stream(reader.chain(boom))
    } else {
        Body::from_stream(reader)
    };

    let mut resp = base(status).header(header::CONTENT_LENGTH, len);
    if let Some(ct) = &st.opts.content_type {
        resp = resp.header(header::CONTENT_TYPE, ct);
    }
    if st.opts.support_range {
        resp = resp.header(header::ACCEPT_RANGES, "bytes");
    }
    if status == StatusCode::PARTIAL_CONTENT {
        resp = resp.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    resp.body(body).unwrap()
}

#[cfg(test)]
mod tests {
    use super::parse_range;

    #[test]
    fn range_header_parsing() {
        assert_eq!(parse_range("bytes=0-0", 10), Some((0, 0)));
        assert_eq!(parse_range("bytes=2-", 10), Some((2, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=5-500", 10), Some((5, 9)));
        assert_eq!(parse_range("bytes=10-12", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }
}
