//! The open folder: file watching, project-wide file listing and search, and
//! explorer file operations (create / rename / move to trash).
//!
//! Every path the frontend passes in must sit inside the folder registered by
//! `workspace_open`, so these commands can't touch the rest of the disk.

use ignore::WalkBuilder;
use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{ipc::Channel, State};

/// Build output and dependency folders: hidden from the tree, skipped by search
/// and the watcher. Keep in sync with `IGNORED` in src/fs.ts.
const IGNORED: &[&str] = &["node_modules", ".git", "dist", "build", ".next", ".cache", "target"];

/// Above this many changed paths in one batch, tell the frontend to refresh everything.
const MAX_CHANGE_PATHS: usize = 500;
const MAX_LISTED_FILES: usize = 50_000;
const MAX_SEARCH_MATCHES: usize = 5_000;
const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct WorkspaceState {
    root: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl WorkspaceState {
    fn root(&self) -> Result<PathBuf, String> {
        self.root.lock().unwrap().clone().ok_or_else(|| "No folder is open".into())
    }

    /// The path, if it is strictly inside the open folder.
    fn inside(&self, path: &str) -> Result<PathBuf, String> {
        let root = self.root()?;
        let path = PathBuf::from(path);
        let escapes = path.components().any(|c| matches!(c, Component::ParentDir));
        if escapes || path == root || !path.starts_with(&root) {
            return Err(format!("{} is outside the open folder", path.display()));
        }
        Ok(path)
    }
}

fn is_ignored(name: &std::ffi::OsStr) -> bool {
    IGNORED.iter().any(|n| name == *n)
}

/// Walks the folder honouring .gitignore (even outside a git repo), showing dotfiles.
fn walker(root: &Path) -> WalkBuilder {
    let mut w = WalkBuilder::new(root);
    w.hidden(false)
        .require_git(false)
        .filter_entry(|e| !is_ignored(e.file_name()));
    w
}

#[derive(Clone, Serialize)]
pub struct FsChange {
    paths: Vec<String>,
    overflow: bool,
}

/// Register the open folder and start watching it. Replaces any previous watcher.
#[tauri::command]
pub async fn workspace_open(
    state: State<'_, WorkspaceState>,
    root: String,
    on_change: Channel<FsChange>,
) -> Result<(), String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let watch_root = root.clone();
    let mut debouncer = new_debouncer(Duration::from_millis(250), move |res: DebounceEventResult| {
        let Ok(events) = res else { return };
        let mut paths: Vec<String> = events
            .into_iter()
            .filter(|e| match e.path.strip_prefix(&watch_root) {
                Ok(rel) => !rel.components().any(|c| is_ignored(c.as_os_str())),
                Err(_) => false,
            })
            .map(|e| e.path.to_string_lossy().into_owned())
            .collect();
        if paths.is_empty() {
            return;
        }
        paths.sort();
        paths.dedup();
        let overflow = paths.len() > MAX_CHANGE_PATHS;
        if overflow {
            paths.clear();
        }
        let _ = on_change.send(FsChange { paths, overflow });
    })
    .map_err(|e| e.to_string())?;
    debouncer
        .watcher()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.watcher.lock().unwrap() = Some(debouncer);
    *state.root.lock().unwrap() = Some(root);
    Ok(())
}

/// Every file in the folder (relative, `/`-separated), for Go to File.
#[tauri::command]
pub async fn workspace_files(state: State<'_, WorkspaceState>) -> Result<Vec<String>, String> {
    let root = state.root()?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in walker(&root).build().flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= MAX_LISTED_FILES {
                    break;
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    query: String,
    case_sensitive: bool,
    whole_word: bool,
    regex: bool,
}

/// Columns and lengths are UTF-16 units, matching Monaco and JS strings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMatch {
    line: u32,
    column: u32,
    length: u32,
    preview: String,
    preview_start: u32,
    preview_length: u32,
}

