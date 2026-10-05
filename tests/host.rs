//! The browser extension's native-messaging host, tested the way Chrome uses it: the real
//! `linkunzip` binary as a child process, 4-byte-length-prefixed JSON on stdin/stdout.

mod common;

use std::io::Write;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use common::server::{ServerOptions, TestServer};
use common::{assert_tree_matches, fixture};
use linkunzip::host::{read_frame, write_frame};
use serde_json::{Value, json};

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    replies: Receiver<Value>,
}

impl Host {
    /// Start the host the way Chrome does: first argument is the extension's origin.
    fn start() -> Host {
        let mut child = Command::new(env!("CARGO_BIN_EXE_linkunzip"))
            .arg("chrome-extension://mgmhodmhlmedihmpiofacdffdekaehhk/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("could not start the host");
        let mut stdout = child.stdout.take().unwrap();
        let (tx, replies) = channel();
        std::thread::spawn(move || {
            while let Ok(Some(frame)) = read_frame(&mut stdout) {
                let value: Value = serde_json::from_slice(&frame).expect("host sent invalid JSON");
                if tx.send(value).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        Host {
            child,
            stdin,
            replies,
        }
    }

    fn send(&mut self, value: Value) {
        write_frame(self.stdin.as_mut().unwrap(), &value).unwrap();
    }

    /// Everything the host says until `stop` returns true for a reply (that reply is included).
    fn collect_until(&mut self, stop: impl Fn(&Value) -> bool, secs: u64) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(secs);
        let mut seen = Vec::new();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.replies.recv_timeout(left) {
                Ok(v) => {
                    let done = stop(&v);
                    seen.push(v);
                    if done {
                        return seen;
                    }
                }
                Err(RecvTimeoutError::Timeout) => panic!("timed out; saw {seen:#?}"),
                Err(RecvTimeoutError::Disconnected) => panic!("host exited; saw {seen:#?}"),
            }
        }
    }

    fn next_of(&mut self, kind: &'static str) -> Value {
        self.collect_until(move |v| v["type"] == kind, 30)
            .pop()
            .unwrap()
    }

    /// Close stdin (as Chrome does when the extension disconnects) and wait for the process.
    fn finish(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(
                Instant::now() < deadline,
                "the host did not exit after stdin closed"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

fn is_final(v: &Value) -> bool {
    matches!(v["type"].as_str(), Some("done" | "error" | "cancelled"))
}

#[test]
fn hello_inspect_and_extract_over_the_wire() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let url = server.url_for(&fx.zip_name);
    let mut host = Host::start();

    host.send(json!({"type": "hello"}));
    let hello = host.next_of("hello");
    assert_eq!(hello["version"], env!("CARGO_PKG_VERSION"));
    assert!(
        hello["downloads_dir"]
            .as_str()
            .is_some_and(|d| !d.is_empty())
    );
    // Protocol 2: the extension turns its new features on from exactly these names.
    assert_eq!(hello["protocol"], 2);
    let features: Vec<&str> = hello["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    for f in [
        "list",
        "search",
        "measure",
        "select",
        "resume",
        "error_codes",
    ] {
        assert!(features.contains(&f), "hello lacks {f}: {features:?}");
    }
    assert_eq!(features.contains(&"pick_folder"), cfg!(windows));

    host.send(json!({"type": "inspect", "id": "i1", "url": url, "output": out.path()}));
    let inspected = host.next_of("inspected");
    assert_eq!(inspected["id"], "i1");
    let report = &inspected["report"];
    assert_eq!(report["files"].as_u64().unwrap() as usize, fx.files.len());
    assert_eq!(report["archive_size"].as_u64().unwrap(), fx.zip_size);
    assert_eq!(
        report["normal_needs"].as_u64().unwrap(),
        fx.zip_size + report["extracted"].as_u64().unwrap()
    );
    assert_eq!(report["linkunzip_needs"], report["extracted"]);
    assert!(report["largest"].as_array().unwrap().len() <= 5);
    assert!(report["index_bytes"].as_u64().unwrap() > 0);
    assert_eq!(
        report["entries_total"].as_u64().unwrap() as usize,
        fx.files.len() + fx.dirs.len()
    );
    assert!(report["dirs_total"].as_u64().unwrap() >= report["dirs"].as_u64().unwrap());

    host.send(json!({"type": "extract", "id": "e1", "url": url, "output": out.path(), "jobs": 2}));
    let seen = host.collect_until(is_final, 60);
    assert_eq!(seen.first().unwrap()["type"], "started");
    let done = seen.last().unwrap();
    assert_eq!(done["type"], "done", "{seen:#?}");
    assert_eq!(done["id"], "e1");
    assert_eq!(done["files"].as_u64().unwrap() as usize, fx.files.len());
    assert_eq!(done["zip_bytes_on_disk"], 0);
    assert_eq!(done["archive_size"].as_u64().unwrap(), fx.zip_size);
    assert_eq!(done["verified_files"], done["files"]);
    let index_bytes = done["index_bytes"].as_u64().unwrap();
    assert!(index_bytes > 0);
    assert_eq!(
        done["downloaded_bytes"].as_u64().unwrap(),
        index_bytes + fx.files.iter().map(|f| f.compressed_size).sum::<u64>(),
        "the index and every file's data"
    );
    assert!(
        done["requests"].as_u64().unwrap() >= 3,
        "probe + tail + data"
    );
    // At least the closing progress snapshot arrives, and it is complete.
    let last_progress = seen
        .iter()
        .rev()
        .find(|v| v["type"] == "progress")
        .expect("a progress reply");
    assert_eq!(last_progress["files_done"], last_progress["total_files"]);

    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
    assert!(host.finish().success());
}

#[test]
fn a_second_extract_skips_what_is_there_unless_resume_is_off() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let url = server.url_for(&fx.zip_name);
    let total_size: u64 = fx.files.iter().map(|f| f.size).sum();
    let mut host = Host::start();

    let mut extract = |id: &str, resume: Option<bool>| {
        let mut request = json!({"type": "extract", "id": id, "url": url, "output": out.path()});
        if let Some(resume) = resume {
            request["resume"] = resume.into();
        }
        host.send(request);
        let done = host.collect_until(is_final, 60).pop().unwrap();
        assert_eq!(done["type"], "done", "{done}");
        done
    };
    let first = extract("1", None);
    assert_eq!(first["skipped_existing"], 0);
    assert_eq!(first["skipped_bytes"], 0);

    let second = extract("2", None); // resume is on by default
    assert_eq!(second["files"], 0, "{second}");
    assert_eq!(
        second["skipped_existing"].as_u64().unwrap() as usize,
        fx.files.len()
    );
    assert_eq!(second["skipped_bytes"].as_u64().unwrap(), total_size);
    assert_eq!(
        second["verified_files"].as_u64().unwrap() as usize,
        fx.files.len()
    );
    assert_eq!(second["downloaded_bytes"], second["index_bytes"]);

    let third = extract("3", Some(false));
    assert_eq!(third["files"].as_u64().unwrap() as usize, fx.files.len());
    assert_eq!(third["skipped_existing"], 0);
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}

#[test]
fn browsing_an_inspected_archive_and_extracting_a_selection() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let url = server.url_for(&fx.zip_name);
    let mut host = Host::start();

    host.send(json!({"type": "list", "id": "i", "dir": ""}));
    assert_eq!(host.next_of("error")["code"], "unknown_job");

    host.send(json!({"type": "inspect", "id": "i", "url": url}));
    let report = host.next_of("inspected")["report"].clone();
    assert!(
        report["root_dirs"]["total"].as_u64().unwrap() > 0,
        "{report}"
    );

    host.send(json!({"type": "list", "id": "i", "dir": "unicode/", "limit": 2}));
    let page = host.next_of("listing");
    assert_eq!(
        (&page["id"], &page["dir"]),
        (&json!("i"), &json!("unicode/"))
    );
    assert!(page["items"].as_array().unwrap().len() <= 2);
    assert!(page["total"].as_u64().unwrap() >= 2, "{page}");

    host.send(json!({"type": "search", "id": "i", "query": "readme"}));
    let found = host.next_of("search_results");
    assert!(found["total"].as_u64().unwrap() >= 1, "{found}");

    // measure says exactly what an extract of the same selection writes.
    let select = json!({"paths": ["unicode/", "stored/"], "exclude": ["unicode/日本語/"]});
    host.send(json!({"type": "measure", "id": "i", "select": select}));
    let measured = host.next_of("measured");
    host.send(
        json!({"type": "extract", "id": "e", "url": url, "output": out.path(), "select": select}),
    );
    let done = host.collect_until(is_final, 60).pop().unwrap();
    assert_eq!(done["type"], "done", "{done}");
    assert_eq!(done["files"], measured["files"]);
    assert_eq!(done["extracted_bytes"], measured["extracted"]);
    let wanted = |n: &str| {
        (n.starts_with("unicode/") && !n.starts_with("unicode/日本語/")) || n.starts_with("stored/")
    };
    assert_tree_matches(out.path(), &fx, wanted, |_| false);

    // Eight newer inspections push the first one out.
    for k in 0..8 {
        host.send(json!({"type": "inspect", "id": format!("n{k}"), "url": url}));
        host.next_of("inspected");
    }
    host.send(json!({"type": "search", "id": "i", "query": "x"}));
    assert_eq!(host.next_of("error")["code"], "unknown_job");
    host.send(json!({"type": "list", "id": "n7", "dir": ""}));
    host.next_of("listing");
}

#[test]
fn include_filter_is_honoured() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let out = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    host.send(json!({
        "type": "extract", "id": "e", "url": server.url_for(&fx.zip_name),
        "output": out.path(), "include": ["unicode/*"],
    }));
    let done = host.collect_until(is_final, 60).pop().unwrap();
    assert_eq!(done["type"], "done", "{done}");
    let expected = fx
        .files
        .iter()
        .filter(|f| f.name.starts_with("unicode/"))
        .count() as u64;
    assert!(expected > 0);
    assert_eq!(done["files"].as_u64().unwrap(), expected);
}

#[test]
fn cancel_stops_the_job_and_leaves_no_part_files() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            chunk_delay_ms: 40,
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    host.send(json!({
        "type": "extract", "id": "slow", "url": server.url_for(&fx.zip_name),
        "output": out.path(), "jobs": 1,
    }));
    // Wait until bytes are really flowing, then cancel.
    host.collect_until(
        |v| v["type"] == "progress" && v["downloaded"].as_u64().unwrap_or(0) > 0,
        30,
    );
    host.send(json!({"type": "cancel", "id": "slow"}));
    let last = host.collect_until(is_final, 30).pop().unwrap();
    assert_eq!(last["type"], "cancelled", "{last}");
    assert_eq!(last["id"], "slow");

