//! Turning untrusted entry names into safe paths on disk.
//!
//! An archive is attacker-controlled input. Two classes of problems:
//!
//! * **Attacks: rejected.** `..` components ("zip slip"), absolute paths, UNC paths, drive
//!   letters, leading slashes/backslashes, NUL bytes. An archive containing any of these (among
//!   the selected entries) is refused before a single byte is written.
//! * **Names Windows can't store: sanitised and reported.** Invalid characters
//!   (`< > : " | ? *` and control characters), reserved device names (`CON`, `NUL`, `COM1`,
//!   `con.txt`, ...), and trailing dots/spaces are replaced so that the file can be written
//!   and cannot be mistaken for a device or an NTFS alternate data stream. Every rename is
//!   listed in the final summary.
//!
//! The rules are applied on every platform so an archive behaves the same everywhere.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};

/// A sanitised, relative path, plus whether any component had to be changed.
#[derive(Debug, PartialEq, Eq)]
pub struct SafeName {
    pub path: PathBuf,
    pub changed: bool,
}

/// Characters Windows does not allow in a file name (besides the path separators).
const INVALID_CHARS: [char; 7] = ['<', '>', ':', '"', '|', '?', '*'];

/// Turn an entry name from the archive into a relative path that is safe to create under the
/// output folder, or say why the entry must be refused.
pub fn sanitize_entry_name(name: &str) -> Result<SafeName, String> {
    if name.contains('\0') {
        return Err("the name contains a NUL character".into());
    }
    // ZIP uses '/', but some Windows tools wrote '\'. Treat both as separators.
    let unified = name.replace('\\', "/");
    if unified.starts_with('/') {
        return Err("absolute path (starts with a slash or backslash)".into());
    }

    let mut path = PathBuf::new();
    let mut changed = false;
    let mut first = true;
    for raw in unified.split('/') {
        match raw {
            // "a//b", "./a" and the trailing slash of directory entries carry no information.
            "" | "." => continue,
            ".." => return Err("contains \"..\" (path traversal)".into()),
            _ => {}
        }
        if first && has_drive_prefix(raw) {
            return Err("starts with a drive letter (e.g. \"C:\")".into());
        }
        first = false;

        let fixed = sanitize_component(raw);
        changed |= fixed != raw;
        path.push(fixed);
    }
    if path.as_os_str().is_empty() {
        return Err("the name is empty".into());
    }
    // The resume journal lives at the top of the output folder; an entry must not replace it.
    if path
        .to_str()
        .is_some_and(|p| p.eq_ignore_ascii_case(crate::resume::JOURNAL_NAME))
    {
        path = PathBuf::from(format!("_{}", path.display()));
        changed = true;
    }
    Ok(SafeName { path, changed })
}

/// A drive letter at the start of the first component (`C:`, `c:foo`, ...).
fn has_drive_prefix(component: &str) -> bool {
    let mut chars = component.chars();
    matches!((chars.next(), chars.next()), (Some(c), Some(':')) if c.is_ascii_alphabetic())
}

/// Make one path component storable on Windows (see the module docs).
fn sanitize_component(component: &str) -> String {
    let mut s: String = component
        .chars()
        .map(|c| {
            if c < ' ' || INVALID_CHARS.contains(&c) {
                '_'
            } else {
                c
            }
        })
        .collect();

    // Windows silently strips trailing dots and spaces, so "a." and "a" would be the same
    // file. Replace them instead so the name stays distinct and predictable.
    let kept = s.trim_end_matches(['.', ' ']).len();
    if kept != s.len() {
        let trailing = s[kept..].chars().count();
        s.truncate(kept);
        s.extend(std::iter::repeat_n('_', trailing));
    }

    // Reserved device names are reserved even with an extension: "con.txt", "AUX.tar.gz".
    let stem = s.split('.').next().unwrap_or("").trim_end();
    if is_reserved_device_name(stem) {
        s.insert(0, '_');
    }
    s
}

