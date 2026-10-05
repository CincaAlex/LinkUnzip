//! The archive as folders and files, for the browser's file list: one folder's contents page by
//! page, a search over every path, and the totals of a selection.
//!
//! Built once per inspected archive. Archives can hold a hundred thousand files in a single folder
//! (COCO train2017 has 118,287), so everything is sorted once up front and a page is a slice;
//! nothing walks the whole archive per request except `search` and `measure`, which are linear.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::plan::{Filter, list_path};
use crate::zip::Entry;
use crate::zip::central::{METHOD_DEFLATE, METHOD_STORED};

/// Items in a page unless the request asks otherwise, and the most it may ask for.
pub const DEFAULT_LIMIT: usize = 500;
pub const MAX_LIMIT: usize = 2000;
/// Search results unless the request asks otherwise.
pub const DEFAULT_SEARCH_LIMIT: usize = 200;

struct Folder {
    /// Its own name (the last part of the path); "" for the root.
    name: String,
    /// `a/b/` (with the trailing `/`); "" for the root.
    path: String,
    parent: Option<usize>,
    /// Sub-folders and files directly inside, each sorted by name (case-insensitive).
    folders: Vec<usize>,
    files: Vec<usize>,
    /// Totals of every file below, at any depth.
    file_count: u64,
    size: u64,
    compressed: u64,
}

/// One inspected archive, ready to browse.
pub struct Tree {
    entries: Vec<Entry>,
    folders: Vec<Folder>,
    by_path: HashMap<String, usize>,
    /// Every file entry, sorted by path (case-insensitive), with its lower-cased path for search.
    search_order: Vec<(usize, String)>,
}

/// The name shown for an entry: the part after the last `/`.
fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

impl Tree {
    pub fn new(entries: Vec<Entry>) -> Tree {
        let mut tree = Tree {
            entries: Vec::new(),
            folders: vec![Folder {
                name: String::new(),
                path: String::new(),
                parent: None,
                folders: Vec::new(),
                files: Vec::new(),
                file_count: 0,
                size: 0,
                compressed: 0,
            }],
            by_path: HashMap::from([(String::new(), 0)]),
            search_order: Vec::new(),
        };
        for (i, entry) in entries.iter().enumerate() {
            let path = list_path(&entry.name);
            // The folders an entry lies in: "a/b/c.txt" -> "a/", "a/b/"; the directory entry
            // "a/b/" is the folder "a/b/" itself.
            let folder_part = if entry.is_dir() {
                &path[..]
            } else {
                path.rfind('/').map_or("", |i| &path[..=i])
            };
            let mut current = 0;
            let mut start = 0;
            for (slash, _) in folder_part.match_indices('/') {
                let folder_path = &folder_part[..=slash];
                current = match tree.by_path.get(folder_path) {
                    Some(&f) => f,
                    None => tree.add_folder(current, &folder_part[start..slash], folder_path),
                };
                start = slash + 1;
            }
            if !entry.is_dir() {
                let folder = &mut tree.folders[current];
                folder.files.push(i);
                folder.file_count += 1;
                folder.size += entry.uncompressed_size;
                folder.compressed += entry.compressed_size;
                tree.search_order.push((i, path.to_lowercase()));
            }
        }
        // Every folder was created after its parent, so adding each one to its parent from the
        // last to the first carries the totals all the way up.
        for f in (1..tree.folders.len()).rev() {
            let (count, size, compressed) = {
                let folder = &tree.folders[f];
                (folder.file_count, folder.size, folder.compressed)
            };
            if let Some(parent) = tree.folders[f].parent {
                let p = &mut tree.folders[parent];
                p.file_count += count;
                p.size += size;
                p.compressed += compressed;
            }
        }
        // Sort once: folders by name, files by name, search results by path.
        let folder_keys: Vec<String> = tree.folders.iter().map(|f| f.name.to_lowercase()).collect();
        for f in 0..tree.folders.len() {
            let mut subs = std::mem::take(&mut tree.folders[f].folders);
            subs.sort_by(|a, b| folder_keys[*a].cmp(&folder_keys[*b]));
            tree.folders[f].folders = subs;
            let mut files = std::mem::take(&mut tree.folders[f].files);
            files.sort_by_cached_key(|&i| file_name(&list_path(&entries[i].name)).to_lowercase());
            tree.folders[f].files = files;
        }
        tree.search_order.sort_by(|a, b| a.1.cmp(&b.1));
        tree.entries = entries;
        tree
    }

