//! Shared helpers for the integration tests: fixture generation (via tools/make_test_zips.py),
//! manifest parsing and SHA-256 comparison of extracted trees.
#![allow(dead_code)]

pub mod server;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use linkunzip::error::RetryPolicy;
use linkunzip::extract::ExtractOptions;
use sha2::{Digest, Sha256};

/// Options for an extraction in tests: same attempt count as production, but tiny backoff delays.
pub fn options(url: String, out: &Path, include: &[&str], jobs: usize) -> ExtractOptions {
    ExtractOptions {
        url,
        output: out.to_path_buf(),
        include: include.iter().map(|s| s.to_string()).collect(),
        select: None,
        jobs,
        force: false,
        retry: RetryPolicy {
            max_attempts: 5,
            base_delay: Duration::from_millis(5),
        },
        progress: false,
        headers: Vec::new(),
        cancel: None,
        on_progress: None,
        stream: false,
        resume: true,
    }
}

/// One file as recorded by the Python generator when it wrote the archive.
#[derive(Debug, Clone)]
pub struct ManifestFile {
    pub name: String,
    pub size: u64,
    pub sha256: String,
    pub method: u16,
    pub compressed_size: u64,
    pub crc32: u32,
    pub header_offset: u64,
}

#[derive(Debug)]
pub struct Fixture {
    pub zip_path: PathBuf,
    pub zip_name: String,
    pub zip_size: u64,
    pub dir: PathBuf,
    pub files: Vec<ManifestFile>,
    pub dirs: Vec<String>,
}

/// Directory where generated archives are cached (inside Cargo's per-workspace test tmp dir).
pub fn fixtures_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn python() -> Command {
    for candidate in [("python", None), ("py", Some("-3")), ("python3", None)] {
        let mut cmd = Command::new(candidate.0);
        if let Some(arg) = candidate.1 {
            cmd.arg(arg);
        }
        if cmd
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            let mut real = Command::new(candidate.0);
            if let Some(arg) = candidate.1 {
                real.arg(arg);
            }
            return real;
        }
    }
    panic!(
        "these tests need Python 3 on PATH (python / py -3 / python3) to run tools/make_test_zips.py"
    );
}

static GENERATE_LOCK: Mutex<()> = Mutex::new(());

/// Build (or reuse) a fixture archive. `kind` is a `make_test_zips.py` kind; extra CLI args may
/// be passed, e.g. `["--big-gib", "2.1"]`.
pub fn fixture_with_args(kind: &str, args: &[&str]) -> Fixture {
    let _guard = GENERATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = fixtures_dir();
    // Tag the cache entry with the args so different sizes don't collide.
    let tag = if args.is_empty() {
        String::new()
    } else {
        format!("-{}", args.join("_").replace(['.', '-'], ""))
    };
    let sub = dir.join(format!("{kind}{tag}"));
    let manifest_path = sub.join(format!("{kind}.manifest.json"));
    if !manifest_path.exists() {
        std::fs::create_dir_all(&sub).unwrap();
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/make_test_zips.py");
        let out = python()
            .arg(script)
            .arg(kind)
            .arg("--out")
            .arg(&sub)
            .args(args)
            .env("PYTHONIOENCODING", "utf-8")
            .output()
            .expect("failed to run python");
        assert!(
            out.status.success(),
            "make_test_zips.py {kind} failed:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    load_manifest(&manifest_path)
}

pub fn fixture(kind: &str) -> Fixture {
    fixture_with_args(kind, &[])
}

/// Directory holding the hostile archives from tools/make_malicious_zips.py (generated once).
pub fn malicious_dir() -> PathBuf {
    let _guard = GENERATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = fixtures_dir().join("malicious");
    if !dir.join("malicious.manifest.json").exists() {
        std::fs::create_dir_all(&dir).unwrap();
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tools/make_malicious_zips.py");
        let out = python()
            .arg(script)
            .arg("--out")
            .arg(&dir)
            .arg("--bomb-mib")
            .arg("64")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "make_malicious_zips.py failed:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    dir
}

pub fn load_manifest(path: &Path) -> Fixture {
    let text = std::fs::read_to_string(path).unwrap();
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    let dir = path.parent().unwrap().to_path_buf();
    let zip_name = v["archive"].as_str().unwrap().to_string();
    let files = v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| ManifestFile {
            name: f["name"].as_str().unwrap().to_string(),
            size: f["size"].as_u64().unwrap(),
            sha256: f["sha256"].as_str().unwrap().to_string(),
            method: f["method"].as_u64().unwrap() as u16,
            compressed_size: f["compressed_size"].as_u64().unwrap(),
            crc32: f["crc32"].as_u64().unwrap() as u32,
            header_offset: f["header_offset"].as_u64().unwrap(),
        })
        .collect();
    let dirs = v["dirs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d.as_str().unwrap().to_string())
        .collect();
    Fixture {
        zip_path: dir.join(&zip_name),
        zip_name,
        zip_size: v["archive_size"].as_u64().unwrap(),
        dir,
        files,
        dirs,
    }
}

pub fn sha256_file(path: &Path) -> String {
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut f =
        std::fs::File::open(path).unwrap_or_else(|e| panic!("cannot open {}: {e}", path.display()));
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).unwrap();
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hex::encode(hasher.finalize())
}

/// All files under `root` as '/'-separated relative paths.
pub fn list_files(root: &Path) -> BTreeSet<String> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeSet<String>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
            } else {
                let rel = path.strip_prefix(root).unwrap();
                out.insert(
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(root, root, &mut out);
    out
}

/// Check that `out_dir` contains exactly the manifest files accepted by `want` (with identical
/// SHA-256) and no leftovers (`.part` files, extra files). Directories in the manifest that
/// `want_dir` accepts must exist.
pub fn assert_tree_matches(
    out_dir: &Path,
    fx: &Fixture,
    want: impl Fn(&str) -> bool,
    want_dir: impl Fn(&str) -> bool,
) {
    let expected: BTreeSet<String> = fx
        .files
        .iter()
        .filter(|f| want(&f.name))
        .map(|f| f.name.clone())
        .collect();
    let actual = list_files(out_dir);
    assert_eq!(
        actual, expected,
        "extracted file set differs from the manifest"
    );
    for f in fx.files.iter().filter(|f| want(&f.name)) {
        let path = out_dir.join(&f.name);
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), f.size, "size of {}", f.name);
        assert_eq!(sha256_file(&path), f.sha256, "SHA-256 of {}", f.name);
    }
    for d in fx.dirs.iter().filter(|d| want_dir(d)) {
        assert!(
            out_dir.join(d.trim_end_matches('/')).is_dir(),
            "directory {d} was not created"
        );
    }
}
