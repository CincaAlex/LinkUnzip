//! The HTTP side: probe the server for Range support, then fetch byte ranges.

use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use reqwest::blocking::{Client, Response};
use reqwest::header::{
    ACCEPT_ENCODING, AUTHORIZATION, CONTENT_RANGE, CONTENT_TYPE, COOKIE, ETAG, HeaderMap,
    HeaderName, HeaderValue, LAST_MODIFIED, RANGE,
};
use reqwest::{StatusCode, Url};

use crate::error::{Coded, ErrorCode, Failure, RetryPolicy, retry};

/// How much of a `200 OK` answer to the probe is read to tell a web page from the file.
const SNIFF_BYTES: u64 = 4096;

/// Query parameters (compared case-insensitively) that mark a signed link that expires: S3,
/// CloudFront, Azure SAS, Google Cloud Storage and the usual home-made `token`/`expires`.
const SIGNATURE_PARAMS: [&str; 13] = [
    "x-amz-signature",
    "x-amz-expires",
    "x-amz-credential",
    "expires",
    "signature",
    "sig",
    "se",
    "sp",
    "x-goog-signature",
    "x-goog-expires",
    "token",
    "policy",
    "key-pair-id",
];

/// Extra request headers (name, value), e.g. the browser's `Cookie` and `Referer` for a download
/// that needs a login. Sent with every request to the archive URL; reqwest drops `Cookie` and
/// `Authorization` again if the server redirects to a different host.
pub type Headers = Vec<(String, String)>;

/// The server answered the Range probe with a plain `200 OK`: it can only send the file from the
/// start. Kept as its own type so callers can tell this apart from other failures.
#[derive(Debug)]
pub struct NoRangeSupport;

impl std::fmt::Display for NoRangeSupport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "this server does not support HTTP Range requests (it answered 200 OK with the whole file instead of 206 Partial Content). LinkUnzip needs Range support to read the ZIP index without downloading the file"
        )
    }
}

impl std::error::Error for NoRangeSupport {}

/// A remote ZIP file that supports Range requests.
pub struct Source {
    client: Client,
    url: String,
    /// Total size of the archive in bytes (from the `Content-Range` of the probe).
    pub size: u64,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub retry: RetryPolicy,
    /// Bytes received by the probe and by [`Source::get_bytes`] (the index reads).
    index_bytes: AtomicU64,
    /// Requests made by the probe and by [`Source::get_bytes`], retries included.
    index_requests: AtomicU64,
}

impl Source {
    /// Probe the server: `Range: bytes=0-0` must give `206 Partial Content` with the total size.
    /// There is deliberately no fallback for servers without Range support.
    pub fn probe(url: &str, retry_policy: RetryPolicy) -> Result<Source> {
        Self::probe_with(url, retry_policy, &[])
    }