    fn add_folder(&mut self, parent: usize, name: &str, path: &str) -> usize {
        let index = self.folders.len();
        self.folders.push(Folder {
            name: name.to_string(),
            path: path.to_string(),
            parent: Some(parent),
            folders: Vec::new(),
            files: Vec::new(),
            file_count: 0,
            size: 0,
            compressed: 0,
        });
        self.folders[parent].folders.push(index);
        self.by_path.insert(path.to_string(), index);
        index
    }

    /// Number of folders, the implied ones included (the root does not count).
    pub fn folder_count(&self) -> usize {
        self.folders.len() - 1
    }

    /// One page of folder `dir` ("" = the top, otherwise ending in `/`): folders first, then
    /// files. `(total, items)`, or `None` if there is no such folder.
    pub fn list(&self, dir: &str, offset: usize, limit: usize) -> Option<(usize, Vec<Value>)> {
        let folder = &self.folders[*self.by_path.get(dir)?];
        let subs = folder.folders.len();
        let total = subs + folder.files.len();
        let end = offset.saturating_add(limit).min(total);
        let items = (offset.min(end)..end)
            .map(|k| match folder.folders.get(k) {
                Some(&f) => self.folder_item(f),
                None => self.file_item(folder.files[k - subs]),
            })
            .collect();
        Some((total, items))
    }

    /// Files whose path contains `query` (case-insensitive), in path order: `(total, first
    /// `limit` items)`.
    pub fn search(&self, query: &str, limit: usize) -> (usize, Vec<Value>) {
        let query = query.to_lowercase();
        let mut total = 0;
        let mut items = Vec::new();
        for (i, path) in &self.search_order {
            if path.contains(&query) {
                total += 1;
                if items.len() < limit {
                    items.push(self.file_item(*i));
                }
            }
        }
        (total, items)
    }

    /// What extracting the files `filter` selects would write.
    pub fn measure(&self, filter: &Filter) -> Measured {
        let mut m = Measured::default();
        for e in self
            .entries
            .iter()
            .filter(|e| !e.is_dir() && filter.matches(&e.name))
        {
            m.files += 1;
            m.extracted += e.uncompressed_size;
            m.compressed += e.compressed_size;
            if unsupported(e).is_some() {
                m.unsupported += 1;
            }
        }
        m
    }

    fn folder_item(&self, f: usize) -> Value {
        let folder = &self.folders[f];
        json!({
            "name": folder.name,
            "path": folder.path,
            "dir": true,
            "size": folder.size,
            "compressed": folder.compressed,
            "files": folder.file_count,
        })
    }

    fn file_item(&self, i: usize) -> Value {
        let entry = &self.entries[i];
        let path = list_path(&entry.name);
        json!({
            "name": file_name(&path),
            "path": path,
            "dir": false,
            "size": entry.uncompressed_size,
            "compressed": entry.compressed_size,
            "unsupported": unsupported(entry),
        })
    }
}

/// Totals of a selection (`measure`).
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Measured {
    pub files: u64,
    pub extracted: u64,
    pub compressed: u64,
    /// Selected files LinkUnzip cannot extract (extracting the selection would be refused).
    pub unsupported: u64,
}

/// `"encrypted"`, `"method N"`, or `None` for a file LinkUnzip can extract.
fn unsupported(e: &Entry) -> Option<String> {
    if e.is_encrypted() {
        Some("encrypted".to_string())
    } else if matches!(e.method, METHOD_STORED | METHOD_DEFLATE) {
        None
    } else {
        Some(format!("method {}", e.method))
    }
}