#[derive(Serialize)]
pub struct FileMatches {
    path: String,
    matches: Vec<LineMatch>,
}

#[derive(Serialize)]
pub struct SearchResults {
    files: Vec<FileMatches>,
    truncated: bool,
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// A short slice of `line` around the match at `start..end`, without leading indentation.
fn preview(line: &str, start: usize, end: usize) -> (String, u32, u32) {
    let mut from = start.saturating_sub(60);
    while !line.is_char_boundary(from) {
        from -= 1;
    }
    let mut to = (end + 200).min(line.len());
    while !line.is_char_boundary(to) {
        to += 1;
    }
    let from = start - line[from..start].trim_start().len();
    let prefix = if line[..from].trim().is_empty() { "" } else { "…" };
    let lead = utf16_len(prefix) + utf16_len(&line[from..start]);
    (format!("{prefix}{}", &line[from..to]), lead, utf16_len(&line[start..end]))
}

#[tauri::command]
pub async fn workspace_search(
    state: State<'_, WorkspaceState>,
    options: SearchOptions,
) -> Result<SearchResults, String> {
    let root = state.root()?;
    let mut pattern = if options.regex { options.query } else { regex::escape(&options.query) };
    if options.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let mut total = 0;
        for entry in walker(&root).build().flatten() {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if entry.metadata().map_or(true, |m| m.len() > MAX_SEARCH_FILE_BYTES) {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else { continue };
            if bytes[..bytes.len().min(8000)].contains(&0) {
                continue; // binary
            }
            let text = String::from_utf8_lossy(&bytes);
            let mut matches = Vec::new();
            for (i, line) in text.lines().enumerate() {
                for m in re.find_iter(line) {
                    if m.is_empty() {
                        continue;
                    }
                    let (preview, preview_start, preview_length) = preview(line, m.start(), m.end());
                    matches.push(LineMatch {
                        line: i as u32 + 1,
                        column: utf16_len(&line[..m.start()]) + 1,
                        length: utf16_len(m.as_str()),
                        preview,
                        preview_start,
                        preview_length,
                    });
                    total += 1;
                    if total >= MAX_SEARCH_MATCHES {
                        files.push(FileMatches { path: entry.path().to_string_lossy().into_owned(), matches });
                        return SearchResults { files, truncated: true };
                    }
                }
            }
            if !matches.is_empty() {
                files.push(FileMatches { path: entry.path().to_string_lossy().into_owned(), matches });
            }
        }
        SearchResults { files, truncated: false }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_create(
    state: State<'_, WorkspaceState>,
    path: String,
    directory: bool,
) -> Result<(), String> {
    let path = state.inside(&path)?;
    if path.exists() {
        return Err(format!("{} already exists", display_name(&path)));
    }
    let result = if directory {
        fs::create_dir(&path)
    } else {
        fs::File::create_new(&path).map(|_| ())
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_rename(
    state: State<'_, WorkspaceState>,
    from: String,
    to: String,
) -> Result<(), String> {
    let from_path = state.inside(&from)?;
    let to_path = state.inside(&to)?;
    // A case-only rename "exists" on case-insensitive file systems
    let case_only = from.to_lowercase() == to.to_lowercase();
    if to_path.exists() && !case_only {
        return Err(format!("{} already exists", display_name(&to_path)));
    }
    fs::rename(&from_path, &to_path).map_err(|e| e.to_string())
}

/// Delete by moving to the Recycle Bin / Trash, so it can be undone.
#[tauri::command]
pub async fn workspace_trash(state: State<'_, WorkspaceState>, path: String) -> Result<(), String> {
    let path = state.inside(&path)?;
    trash::delete(&path).map_err(|e| e.to_string())
}

fn display_name(path: &Path) -> String {
    path.file_name().map_or_else(|| path.display().to_string(), |n| n.to_string_lossy().into_owned())
}