    /// Like [`Source::probe`], sending `headers` with every request.
    pub fn probe_with(
        url: &str,
        retry_policy: RetryPolicy,
        headers: &[(String, String)],
    ) -> Result<Source> {
        let client = build_client(url, headers)?;

        let mut resp = send_probe(&client, url, retry_policy)?;
        let status = resp.status();
        match status {
            StatusCode::PARTIAL_CONTENT | StatusCode::OK => {}
            StatusCode::RANGE_NOT_SATISFIABLE => {
                bail!(
                    "the server answered 416 Range Not Satisfiable to a request for the first byte; is the file empty?"
                )
            }
            s => {
                return Err(
                    status_failure(s, url, resp.url(), " to the probe request").into_error()
                );
            }
        }

        // A sign-in page or a "can't scan for viruses" page often comes back as 200 OK (or even
        // 206, from a server that does ranges on everything). Look at the first bytes to tell it
        // from the file; for a 200 that is all we read before dropping the connection.
        let content_type = header_str(resp.headers(), CONTENT_TYPE.as_str());
        let mut sample = Vec::new();
        let _ = (&mut resp).take(SNIFF_BYTES).read_to_end(&mut sample);
        if looks_like_html(content_type.as_deref(), &sample) {
            return Err(Coded::new(
                ErrorCode::HtmlPage,
                format!(
                    "the server answered {status} with a web page ({}) instead of the file",
                    content_type.as_deref().unwrap_or("no Content-Type")
                ),
            )
            .with_status(status.as_u16())
            .into());
        }
        if status == StatusCode::OK {
            return Err(NoRangeSupport.into());
        }

        let content_range =
            header_str(resp.headers(), CONTENT_RANGE.as_str()).ok_or_else(|| {
                anyhow!(
                    "the server sent 206 but no Content-Range header, so the file size is unknown"
                )
            })?;
        let size = match parse_content_range(&content_range) {
            Some((_, _, Some(total))) => total,
            _ => bail!("could not read the total file size from Content-Range: {content_range:?}"),
        };
        Ok(Source {
            client,
            url: url.to_string(),
            size,
            etag: header_str(resp.headers(), ETAG.as_str()),
            last_modified: header_str(resp.headers(), LAST_MODIFIED.as_str()),
            retry: retry_policy,
            index_bytes: AtomicU64::new(sample.len() as u64),
            index_requests: AtomicU64::new(1),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Bytes downloaded so far to probe the server and read the index.
    pub fn index_bytes(&self) -> u64 {
        self.index_bytes.load(Ordering::Relaxed)
    }

    /// Requests made so far to probe the server and read the index (retries included).
    pub fn index_requests(&self) -> u64 {
        self.index_requests.load(Ordering::Relaxed)
    }

    /// Start a streaming GET for `bytes=start-end` (inclusive). The returned response is a
    /// `Read`; the caller decides how much to consume. Validates status, `Content-Range` and ETag.
    pub fn open_range(&self, start: u64, end: u64) -> Result<Response, Failure> {
        let resp = self
            .client
            .get(&self.url)
            .header(RANGE, format!("bytes={start}-{end}"))
            .header(ACCEPT_ENCODING, "identity") // never let a server compress the byte stream
            .send()
            .map_err(classify_request_error)?;
        self.check_range_response(&resp, start)?;
        Ok(resp)
    }

    /// Fetch `bytes=start-end` (inclusive) into memory, retrying transient failures. Used for the
    /// index; what it downloads is counted in [`Source::index_bytes`].
    pub fn get_bytes(&self, start: u64, end: u64) -> Result<Vec<u8>> {
        let len = end - start + 1;
        let bytes = retry(self.retry, || {
            self.index_requests.fetch_add(1, Ordering::Relaxed);
            let resp = self.open_range(start, end)?;
            let mut buf = Vec::with_capacity(len.min(64 << 20) as usize);
            resp.take(len)
                .read_to_end(&mut buf)
                .map_err(Failure::transient)?;
            if buf.len() as u64 != len {
                return Err(Failure::transient(anyhow!(
                    "the connection ended early: got {} of {len} bytes",
                    buf.len()
                )));
            }
            Ok(buf)
        })
        .with_context(|| format!("fetching bytes {start}-{end} of {}", self.url))?;
        self.index_bytes.fetch_add(len, Ordering::Relaxed);
        Ok(bytes)
    }

    fn check_range_response(&self, resp: &Response, start: u64) -> Result<(), Failure> {
        let status = resp.status();
        match status {
            StatusCode::PARTIAL_CONTENT => {}
            StatusCode::OK => {
                return Err(Failure::fatal(anyhow!(
                    "the server ignored the Range header and answered 200 OK (it stopped supporting ranges, or the file changed)"
                )));
            }
            StatusCode::RANGE_NOT_SATISFIABLE => {
                return Err(Failure::fatal(anyhow!(
                    "416 Range Not Satisfiable: the file on the server changed size"
                )));
            }
            s => return Err(status_failure(s, &self.url, resp.url(), "")),
        }

        // A 206 must say which bytes it carries; make sure they are the ones we asked for, of
        // the same file. (Cheap protection against odd proxies and against the file changing.)
        let cr = header_str(resp.headers(), CONTENT_RANGE.as_str()).ok_or_else(|| {
            Failure::fatal(anyhow!("206 response without a Content-Range header"))
        })?;
        match parse_content_range(&cr) {
            Some((got_start, _, total))
                if got_start == start && total.is_none_or(|t| t == self.size) => {}
            _ => {
                return Err(Failure::fatal(anyhow!(
                    "the server returned a different range than requested (asked for start {start}, size {}; got {cr:?})",
                    self.size
                )));
            }
        }
        if let (Some(old), Some(new)) = (&self.etag, header_str(resp.headers(), ETAG.as_str())) {
            if normalize_etag(old) != normalize_etag(&new) {
                return Err(Failure::fatal(anyhow!(
                    "the file changed on the server during the download (ETag changed)"
                )));
            }
        } else if let (None, Some(old), Some(new)) = (
            &self.etag,
            &self.last_modified,
            header_str(resp.headers(), LAST_MODIFIED.as_str()),
        ) && *old != new
        {
            return Err(Failure::fatal(anyhow!(
                "the file changed on the server during the download (Last-Modified changed)"
            )));
        }
        Ok(())
    }
}

/// Validate the URL and build an HTTP client that sends `headers` with every request.
fn build_client(url: &str, headers: &[(String, String)]) -> Result<Client> {
    let parsed = Url::parse(url).map_err(|e| {
        Coded::new(
            ErrorCode::BadRequest,
            format!("not a valid URL: {url}: {e}"),
        )
    })?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(Coded::new(
            ErrorCode::BadRequest,
            format!(
                "only http:// and https:// URLs are supported (got {}://)",
                parsed.scheme()
            ),
        )
        .into());
    }
    Client::builder()
        .user_agent(concat!("linkunzip/", env!("CARGO_PKG_VERSION")))
        // After `user_agent`, so a caller-supplied User-Agent wins.
        .default_headers(build_header_map(headers)?)
        .connect_timeout(Duration::from_secs(15))
        // For streamed bodies this applies to each *read*, not to the whole transfer, so a
        // multi-GB range is fine as long as bytes keep flowing.
        .timeout(Duration::from_secs(60))
        .build()
        .context("could not create the HTTP client")
}

/// A plain GET of the whole file, for servers that cannot do Range requests (`--stream`).
pub struct Sequential {
    client: Client,
    url: String,
    pub retry: RetryPolicy,
}

/// One open download of the whole file.
pub struct Download {
    pub response: Response,
    /// Size of the file if the server said (it does not for on-the-fly archives).
    pub length: Option<u64>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub content_type: Option<String>,
}

impl Sequential {
    pub fn new(url: &str, retry: RetryPolicy, headers: &[(String, String)]) -> Result<Sequential> {
        Ok(Sequential {
            client: build_client(url, headers)?,
            url: url.to_string(),
            retry,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// Start downloading from the first byte.
    pub fn open(&self) -> Result<Download, Failure> {
        let resp = self
            .client
            .get(&self.url)
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(classify_request_error)?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_failure(status, &self.url, resp.url(), ""));
        }
        Ok(Download {
            length: resp.content_length(),
            etag: header_str(resp.headers(), ETAG.as_str()),
            last_modified: header_str(resp.headers(), LAST_MODIFIED.as_str()),
            content_type: header_str(resp.headers(), "content-type"),
            response: resp,
        })
    }
}

fn build_header_map(headers: &[(String, String)]) -> Result<HeaderMap> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = HeaderName::from_bytes(name.trim().as_bytes())
            .with_context(|| format!("not a valid header name: {name:?}"))?;
        let mut value = HeaderValue::from_str(value)
            .with_context(|| format!("not a valid value for the {name} header"))?;
        if name == COOKIE || name == AUTHORIZATION {
            value.set_sensitive(true); // keep it out of debug output
        }
        map.insert(name, value);
    }
    Ok(map)
}

/// Send the probe request, retrying connection-level failures.
fn send_probe(client: &Client, url: &str, policy: RetryPolicy) -> Result<Response> {
    retry(policy, || {
        client
            .get(url)
            .header(RANGE, "bytes=0-0")
            .header(ACCEPT_ENCODING, "identity")
            .send()
            .map_err(classify_request_error)
    })
    .with_context(|| format!("could not reach {url}"))
}

/// An answer other than the one we wanted, as a coded failure. 5xx, 408 and 429 are worth
/// retrying; the rest are not. `requested` is the URL we asked for, `answered` the one that
/// answered (after redirects): either carrying a signature means a 403/400/410 is an expired link.
fn status_failure(status: StatusCode, requested: &str, answered: &Url, what: &str) -> Failure {
    let signed = Url::parse(requested).is_ok_and(|u| is_signed_url(&u)) || is_signed_url(answered);
    let code = match status.as_u16() {
        401 => ErrorCode::NeedsLogin,
        403 if signed => ErrorCode::LinkExpired,
        403 => ErrorCode::NeedsLogin,
        400 | 410 if signed => ErrorCode::LinkExpired,
        404 | 410 => ErrorCode::NotFound,
        408 | 429 | 500..=599 => ErrorCode::ServerError,
        _ => ErrorCode::Failed,
    };
    let error = Coded::new(code, format!("the server answered {status}{what}"))
        .with_status(status.as_u16());
    if code == ErrorCode::ServerError {
        Failure::transient(error)
    } else {
        Failure::fatal(error)
    }
}

/// Does the URL carry a signature or expiry parameter (a link that stops working after a while)?
pub fn is_signed_url(url: &Url) -> bool {
    url.query_pairs().any(|(name, _)| {
        SIGNATURE_PARAMS
            .iter()
            .any(|p| name.eq_ignore_ascii_case(p))
    })
}

/// The host name of `url` (never its path or query, which can hold access tokens).
pub fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok()?.host_str().map(str::to_string)
}

