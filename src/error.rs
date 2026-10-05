//! Error classification: is it worth trying again, and what should the person be told?
//!
//! Every failure that reaches the browser carries a [`ErrorCode`]
//! so the extension can offer the right next step. The code travels inside the `anyhow` error as a
//! [`Coded`] value, created where the failure is noticed; [`describe`] finds it again and turns it
//! into a plain-English message, the technical detail and (for the command line) a hint.

use std::fmt;
use std::io;
use std::time::Duration;

use crate::fmt::human_bytes;

/// What went wrong, in terms the browser extension can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// The server answered 200 OK with the zip: it cannot send parts of the file.
    NoRange,
    /// The link answers with a web page (a sign-in page, a "can't scan for viruses" page, ...).
    HtmlPage,
    /// 401, or 403 on a link without a signature.
    NeedsLogin,
    /// 403/400/410 on a signed link (S3, CloudFront, Azure, Google Cloud...): it has expired.
    LinkExpired,
    /// 404 / 410.
    NotFound,
    /// There is no end-of-central-directory record: not a zip.
    NotZip,
    /// 5xx (after the retries the request type allows).
    ServerError,
    /// DNS, connection, TLS, timeouts, connections that keep dropping.
    Network,
    /// The free-space check failed, or the disk filled up while writing.
    DiskFull,
    /// Access denied, path not found or name too long while creating folders and files.
    FolderNotWritable,
    /// The selection holds files LinkUnzip cannot extract (encrypted, unusual compression).
    UnsupportedEntries,
    /// `list`/`search`/`measure` for an archive the helper no longer has in memory.
    UnknownJob,
    /// Not available on this system (the folder picker outside Windows).
    Unsupported,
    /// The request itself is wrong (not JSON, a header that may not be forwarded, a relative
    /// folder, a bad pattern).
    BadRequest,
    /// A bug (a panic).
    Internal,
    /// Anything else: a corrupt or hostile archive, a CRC mismatch, the file changed on the server.
    Failed,
}

impl ErrorCode {
    /// The name used in the `error` reply.
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NoRange => "no_range",
            ErrorCode::HtmlPage => "html_page",
            ErrorCode::NeedsLogin => "needs_login",
            ErrorCode::LinkExpired => "link_expired",
            ErrorCode::NotFound => "not_found",
            ErrorCode::NotZip => "not_zip",
            ErrorCode::ServerError => "server_error",
            ErrorCode::Network => "network",
            ErrorCode::DiskFull => "disk_full",
            ErrorCode::FolderNotWritable => "folder_not_writable",
            ErrorCode::UnsupportedEntries => "unsupported_entries",
            ErrorCode::UnknownJob => "unknown_job",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::BadRequest => "bad_request",
            ErrorCode::Internal => "internal",
            ErrorCode::Failed => "failed",
        }
    }

    /// What to try next, for the command line.
    pub fn cli_hint(self) -> Option<&'static str> {
        Some(match self {
            ErrorCode::NoRange => {
                "this server can only send the whole file from the start. `linkunzip extract <URL> -o <DIR> --stream` extracts it in a single pass instead (one connection, no preview)."
            }
            ErrorCode::HtmlPage => {
                "open the link in a browser: the real download link is on that page. Sign-in pages and \"can't scan this file for viruses\" pages look like this."
            }
            ErrorCode::NeedsLogin => {
                "the command line cannot use your browser's login. Use the LinkUnzip browser extension (\"Use my login\"), or a link that works without signing in."
            }
            ErrorCode::LinkExpired => "copy a fresh link from the page and run the command again.",
            ErrorCode::NotFound => "check the link; the file may have been moved or deleted.",
            ErrorCode::NotZip => "download it normally: LinkUnzip only extracts .zip files.",
            ErrorCode::ServerError => "run the command again in a moment.",
            ErrorCode::Network => "check the internet connection, then run the command again.",
            ErrorCode::DiskFull => {
                "free some space, extract to another drive with -o, select fewer files with --include, or pass --force to try anyway."
            }
            ErrorCode::FolderNotWritable => "choose another folder with -o (or a shorter path).",
            ErrorCode::UnsupportedEntries => {
                "select only the files you want with --include; the others are skipped without being downloaded."
            }
            _ => return None,
        })
    }
}