fn is_reserved_device_name(stem: &str) -> bool {
    const BASE: [&str; 6] = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    let upper = stem.to_ascii_uppercase();
    if BASE.contains(&upper.as_str()) {
        return true;
    }
    // COM1-COM9 and LPT1-LPT9, including the superscript digits Windows also reserves.
    for prefix in ["COM", "LPT"] {
        if let Some(digit) = upper.strip_prefix(prefix) {
            let mut chars = digit.chars();
            if let (Some(d), None) = (chars.next(), chars.next())
                && (('1'..='9').contains(&d) || matches!(d, '¹' | '²' | '³'))
            {
                return true;
            }
        }
    }
    false
}

/// Join a sanitised relative path onto the output root, component by component, refusing
/// anything that is not a plain name. (Defence in depth: `sanitize_entry_name` already
/// guarantees this, but this is the last line before touching the disk.)
pub fn join_under(root: &Path, rel: &Path) -> Result<PathBuf> {
    let mut out = root.to_path_buf();
    for c in rel.components() {
        match c {
            Component::Normal(name) => out.push(name),
            other => bail!("refusing to use path component {other:?} from the archive"),
        }
    }
    Ok(out)
}

/// Create the output folder and return its absolute path. On Windows `canonicalize` yields the
/// `\\?\C:\...` form, which lifts the 260-character path limit for everything we create below it.
/// That form also disables Win32 name normalisation, which is fine because every component we
/// append has been sanitised above.
pub fn prepare_root(output: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(output)
        .with_context(|| format!("could not create {}", output.display()))?;
    std::fs::canonicalize(output).with_context(|| format!("could not resolve {}", output.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(name: &str) -> SafeName {
        sanitize_entry_name(name).unwrap_or_else(|e| panic!("{name:?} was rejected: {e}"))
    }
    fn rejected(name: &str) -> String {
        sanitize_entry_name(name).expect_err(&format!("{name:?} should be rejected"))
    }

    #[test]
    fn ordinary_names_pass_unchanged() {
        for name in [
            "a.txt",
            "dir/sub/file.csv",
            "unicode/日本語/ファイル.txt",
            "weird names/file with spaces (1).txt",
            "x/.hidden",
        ] {
            let s = ok(name);
            assert!(!s.changed, "{name}");
            assert_eq!(s.path, PathBuf::from(name));
        }
    }

    #[test]
    fn directory_entries_and_noise_components_are_normalised() {
        assert_eq!(ok("docs/2024/").path, PathBuf::from("docs/2024"));
        assert_eq!(ok("./a//b/./c").path, PathBuf::from("a/b/c"));
        assert!(
            !ok("./a//b/").changed,
            "dropping empty components is not a rename"
        );
    }

    #[test]
    fn backslashes_are_separators() {
        assert_eq!(
            ok(r"dir\sub\file.txt").path,
            PathBuf::from("dir/sub/file.txt")
        );
    }

    #[test]
    fn path_traversal_is_rejected() {
        for name in [
            "../evil.txt",
            "a/../../evil.txt",
            "a/..",
            r"..\evil.txt",
            r"a\..\..\evil.txt",
            "..",
        ] {
            assert!(rejected(name).contains(".."), "{name}");
        }
    }

    #[test]
    fn absolute_and_unc_paths_are_rejected() {
        for name in [
            "/etc/passwd",
            r"\Windows\System32\x.dll",
            r"\\server\share\x",
            "//server/share/x",
        ] {
            assert!(rejected(name).contains("absolute"), "{name}");
        }
    }

    #[test]
    fn drive_letters_are_rejected() {
        for name in [r"C:\Windows\x.dll", "C:/x", "c:x", "D:", r"z:\a"] {
            assert!(rejected(name).contains("drive"), "{name}");
        }
        // A colon elsewhere is merely an invalid character.
        assert_eq!(ok("a/b:c").path, PathBuf::from("a/b_c"));
    }

    #[test]
    fn nul_is_rejected() {
        assert!(rejected("a\0b").contains("NUL"));
    }

    #[test]
    fn empty_names_are_rejected() {
        assert!(rejected("").contains("empty"));
        assert!(rejected("/").contains("absolute"));
        assert!(rejected("./").contains("empty"));
    }

    #[test]
    fn invalid_windows_characters_are_replaced() {
        let s = ok(r#"report: Q1 <draft> "final" | v2? *.txt"#);
        assert!(s.changed);
        assert_eq!(
            s.path,
            PathBuf::from("report_ Q1 _draft_ _final_ _ v2_ _.txt")
        );
        assert_eq!(ok("tab\there.txt").path, PathBuf::from("tab_here.txt"));
    }

    #[test]
    fn alternate_data_streams_cannot_be_created() {
        assert_eq!(ok("file.txt:hidden").path, PathBuf::from("file.txt_hidden"));
    }

    #[test]
    fn reserved_device_names_are_prefixed() {
        for (name, expected) in [
            ("con", "_con"),
            ("CON", "_CON"),
            ("nul.txt", "_nul.txt"),
            ("dir/AUX.tar.gz", "dir/_AUX.tar.gz"),
            ("Prn", "_Prn"),
            ("com1", "_com1"),
            ("COM9.log", "_COM9.log"),
            ("lpt5", "_lpt5"),
            ("LPT9.x", "_LPT9.x"),
            ("COM¹", "_COM¹"),
            ("CONIN$", "_CONIN$"),
            ("con .txt", "_con .txt"),
        ] {
            let s = ok(name);
            assert!(s.changed, "{name}");
            assert_eq!(s.path, PathBuf::from(expected), "{name}");
        }
    }

    #[test]
    fn names_that_merely_contain_reserved_words_are_untouched() {
        for name in [
            "console.txt",
            "com10",
            "com0",
            "lpt",
            "auxiliary",
            "nul_x",
            "a/xcon",
            "COM",
        ] {
            assert!(!ok(name).changed, "{name}");
        }
    }

    #[test]
    fn trailing_dots_and_spaces_are_replaced_not_stripped() {
        assert_eq!(ok("name.").path, PathBuf::from("name_"));
        assert_eq!(ok("name  ").path, PathBuf::from("name__"));
        assert_eq!(ok("a./b").path, PathBuf::from("a_/b"));
        assert_eq!(ok("...").path, PathBuf::from("___"));
        assert_eq!(ok(".hidden").path, PathBuf::from(".hidden"));
    }

    #[test]
    fn the_resume_journal_name_is_reserved_at_the_top_only() {
        let s = ok(".LinkUnzip-Resume.jsonl");
        assert!(s.changed);
        assert_eq!(s.path, PathBuf::from("_.LinkUnzip-Resume.jsonl"));
        assert!(!ok("sub/.linkunzip-resume.jsonl").changed);
    }

    #[test]
    fn join_under_only_accepts_plain_components() {
        let root = Path::new("root");
        assert_eq!(
            join_under(root, Path::new("a/b.txt")).unwrap(),
            Path::new("root").join("a").join("b.txt")
        );
        assert!(join_under(root, Path::new("../x")).is_err());
        assert!(join_under(root, Path::new("a/../x")).is_err());
        #[cfg(windows)]
        {
            assert!(join_under(root, Path::new(r"C:\x")).is_err());
            assert!(join_under(root, Path::new(r"\x")).is_err());
        }
        #[cfg(not(windows))]
        assert!(join_under(root, Path::new("/x")).is_err());
    }

    #[test]
    fn prepare_root_creates_the_folder_and_returns_an_absolute_path() {
        let tmp = std::env::temp_dir()
            .join(format!("linkunzip-root-test-{}", std::process::id()))
            .join("nested");
        let root = prepare_root(&tmp).unwrap();
        assert!(root.is_absolute() && root.is_dir());
        #[cfg(windows)]
        assert!(
            root.to_string_lossy().starts_with(r"\\?\"),
            "expected the long-path form: {}",
            root.display()
        );
        let _ = std::fs::remove_dir_all(tmp.parent().unwrap());
    }
}