/// Is this answer a web page rather than the file? The first non-blank byte decides when there is
/// one (`<` = markup, `P` = the "PK" of a zip, whatever the Content-Type claims); otherwise the
/// Content-Type does.
pub(crate) fn looks_like_html(content_type: Option<&str>, sample: &[u8]) -> bool {
    let body = sample.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(sample);
    match body.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'<') => true,
        Some(b'P') => false,
        _ => content_type.is_some_and(|ct| {
            let ct = ct.trim().to_ascii_lowercase();
            ct.starts_with("text/html") || ct.starts_with("application/xhtml+xml")
        }),
    }
}

/// Connection problems and timeouts are worth retrying; a malformed request or redirect loop is not.
fn classify_request_error(e: reqwest::Error) -> Failure {
    if e.is_builder() || e.is_redirect() {
        Failure::fatal(e)
    } else {
        Failure::transient(e)
    }
}

fn header_str(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
}

fn normalize_etag(etag: &str) -> &str {
    etag.trim().trim_start_matches("W/")
}

/// Parse `bytes 0-0/12345` into (start, end, total). `total` is `None` for `bytes 0-0/*`.
pub fn parse_content_range(value: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = value.trim().strip_prefix("bytes")?.trim_start();
    let (range, total) = rest.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse().ok()?),
    };
    Some((start.trim().parse().ok()?, end.trim().parse().ok()?, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_parsing() {
        assert_eq!(
            parse_content_range("bytes 0-0/12345"),
            Some((0, 0, Some(12345)))
        );
        assert_eq!(
            parse_content_range("bytes 100-199/5000000000"),
            Some((100, 199, Some(5_000_000_000)))
        );
        assert_eq!(parse_content_range("bytes 0-9/*"), Some((0, 9, None)));
        assert_eq!(
            parse_content_range("  bytes   5-6 / 7 "),
            Some((5, 6, Some(7)))
        );
        assert_eq!(parse_content_range("bytes */100"), None); // the 416 form
        assert_eq!(parse_content_range("items 0-1/2"), None);
        assert_eq!(parse_content_range("bytes 0-0"), None);
    }

    #[test]
    fn etag_normalisation() {
        assert_eq!(normalize_etag("W/\"abc\""), "\"abc\"");
        assert_eq!(normalize_etag("\"abc\""), "\"abc\"");
    }

    #[test]
    fn signed_urls_are_recognised_by_their_query_parameters() {
        for url in [
            "https://b.s3.amazonaws.com/a.zip?X-Amz-Signature=abc&X-Amz-Expires=60",
            "https://x.blob.core.windows.net/c/a.zip?sp=r&se=2026-01-01&sig=abc",
            "https://d1.cloudfront.net/a.zip?Expires=1&Signature=x&Key-Pair-Id=K",
            "https://storage.googleapis.com/b/a.zip?X-Goog-Signature=1",
            "https://example.com/a.zip?token=abc",
        ] {
            assert!(is_signed_url(&Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "https://example.com/a.zip",
            "https://example.com/a.zip?download=1",
            "https://example.com/signature/a.zip",
        ] {
            assert!(!is_signed_url(&Url::parse(url).unwrap()), "{url}");
        }
    }

    #[test]
    fn statuses_map_to_codes() {
        let plain = Url::parse("https://example.com/a.zip").unwrap();
        let signed = Url::parse("https://example.com/a.zip?X-Amz-Signature=1").unwrap();
        let code = |status: u16, url: &Url| match status_failure(
            StatusCode::from_u16(status).unwrap(),
            url.as_str(),
            url,
            "",
        ) {
            Failure::Transient(e) => (e.downcast_ref::<Coded>().unwrap().code, true),
            Failure::Fatal(e) => (e.downcast_ref::<Coded>().unwrap().code, false),
        };
        assert_eq!(code(401, &plain), (ErrorCode::NeedsLogin, false));
        assert_eq!(code(403, &plain), (ErrorCode::NeedsLogin, false));
        assert_eq!(code(403, &signed), (ErrorCode::LinkExpired, false));
        assert_eq!(code(400, &signed), (ErrorCode::LinkExpired, false));
        assert_eq!(code(400, &plain), (ErrorCode::Failed, false));
        assert_eq!(code(404, &plain), (ErrorCode::NotFound, false));
        assert_eq!(code(410, &plain), (ErrorCode::NotFound, false));
        assert_eq!(code(410, &signed), (ErrorCode::LinkExpired, false));
        assert_eq!(code(503, &plain), (ErrorCode::ServerError, true));
        assert_eq!(code(429, &plain), (ErrorCode::ServerError, true));
        // A redirect to an expired signed URL counts as signed too.
        let e = status_failure(StatusCode::FORBIDDEN, plain.as_str(), &signed, "").into_error();
        assert_eq!(
            e.downcast_ref::<Coded>().unwrap().code,
            ErrorCode::LinkExpired
        );
    }

    #[test]
    fn web_pages_are_told_apart_from_files() {
        assert!(looks_like_html(Some("text/html; charset=utf-8"), b""));
        assert!(looks_like_html(None, b"  \n<!DOCTYPE html>"));
        assert!(looks_like_html(None, b"\xEF\xBB\xBF<html>"));
        assert!(looks_like_html(Some("application/zip"), b"<html>"));
        assert!(
            !looks_like_html(Some("text/html"), b"PK\x03\x04"),
            "a zip served with the wrong type"
        );
        assert!(!looks_like_html(Some("application/zip"), b"PK"));
        assert!(!looks_like_html(None, b"%PDF"));
        assert!(!looks_like_html(Some("application/octet-stream"), b""));
    }

    #[test]
    fn host_is_only_the_host_name() {
        assert_eq!(
            host_of("https://user:pw@files.example.com:8443/a/b.zip?token=x").as_deref(),
            Some("files.example.com")
        );
        assert_eq!(host_of("not a url"), None);
    }

    #[test]
    fn rejects_non_http_urls() {
        let err = Source::probe("ftp://example.com/a.zip", RetryPolicy::default())
            .err()
            .unwrap()
            .to_string();
        assert!(err.contains("http"), "{err}");
        assert!(Source::probe("not a url", RetryPolicy::default()).is_err());
    }
}