/// An error that knows its [`ErrorCode`]. Create it where the failure is noticed and let it travel
/// through `anyhow`, with any context added on the way; [`describe`] finds it again.
#[derive(Debug)]
pub struct Coded {
    pub code: ErrorCode,
    /// The HTTP status that caused it, if any.
    pub http_status: Option<u16>,
    /// A plain-English sentence for this particular failure; `None` = the code's usual sentence.
    pub message: Option<String>,
    /// The technical text. This is what `Display` shows, so `{e:#}` reads as it always did.
    pub detail: String,
}

impl Coded {
    pub fn new(code: ErrorCode, detail: impl Into<String>) -> Self {
        Coded {
            code,
            http_status: None,
            message: None,
            detail: detail.into(),
        }
    }

    pub fn with_status(mut self, status: u16) -> Self {
        self.http_status = Some(status);
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }
}

impl fmt::Display for Coded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.detail)
    }
}

impl std::error::Error for Coded {}

/// The code of a file-system error that people can do something about: a full disk, or a folder
/// LinkUnzip may not write to (access denied, path not found, name too long, a file standing
/// where a folder has to be created).
pub fn io_code(e: &io::Error) -> Option<ErrorCode> {
    // ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED
    let windows_full = cfg!(windows) && matches!(e.raw_os_error(), Some(39 | 112 | 1295));
    // ERROR_PATH_NOT_FOUND, ERROR_ACCESS_DENIED, ERROR_INVALID_NAME, ERROR_ALREADY_EXISTS,
    // ERROR_FILENAME_EXCED_RANGE
    let windows_denied = cfg!(windows) && matches!(e.raw_os_error(), Some(3 | 5 | 123 | 183 | 206));
    if e.kind() == io::ErrorKind::StorageFull || windows_full {
        Some(ErrorCode::DiskFull)
    } else if matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied
            | io::ErrorKind::ReadOnlyFilesystem
            | io::ErrorKind::AlreadyExists
            | io::ErrorKind::NotADirectory
    ) || windows_denied
    {
        Some(ErrorCode::FolderNotWritable)
    } else {
        None
    }
}

/// `what: <e>`, keeping `e` inside the error so [`describe`] can tell a full disk or a read-only
/// folder from other failures.
pub fn io_failure(e: io::Error, what: impl fmt::Display + Send + Sync + 'static) -> anyhow::Error {
    anyhow::Error::new(e).context(what)
}

/// Context for a failure that kept coming back until the retries ran out. Unless something more
/// specific is already known (a 5xx answer is a `server_error`), the network is to blame.
pub fn gave_up(e: anyhow::Error, text: String) -> anyhow::Error {
    if e.downcast_ref::<Coded>().is_some() {
        e.context(text)
    } else {
        e.context(Coded::new(ErrorCode::Network, text))
    }
}

/// A failure, ready to show to a person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Described {
    pub code: ErrorCode,
    /// Plain English.
    pub message: String,
    /// The technical chain of causes (`{e:#}`).
    pub detail: String,
    pub http_status: Option<u16>,
}

/// Classify `e` and word it for people. `host` is the archive's host name, used in messages such
/// as "Can't reach example.com".
pub fn describe(e: &anyhow::Error, host: Option<&str>) -> Described {
    let detail = format!("{e:#}");
    let coded = e.downcast_ref::<Coded>();
    let code = if let Some(c) = coded {
        c.code
    } else if e.downcast_ref::<crate::http::NoRangeSupport>().is_some() {
        ErrorCode::NoRange
    } else if let Some(code) = e.downcast_ref::<io::Error>().and_then(io_code) {
        code
    } else if e
        .downcast_ref::<reqwest::Error>()
        .is_some_and(|r| r.is_connect() || r.is_timeout())
    {
        ErrorCode::Network
    } else {
        ErrorCode::Failed
    };
    let http_status = coded.and_then(|c| c.http_status);
    let message = match coded.and_then(|c| c.message.clone()) {
        Some(m) => m,
        None => default_message(code, host, http_status, &detail),
    };
    Described {
        code,
        message,
        detail,
        http_status,
    }
}