/// As many of `items` as fit in `budget` bytes of JSON, so a reply stays under the browser's
/// 1 MB limit even when names are very long.
pub fn within_budget(items: Vec<Value>, budget: usize) -> Vec<Value> {
    let mut used = 0;
    let mut kept = Vec::with_capacity(items.len());
    for item in items {
        used += serde_json::to_vec(&item).map_or(usize::MAX, |b| b.len()) + 1;
        if used > budget {
            break;
        }
        kept.push(item);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::Selection;

    fn file(name: &str, size: u64) -> Entry {
        Entry {
            name: name.into(),
            flags: 0,
            method: 8,
            crc32: 0,
            compressed_size: size / 2,
            uncompressed_size: size,
            local_header_offset: 0,
        }
    }

    fn names(items: &[Value]) -> Vec<&str> {
        items.iter().map(|i| i["name"].as_str().unwrap()).collect()
    }

    fn tree() -> Tree {
        let mut secret = file("docs/secret.pdf", 10);
        secret.flags = 1;
        let mut bz = file("docs/old.bz2", 10);
        bz.method = 12;
        Tree::new(vec![
            file("readme.txt", 100),
            file("docs/b.txt", 20),
            file("docs/A.txt", 30),
            file("docs/sub/deep/x.bin", 1000),
            file("Zeta/z.txt", 4),
            Entry {
                method: 0,
                ..file("empty/", 0)
            },
            secret,
            bz,
            file(r"win\path.txt", 6),
        ])
    }

    #[test]
    fn folders_come_first_then_files_each_sorted_without_case() {
        let t = tree();
        let (total, items) = t.list("", 0, 100).unwrap();
        assert_eq!(total, 5);
        assert_eq!(
            names(&items),
            ["docs", "empty", "win", "Zeta", "readme.txt"]
        );
        let docs = &items[0];
        assert_eq!(docs["path"], "docs/");
        assert_eq!(docs["dir"], true);
        assert_eq!(docs["files"], 5, "every file below, at any depth");
        assert_eq!(docs["size"], 20 + 30 + 1000 + 10 + 10);
        assert!(docs.get("unsupported").is_none());
        let (_, docs) = t.list("docs/", 0, 100).unwrap();
        assert_eq!(
            names(&docs),
            ["sub", "A.txt", "b.txt", "old.bz2", "secret.pdf"]
        );
        assert_eq!(docs[1]["path"], "docs/A.txt");
        assert_eq!(docs[1]["unsupported"], Value::Null);
        assert_eq!(docs[3]["unsupported"], "method 12");
        assert_eq!(docs[4]["unsupported"], "encrypted");
        assert!(docs[1].get("files").is_none());
        // Implied folders (no directory entry) exist, and so do empty ones.
        assert_eq!(t.list("docs/sub/deep/", 0, 10).unwrap().0, 1);
        assert_eq!(t.list("empty/", 0, 10).unwrap().0, 0);
        assert_eq!(t.list("win/", 0, 10).unwrap().1[0]["path"], "win/path.txt");
        assert!(t.list("nope/", 0, 10).is_none());
        assert_eq!(
            t.folder_count(),
            6,
            "docs, docs/sub, docs/sub/deep, Zeta, empty, win"
        );
    }

    #[test]
    fn pages_are_slices() {
        let t = tree();
        let (total, first) = t.list("", 0, 2).unwrap();
        let (_, second) = t.list("", 2, 2).unwrap();
        let (_, last) = t.list("", 4, 2).unwrap();
        let (_, past) = t.list("", 10, 2).unwrap();
        assert_eq!(total, 5);
        assert_eq!(names(&first), ["docs", "empty"]);
        assert_eq!(names(&second), ["win", "Zeta"]);
        assert_eq!(names(&last), ["readme.txt"]);
        assert!(past.is_empty());
    }

    #[test]
    fn search_is_a_case_insensitive_substring_over_files() {
        let t = tree();
        let (total, items) = t.search("A.TXT", 10);
        assert_eq!(total, 1);
        assert_eq!(items[0]["path"], "docs/A.txt");
        let (total, items) = t.search("docs/", 2);
        assert_eq!((total, items.len()), (5, 2), "total counts every match");
        assert_eq!(t.search("empty", 10).0, 0, "folders are not results");
    }

    #[test]
    fn measure_follows_the_selection() {
        let t = tree();
        let sel = Selection {
            paths: vec!["docs/".into(), "readme.txt".into()],
            exclude: vec!["docs/sub/".into()],
        };
        let m = t.measure(&Filter::with_selection(&[], Some(&sel)).unwrap());
        assert_eq!(
            m,
            Measured {
                files: 5,
                extracted: 100 + 20 + 30 + 10 + 10,
                compressed: 50 + 10 + 15 + 5 + 5,
                unsupported: 2,
            }
        );
    }

    #[test]
    fn a_hundred_thousand_files_in_one_folder_are_quick() {
        let entries: Vec<Entry> = (0..120_000)
            .map(|i| file(&format!("train2017/{i:012}.jpg"), 1000))
            .collect();
        let started = std::time::Instant::now();
        let t = Tree::new(entries);
        let (total, page) = t.list("train2017/", 118_000, 500).unwrap();
        assert_eq!((total, page.len()), (120_000, 500));
        assert_eq!(t.list("", 0, 10).unwrap().1[0]["files"], 120_000);
        assert_eq!(t.search("000000119999", 5).0, 1);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn pages_are_cut_to_fit_the_message_limit() {
        let items: Vec<Value> = (0..100)
            .map(|i| json!({"name": "x".repeat(1000), "i": i}))
            .collect();
        let kept = within_budget(items, 10_000);
        assert!(!kept.is_empty() && kept.len() < 10, "{}", kept.len());
        assert!(serde_json::to_vec(&kept).unwrap().len() <= 10_000);
    }
}