    let leftovers: Vec<_> = common::list_files(out.path())
        .into_iter()
        .filter(|f| f.ends_with(".part"))
        .collect();
    assert!(
        leftovers.is_empty(),
        "unfinished files left behind: {leftovers:?}"
    );
    assert!(host.finish().success());
}

#[test]
fn closing_stdin_while_extracting_cleans_up_and_exits() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            chunk_delay_ms: 40,
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    host.send(json!({
        "type": "extract", "id": "x", "url": server.url_for(&fx.zip_name),
        "output": out.path(), "jobs": 1,
    }));
    host.collect_until(
        |v| v["type"] == "progress" && v["downloaded"].as_u64().unwrap_or(0) > 0,
        30,
    );
    // The browser disappears (extension reloaded, Chrome closed): the host must stop by itself.
    assert!(host.finish().success());
    assert!(
        common::list_files(out.path())
            .iter()
            .all(|f| !f.ends_with(".part"))
    );
}

#[test]
fn cookie_is_sent_to_the_server_but_not_across_a_redirect() {
    let fx = fixture("small");
    let target = TestServer::start(&fx.dir, ServerOptions::default());
    let front = TestServer::start(
        &fx.dir,
        ServerOptions {
            redirect_to: Some(target.base_url.clone()),
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    host.send(json!({
        "type": "extract", "id": "c", "url": front.url_for(&fx.zip_name), "output": out.path(),
        "headers": {"Cookie": "session=secret123", "Referer": "https://example.com/page"},
    }));
    let done = host.collect_until(is_final, 60).pop().unwrap();
    assert_eq!(done["type"], "done", "{done}");

    let front_log = front.requests();
    assert!(!front_log.is_empty());
    assert!(
        front_log
            .iter()
            .all(|r| r.cookie.as_deref() == Some("session=secret123")),
        "the first server should receive the cookie on every request: {front_log:?}"
    );
    let target_log = target.requests();
    assert!(
        !target_log.is_empty(),
        "the redirect target was never reached"
    );
    assert!(
        target_log.iter().all(|r| r.cookie.is_none()),
        "the cookie leaked to the host the request was redirected to: {target_log:?}"
    );
}

#[test]
fn bad_requests_get_an_error_and_the_host_keeps_serving() {
    let mut host = Host::start();

    // Not JSON at all (valid framing).
    host.stdin
        .as_mut()
        .unwrap()
        .write_all(&5u32.to_le_bytes())
        .unwrap();
    host.stdin.as_mut().unwrap().write_all(b"nope!").unwrap();
    let err = host.next_of("error");
    assert!(
        err["message"]
            .as_str()
            .unwrap()
            .contains("could not understand")
    );
    assert_eq!(err["code"], "bad_request");

    // A header the extension is not allowed to forward.
    host.send(json!({
        "type": "inspect", "id": "h", "url": "http://127.0.0.1:1/a.zip",
        "headers": {"X-Evil": "1"},
    }));
    let err = host.next_of("error");
    assert_eq!(err["id"], "h");
    assert_eq!(err["code"], "bad_request");
    assert!(err["message"].as_str().unwrap().contains("not allowed"));

    // A relative output folder.
    host.send(json!({"type": "extract", "id": "r", "url": "http://127.0.0.1:1/a.zip", "output": "relative/dir"}));
    let err = host.next_of("error");
    assert_eq!(err["id"], "r");
    assert_eq!(err["code"], "bad_request");
    assert!(err["message"].as_str().unwrap().contains("absolute"));

    // An unknown request type with an id: the id comes back.
    host.send(json!({"type": "teleport", "id": "t"}));
    let err = host.next_of("error");
    assert_eq!(
        (&err["id"], &err["code"]),
        (&json!("t"), &json!("bad_request"))
    );

    // Still alive.
    host.send(json!({"type": "hello"}));
    host.next_of("hello");
    assert!(host.finish().success());
}

#[test]
fn a_server_without_range_support_is_reported_with_its_own_code() {
    let fx = fixture("small");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    let mut host = Host::start();
    host.send(json!({"type": "inspect", "id": "n", "url": server.url_for(&fx.zip_name)}));
    let err = host.next_of("error");
    assert_eq!(err["code"], "no_range", "{err}");
    assert_eq!(err["id"], "n");
}

#[test]
fn every_failure_reaches_the_browser_with_its_code() {
    let fx = fixture("small");
    let pages = tempfile::tempdir().unwrap();
    std::fs::write(
        pages.path().join("login.zip"),
        "<!DOCTYPE html><html><body>Please sign in</body></html>",
    )
    .unwrap();
    std::fs::write(
        pages.path().join("notes.zip"),
        "plain text, not a zip. ".repeat(20),
    )
    .unwrap();
    let status = |code: u16| ServerOptions {
        status: Some(code),
        ..Default::default()
    };
    let signed = "a.zip?X-Amz-Signature=topsecret&X-Amz-Expires=60";
    let cases: Vec<(ServerOptions, &std::path::Path, &str, &str, Option<u16>)> = vec![
        (status(401), pages.path(), "a.zip", "needs_login", Some(401)),
        (status(403), pages.path(), "a.zip", "needs_login", Some(403)),
        (status(403), pages.path(), signed, "link_expired", Some(403)),
        (status(404), pages.path(), "a.zip", "not_found", Some(404)),
        (status(410), pages.path(), "a.zip", "not_found", Some(410)),
        (
            status(500),
            pages.path(),
            "a.zip",
            "server_error",
            Some(500),
        ),
        (
            ServerOptions {
                support_range: false,
                content_type: Some("text/html".into()),
                ..Default::default()
            },
            pages.path(),
            "login.zip",
            "html_page",
            Some(200),
        ),
        (
            ServerOptions {
                content_type: Some("text/html".into()),
                ..Default::default()
            },
            pages.path(),
            "login.zip",
            "html_page",
            Some(206),
        ),
        (
            ServerOptions::default(),
            pages.path(),
            "notes.zip",
            "not_zip",
            None,
        ),
        (
            ServerOptions {
                support_range: false,
                ..Default::default()
            },
            &fx.dir,
            &fx.zip_name,
            "no_range",
            None,
        ),
    ];
    let out = tempfile::tempdir().unwrap();
    let mut host = Host::start();
    for (i, (opts, root, path, code, http_status)) in cases.into_iter().enumerate() {
        let server = TestServer::start(root, opts);
        let url = server.url_for(path);
        // Both kinds of request that touch the network report the same way.
        for kind in ["inspect", "extract"] {
            let id = format!("{kind}{i}");
            host.send(json!({"type": kind, "id": id, "url": url, "output": out.path()}));
            let err = host.collect_until(is_final, 30).pop().unwrap();
            assert_eq!(err["type"], "error", "{kind} {path}: {err}");
            assert_eq!(err["id"], id.as_str());
            assert_eq!(err["code"], code, "{kind} {path}: {err}");
            assert_eq!(
                err["http_status"].as_u64(),
                http_status.map(u64::from),
                "{err}"
            );
            assert_eq!(err["host"], "127.0.0.1", "{err}");
            assert!(
                err["message"].as_str().is_some_and(|m| !m.is_empty())
                    && err["detail"].as_str().is_some_and(|d| !d.is_empty()),
                "{err}"
            );
            let text = err.to_string();
            assert!(
                !text.contains("topsecret") && !text.contains(&format!("/{path}")),
                "the path or query leaked: {text}"
            );
        }
    }

    // Nothing listening on the port: the network (after the retries).
    host.send(json!({"type": "inspect", "id": "net", "url": "http://127.0.0.1:9/a.zip?token=x"}));
    let err = host.collect_until(is_final, 60).pop().unwrap();
    assert_eq!(err["code"], "network", "{err}");
    assert!(
        err["message"].as_str().unwrap().contains("127.0.0.1"),
        "{err}"
    );
    assert!(!err.to_string().contains("token=x"), "{err}");
    assert!(host.finish().success());
}

#[test]
fn a_folder_that_cannot_be_created_is_folder_not_writable() {
    let fx = fixture("small");
    let server = TestServer::start(&fx.dir, ServerOptions::default());
    let base = tempfile::tempdir().unwrap();
    // A file where a folder should be: nothing can be created below it.
    std::fs::write(base.path().join("blocker"), "x").unwrap();
    let blocked = base.path().join("blocker").join("sub");
    // A folder name longer than any file system allows.
    let too_long = base.path().join("x".repeat(300));
    let mut host = Host::start();
    for out in [blocked, too_long] {
        host.send(json!({"type": "extract", "id": "w", "url": server.url_for(&fx.zip_name), "output": out}));
        let err = host.collect_until(is_final, 30).pop().unwrap();
        assert_eq!(err["code"], "folder_not_writable", "{err}");
        assert!(
            err["message"]
                .as_str()
                .unwrap()
                .contains("Choose another folder")
        );
    }
}

#[test]
fn stream_mode_extracts_from_a_server_without_range_support() {
    let fx = fixture("streamed");
    let server = TestServer::start(
        &fx.dir,
        ServerOptions {
            support_range: false,
            ..Default::default()
        },
    );
    let out = tempfile::tempdir().unwrap();
    let url = server.url_for(&fx.zip_name);
    let mut host = Host::start();

    // Without the flag the host explains what is wrong ...
    host.send(json!({"type": "extract", "id": "a", "url": url, "output": out.path()}));
    let err = host.collect_until(is_final, 30).pop().unwrap();
    assert_eq!(err["code"], "no_range", "{err}");

    // ... and with it, the same archive is extracted in a single pass.
    host.send(
        json!({"type": "extract", "id": "b", "url": url, "output": out.path(), "stream": true}),
    );
    let seen = host.collect_until(is_final, 60);
    let done = seen.last().unwrap();
    assert_eq!(done["type"], "done", "{seen:#?}");
    assert_eq!(done["stream"], true);
    assert_eq!(done["requests"], 1);
    assert_eq!(
        done["index_bytes"], 0,
        "stream mode reads no separate index"
    );
    assert_eq!(done["downloaded_bytes"].as_u64().unwrap(), fx.zip_size);
    assert_eq!(done["verified_files"], done["files"]);
    assert_eq!(done["files"].as_u64().unwrap() as usize, fx.files.len());
    assert_eq!(done["zip_bytes_on_disk"], 0);
    assert_tree_matches(out.path(), &fx, |_| true, |_| true);
}