/// The usual sentence for each code.
fn default_message(
    code: ErrorCode,
    host: Option<&str>,
    status: Option<u16>,
    detail: &str,
) -> String {
    let server = host.unwrap_or("The server");
    let status_text = status
        .map(|s| {
            let reason = reqwest::StatusCode::from_u16(s)
                .ok()
                .and_then(|c| c.canonical_reason());
            match reason {
                Some(r) => format!(" (HTTP {s} {r})"),
                None => format!(" (HTTP {s})"),
            }
        })
        .unwrap_or_default();
    match code {
        ErrorCode::NoRange => format!(
            "{server} can only send the whole file from the start, so LinkUnzip cannot read the list of files first. It can still extract it in a single pass."
        ),
        ErrorCode::HtmlPage => "This link opens a web page, not the ZIP file.".to_string(),
        ErrorCode::NeedsLogin => format!(
            "{server} wants you to be signed in before it sends this file{status_text}."
        ),
        ErrorCode::LinkExpired => {
            "This download link has expired. Get a fresh link from the page you found it on."
                .to_string()
        }
        ErrorCode::NotFound => format!("The file is gone from the server{status_text}."),
        ErrorCode::NotZip => "This file isn't a ZIP archive.".to_string(),
        ErrorCode::ServerError => format!(
            "{server} had a problem sending the file{status_text}. Try again in a moment."
        ),
        ErrorCode::Network => match host {
            Some(h) => format!("Can't reach {h}. Check the internet connection and try again."),
            None => "Can't reach the server. Check the internet connection and try again."
                .to_string(),
        },
        ErrorCode::DiskFull => "There is not enough free space on the disk.".to_string(),
        ErrorCode::FolderNotWritable => {
            "LinkUnzip can't write to this folder (access denied, or the path is too long). Choose another folder."
                .to_string()
        }
        ErrorCode::UnsupportedEntries => {
            "Some of the selected files can't be extracted by LinkUnzip.".to_string()
        }
        ErrorCode::UnknownJob => {
            "LinkUnzip no longer has this archive's file list (the helper was restarted). Open the link again."
                .to_string()
        }
        ErrorCode::Unsupported => "This is not available on this system.".to_string(),
        ErrorCode::Internal => {
            "LinkUnzip hit an internal error (a bug); nothing more was written.".to_string()
        }
        ErrorCode::BadRequest | ErrorCode::Failed => detail.to_string(),
    }
}

/// The plain-English message for a full disk, with both numbers.
pub fn disk_full_message(needed: u64, free: u64) -> String {
    format!(
        "Not enough free space: the selected files need {} but only {} is free.",
        human_bytes(needed),
        human_bytes(free)
    )
}

/// A failed operation, tagged with whether a retry could help.
#[derive(Debug)]
pub enum Failure {
    /// Network hiccup, timeout, 5xx: try again (with a new Range request).
    Transient(anyhow::Error),
    /// Bad data, 4xx, disk full, hostile archive: retrying would only repeat the failure.
    Fatal(anyhow::Error),
}

impl Failure {
    pub fn transient(e: impl Into<anyhow::Error>) -> Self {
        Failure::Transient(e.into())
    }

    pub fn fatal(e: impl Into<anyhow::Error>) -> Self {
        Failure::Fatal(e.into())
    }

    pub fn is_transient(&self) -> bool {
        matches!(self, Failure::Transient(_))
    }

    pub fn into_error(self) -> anyhow::Error {
        match self {
            Failure::Transient(e) | Failure::Fatal(e) => e,
        }
    }

    /// Add context while keeping the classification.
    pub fn context(self, msg: impl fmt::Display + Send + Sync + 'static) -> Self {
        match self {
            Failure::Transient(e) => Failure::Transient(e.context(msg)),
            Failure::Fatal(e) => Failure::Fatal(e.context(msg)),
        }
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Failure::Transient(e) | Failure::Fatal(e) => write!(f, "{e:#}"),
        }
    }
}

/// How hard to try before giving up: exponential backoff, `max_attempts` tries in total.
#[derive(Debug, Clone, Copy)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(500),
        }
    }
}

impl RetryPolicy {
    /// Delay to wait after failed attempt number `attempt` (1-based): base, 2x, 4x, ... capped at 30 s.
    pub fn delay_after(&self, attempt: u32) -> Duration {
        let factor = 1u32 << (attempt.saturating_sub(1)).min(10);
        (self.base_delay * factor).min(Duration::from_secs(30))
    }
}

/// Run `op` until it succeeds, fails fatally, or the policy's attempts are used up.
pub fn retry<T>(
    policy: RetryPolicy,
    mut op: impl FnMut() -> Result<T, Failure>,
) -> anyhow::Result<T> {
    let mut attempt = 1;
    loop {
        match op() {
            Ok(v) => return Ok(v),
            Err(Failure::Fatal(e)) => return Err(e),
            Err(Failure::Transient(e)) if attempt >= policy.max_attempts => {
                return Err(gave_up(e, format!("giving up after {attempt} attempts")));
            }
            Err(Failure::Transient(_)) => {
                std::thread::sleep(policy.delay_after(attempt));
                attempt += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_retries_transient_but_not_fatal_failures() {
        let fast = RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
        };

        let mut calls = 0;
        let ok = retry(fast, || {
            calls += 1;
            if calls < 3 {
                Err(Failure::transient(anyhow::anyhow!("flaky")))
            } else {
                Ok(calls)
            }
        });
        assert_eq!(ok.unwrap(), 3);

        let mut calls = 0;
        let err = retry(fast, || -> Result<(), Failure> {
            calls += 1;
            Err(Failure::transient(anyhow::anyhow!("down")))
        })
        .unwrap_err();
        assert_eq!(calls, 3);
        assert!(
            format!("{err:#}").contains("giving up after 3 attempts"),
            "{err:#}"
        );

        let mut calls = 0;
        let _ = retry(fast, || -> Result<(), Failure> {
            calls += 1;
            Err(Failure::fatal(anyhow::anyhow!("404")))
        });
        assert_eq!(calls, 1);
    }

    #[test]
    fn disk_errors_are_classified() {
        let kind = |k| io_code(&io::Error::from(k));
        assert_eq!(kind(io::ErrorKind::StorageFull), Some(ErrorCode::DiskFull));
        assert_eq!(
            kind(io::ErrorKind::PermissionDenied),
            Some(ErrorCode::FolderNotWritable)
        );
        assert_eq!(kind(io::ErrorKind::ConnectionReset), None);
        #[cfg(windows)]
        {
            let os = |n| io_code(&io::Error::from_raw_os_error(n));
            assert_eq!(os(112), Some(ErrorCode::DiskFull));
            for n in [3, 5, 206] {
                assert_eq!(os(n), Some(ErrorCode::FolderNotWritable), "os error {n}");
            }
            assert_eq!(os(2), None, "file not found is not about writing");
        }
    }

    #[test]
    fn describe_finds_the_code_under_context_and_words_it() {
        let e = anyhow::Error::from(Coded::new(ErrorCode::NotFound, "404").with_status(404))
            .context("could not reach the file");
        let d = describe(&e, Some("example.com"));
        assert_eq!(d.code, ErrorCode::NotFound);
        assert_eq!(d.http_status, Some(404));
        assert_eq!(
            d.message,
            "The file is gone from the server (HTTP 404 Not Found)."
        );
        assert_eq!(d.detail, "could not reach the file: 404");

        // An io::Error kept inside the chain is enough.
        let e = io_failure(
            io::Error::from(io::ErrorKind::StorageFull),
            "writing to disk failed",
        );
        assert_eq!(describe(&e, None).code, ErrorCode::DiskFull);

        // Retries that ran out without anything more specific: the network.
        let e = gave_up(anyhow::anyhow!("connection reset"), "giving up".into());
        let d = describe(&e, Some("example.com"));
        assert_eq!(d.code, ErrorCode::Network);
        assert!(d.message.contains("Can't reach example.com"), "{d:?}");
        // ... but a 5xx stays a server error.
        let e = gave_up(
            Coded::new(ErrorCode::ServerError, "503")
                .with_status(503)
                .into(),
            "giving up".into(),
        );
        assert_eq!(describe(&e, None).code, ErrorCode::ServerError);

        // Anything else keeps its technical text as the message.
        let d = describe(&anyhow::anyhow!("CRC-32 mismatch"), None);
        assert_eq!(
            (d.code, d.message.as_str()),
            (ErrorCode::Failed, "CRC-32 mismatch")
        );
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        let p = RetryPolicy::default();
        assert_eq!(p.delay_after(1), Duration::from_millis(500));
        assert_eq!(p.delay_after(2), Duration::from_secs(1));
        assert_eq!(p.delay_after(3), Duration::from_secs(2));
        assert_eq!(p.delay_after(4), Duration::from_secs(4));
        assert_eq!(p.delay_after(20), Duration::from_secs(30));
    }

    #[test]
    fn context_keeps_the_classification() {
        let f = Failure::transient(anyhow::anyhow!("boom")).context("while reading");
        assert!(f.is_transient());
        assert_eq!(f.to_string(), "while reading: boom");
        assert!(
            !Failure::fatal(anyhow::anyhow!("x"))
                .context("y")
                .is_transient()
        );
    }
}
