use super::AgentSource;
use crate::hash::file_stamp;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub const BATCH_SIZE: usize = 32;
#[derive(Clone, Debug)]
pub struct Item {
    pub cursor_composer_key: Option<String>,
    pub key: String,
    pub path: Option<PathBuf>,
    pub activity: f64,
    pub fingerprint: String,
    pub target: bool,
    pub bytes: u64,
}
#[derive(Clone, Debug)]
pub struct Backfill {
    pub items: Vec<Item>,
    pub signature: String,
    pub offset: usize,
    pub epoch: u64,
    pub generation: u64,
    pub dirty: std::collections::BTreeSet<PathBuf>,
    pub refreshed: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Checkpoint {
    version: u32,
    inventory: String,
    offset: usize,
    epoch: u64,
    generation: u64,
    #[serde(default)]
    dirty: std::collections::BTreeSet<PathBuf>,
    #[serde(default)]
    refreshed: bool,
}
impl Backfill {
    pub fn new(
        mut items: Vec<Item>,
        from: Option<f64>,
        to: Option<f64>,
        generation: u64,
        checkpoint: Option<&serde_json::Value>,
        restart: bool,
    ) -> Self {
        let preferred = |item: &Item| {
            from.is_none_or(|from| item.activity >= from) && to.is_none_or(|to| item.activity <= to)
        };
        items.sort_by(|a, b| {
            b.target
                .cmp(&a.target)
                .then_with(|| preferred(b).cmp(&preferred(a)))
                .then_with(|| b.activity.total_cmp(&a.activity))
                .then_with(|| a.key.cmp(&b.key))
        });
        let mut hash = Sha256::new();
        for item in &items {
            hash.update(serde_json::to_vec(&(&item.key, &item.fingerprint)).unwrap());
        }
        let signature = crate::hash::hex(&hash.finalize());
        let previous = checkpoint
            .cloned()
            .and_then(|value| serde_json::from_value::<Checkpoint>(value).ok())
            .filter(|value| value.version == 1);
        let resume = previous.as_ref().filter(|value| {
            !restart && value.inventory == signature && value.generation == generation
        });
        let offset = resume.map_or(0, |value| value.offset.min(items.len()));
        let epoch = previous
            .as_ref()
            .map_or(0, |value| value.epoch + u64::from(resume.is_none()));
        let dirty = resume.map_or_else(std::collections::BTreeSet::new, |checkpoint| {
            checkpoint.dirty.clone()
        });
        let refreshed = resume.is_some_and(|checkpoint| checkpoint.refreshed);
        Self {
            refreshed,
            dirty,
            items,
            signature,
            offset,
            epoch,
            generation,
        }
    }
    pub fn checkpoint(&self) -> serde_json::Value {
        let mut checkpoint = serde_json::to_value(Checkpoint {
            version: 1,
            inventory: self.signature.clone(),
            offset: self.offset,
            epoch: self.epoch,
            generation: self.generation,
            dirty: self.dirty.clone(),
            refreshed: self.refreshed,
        })
        .unwrap();
        checkpoint["total"] = self.items.len().into();
        checkpoint
    }
}
fn stamp(path: &Path) -> Result<(f64, String)> {
    Ok(file_stamp(&std::fs::metadata(path)?)?)
}
/// File state of a database-backed source; `None` for file-backed sources.
pub fn database_stamp(source: &AgentSource) -> Result<Option<String>> {
    let Some(database) = crate::agents::database_path(&source.agent, &source.scan_path) else {
        return Ok(None);
    };
    let mut database_stamp = String::new();
    for suffix in ["", "-wal", "-journal"] {
        let path = PathBuf::from(format!("{}{suffix}", database.to_string_lossy()));
        if path.try_exists()? {
            database_stamp.push_str(&stamp(&path)?.1);
        }
    }
    if source.agent == "cursor" {
        append_cursor_workspace_stamps(&source.scan_path, &mut database_stamp)?;
    }
    Ok(Some(database_stamp))
}
fn append_cursor_workspace_stamps(root: &Path, out: &mut String) -> Result<()> {
    let storage = root.join("workspaceStorage");
    if !storage.try_exists()? {
        return Ok(());
    }
    let mut entries: Vec<_> = std::fs::read_dir(storage)?.collect::<std::io::Result<_>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        for name in [
            "workspace.json",
            "state.vscdb",
            "state.vscdb-wal",
            "state.vscdb-journal",
        ] {
            let path = dir.join(name);
            if path.try_exists()? {
                out.push('|');
                out.push_str(&entry.file_name().to_string_lossy());
                out.push('/');
                out.push_str(name);
                out.push(':');
                out.push_str(&stamp(&path)?.1);
            }
        }
    }
    Ok(())
}
/// Per-session content fingerprints, so writes that leave a session untouched do not invalidate it.
fn session_fingerprints(source: &AgentSource) -> Result<HashMap<String, String>> {
    let root = &source.scan_path;
    match source.agent.as_str() {
        "opencode" => crate::agents::opencode::root_fingerprints(root, "opencode", true),
        "zcode" => crate::agents::opencode::root_fingerprints(
            &root.join("cli/db/db.sqlite"),
            "zcode",
            false,
        ),
        "deepchat" => crate::agents::deepchat::fingerprints(root),
        "cherrystudio" => crate::agents::cherrystudio::fingerprints(root),
        "minimax-code" => crate::agents::minimax_code::fingerprints(root),
        _ => Ok(HashMap::new()),
    }
}
pub fn inventory(source: &AgentSource) -> Result<Vec<Item>> {
    inventory_with_antigravity_summaries(source, None)
}

pub(crate) fn inventory_with_antigravity_summaries(
    source: &AgentSource,
    mut summaries: Option<&mut HashMap<PathBuf, HashMap<String, String>>>,
) -> Result<Vec<Item>> {
    if source.antigravity_profiles.is_some() {
        let mut items = Vec::new();
        for root in source.scan_roots()? {
            let mut store = source.clone();
            store.antigravity_profiles = None;
            store.data_root = root.parent().unwrap_or(&root).to_owned();
            store.scan_path = root;
            items.extend(inventory_with_antigravity_summaries(
                &store,
                summaries.as_deref_mut(),
            )?);
        }
        return Ok(items);
    }
    if source.agent == "codex" {
        return codex_inventory(source);
    }
    if source.agent == "cursor" {
        return Ok(
            crate::agents::cursor::enumerate_session_keys(&source.scan_path)?
                .into_iter()
                .map(|key| Item {
                    cursor_composer_key: Some(key.composer_key),
                    key: key.id,
                    path: None,
                    activity: key.activity,
                    fingerprint: key.fingerprint,
                    target: false,
                    bytes: 0,
                })
                .collect(),
        );
    }
    let root = crate::agents::session_root(&source.agent, &source.scan_path);
    let keys = match source.agent.as_str() {
        "opencode" | "zcode" => {
            let path = if source.agent == "opencode" {
                source.scan_path.clone()
            } else {
                source.scan_path.join("cli/db/db.sqlite")
            };
            Some(crate::agents::opencode::enumerate_session_keys(
                &path,
                &source.agent,
                source.agent == "opencode",
            )?)
        }
        "deepchat" => Some(crate::agents::deepchat::enumerate_session_keys(
            &source.scan_path,
        )?),
        "cherrystudio" => Some(crate::agents::cherrystudio::enumerate_session_keys(
            &source.scan_path,
        )?),
        "minimax-code" => Some(crate::agents::minimax_code::enumerate_session_keys(
            &source.scan_path,
        )?),
        _ => None,
    };
    if let Some(keys) = keys {
        let database_stamp = database_stamp(source)?.unwrap_or_default();
        let sessions = session_fingerprints(source)?;
        return Ok(keys
            .into_iter()
            .map(|(key, activity)| Item {
                cursor_composer_key: None,
                fingerprint: sessions
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| format!("{activity}:{database_stamp}")),
                key,
                path: None,
                activity,
                target: false,
                bytes: 0,
            })
            .collect());
    }
    if !root.try_exists()? {
        return Ok(Vec::new());
    }
    let mut items = Vec::new();
    let mut context_stamps = Vec::new();
    let context_names: &[&str] = match source.agent.as_str() {
        "kimi-code" => &["session_index.jsonl"],
        "droid" => &["settings.json"],
        "kimi" => &["kimi.json", "config.toml"],
        _ => &[],
    };
    let antigravity_context = if matches!(source.agent.as_str(), "antigravity" | "antigravity-cli")
    {
        let context = crate::agents::antigravity::ContextFingerprints::load(&source.data_root)?;
        if let Some(out) = summaries
            && let Some(fingerprints) = context.summary_fingerprints()
        {
            out.insert(source.data_root.clone(), fingerprints);
        }
        Some(context)
    } else {
        None
    };
    for name in context_names {
        let path = source.data_root.join(name);
        if path.try_exists()? {
            context_stamps.push((path.to_string_lossy().into_owned(), stamp(&path)?.1));
        }
    }
    if source.agent == "dsh" {
        let attachments = source.data_root.join("attachments/v1");
        if attachments.try_exists()? {
            for entry in walkdir::WalkDir::new(attachments).follow_links(false) {
                let entry = entry?;
                if entry.file_type().is_file() {
                    context_stamps.push((
                        entry.path().to_string_lossy().into_owned(),
                        stamp(entry.path())?.1,
                    ));
                }
            }
        }
    }
    let entries = walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .collect::<walkdir::Result<Vec<_>>>()?;
    // Claude Code checks two optional companions per transcript; the walk already lists them.
    let claude_layout = matches!(source.agent.as_str(), "claudecode" | "qoder" | "qoder-cn");
    let files: std::collections::HashSet<&Path> = if claude_layout {
        entries
            .iter()
            .filter(|entry| entry.file_type().is_file())
            .map(walkdir::DirEntry::path)
            .collect()
    } else {
        Default::default()
    };
    let mut index_summaries = HashMap::new();
    for entry in &entries {
        if !entry.file_type().is_file()
            || !crate::agents::is_session_file(&source.agent, &root, entry)?
        {
            continue;
        }
        let metadata = std::fs::metadata(entry.path())?;
        let (mut activity, mut fingerprint) = file_stamp(&metadata)?;
        let mut bytes = metadata.len();
        if source.agent == "pi" {
            fingerprint.push(':');
            fingerprint.push_str(&crate::agents::pi::parent_fingerprint(entry.path(), &root)?);
        }
        if let Some(antigravity_context) = &antigravity_context {
            let id = entry
                .path()
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy();
            fingerprint.push(':');
            fingerprint.push_str(
                &antigravity_context
                    .fingerprint(entry.path().parent().unwrap_or(&source.scan_path), &id)?,
            );
        }
        if claude_layout {
            append_claude_companions(
                entry.path(),
                |candidate| Ok(files.contains(candidate)),
                &mut index_summaries,
                &mut fingerprint,
            )?;
        }
        let path = if matches!(source.agent.as_str(), "kimi" | "kimi-code") {
            crate::agents::kimi::helpers::session_directory(&root, entry.path()).unwrap()
        } else {
            entry.path().to_owned()
        };
        if source.agent == "grok" {
            if let Ok(value) =
                serde_json::from_slice::<serde_json::Value>(&std::fs::read(entry.path())?)
            {
                activity = ["last_active_at", "updated_at", "created_at"]
                    .iter()
                    .find_map(|key| {
                        value[*key]
                            .as_str()
                            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                            .map(|value| value.timestamp_millis() as f64)
                    })
                    .unwrap_or(activity);
            }
            let updates = path.with_file_name("updates.jsonl");
            if updates.try_exists()? {
                fingerprint.push_str(&stamp(&updates)?.1);
                bytes = bytes.saturating_add(std::fs::metadata(&updates)?.len());
            }
        }
        if source.agent == "droid" {
            let settings = path.with_extension("settings.json");
            if settings.try_exists()? {
                fingerprint.push_str(&stamp(&settings)?.1);
            }
        }
        if matches!(source.agent.as_str(), "kimi" | "kimi-code") {
            for suffix in ["context.jsonl", "wire.jsonl", "agents/main/wire.jsonl"] {
                let transcript = path.join(suffix);
                if transcript.try_exists()? {
                    let (time, stamp) = stamp(&transcript)?;
                    activity = activity.max(time);
                    fingerprint.push_str(&stamp);
                    bytes = bytes.saturating_add(std::fs::metadata(&transcript)?.len());
                }
            }
        }
        items.push(Item {
            cursor_composer_key: None,
            key: path.to_string_lossy().into_owned(),
            path: Some(path),
            activity,
            fingerprint,
            target: false,
            bytes,
        });
    }
    context_stamps.sort();
    let context = crate::hash::hex(&Sha256::digest(serde_json::to_vec(&context_stamps)?));
    for item in &mut items {
        item.fingerprint.push_str(&context);
    }
    Ok(items)
}

fn claude_project_dir(path: &Path) -> &Path {
    match crate::agents::claudecode::subagents_dir(path) {
        Some(subagents) => subagents
            .parent()
            .and_then(Path::parent)
            .unwrap_or(subagents),
        None => path.parent().unwrap(),
    }
}

fn claude_index_summaries(path: &Path) -> HashMap<String, Option<serde_json::Value>> {
    let mut summaries = HashMap::new();
    let Ok(bytes) = std::fs::read(path) else {
        return summaries;
    };
    let Ok(index) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return summaries;
    };
    for entry in index["entries"].as_array().into_iter().flatten() {
        let Some(session_id) = entry["sessionId"].as_str() else {
            continue;
        };
        // Match claudecode.rs `.find(|e| e["sessionId"] == id)`: keep only the first entry per id.
        summaries
            .entry(session_id.to_owned())
            .or_insert_with(|| entry.get("summary").cloned());
    }
    summaries
}

fn append_claude_companions(
    path: &Path,
    exists: impl Fn(&Path) -> Result<bool>,
    index_summaries: &mut HashMap<PathBuf, HashMap<String, Option<serde_json::Value>>>,
    fingerprint: &mut String,
) -> Result<()> {
    let index = claude_project_dir(path).join("sessions-index.json");
    let summary = if exists(&index)? {
        let summaries = index_summaries
            .entry(index.clone())
            .or_insert_with(|| claude_index_summaries(&index));
        summaries
            .get(&crate::agents::claudecode::session_id(path))
            .and_then(Option::as_ref)
    } else {
        None
    };
    fingerprint.push(':');
    fingerprint.push_str(&crate::hash::hex(&Sha256::digest(serde_json::to_vec(
        &summary,
    )?)));
    let meta = path.with_extension("meta.json");
    if exists(&meta)? {
        fingerprint.push_str(&stamp(&meta)?.1);
    }
    Ok(())
}

fn codex_titles(data_root: &Path) -> Result<HashMap<String, String>> {
    use std::io::BufRead;
    let mut titles = HashMap::new();
    if let Ok(file) = std::fs::File::open(data_root.join("session_index.jsonl")) {
        for line in std::io::BufReader::new(file).lines() {
            if let Ok(record) = serde_json::from_str::<serde_json::Value>(&line?)
                && let (Some(id), Some(title)) =
                    (record["id"].as_str(), record["thread_name"].as_str())
            {
                titles.insert(id.to_owned(), title.to_owned());
            }
        }
    }
    Ok(titles)
}

fn codex_item(
    logical: PathBuf,
    metadata: &std::fs::Metadata,
    titles: &HashMap<String, String>,
) -> Result<Item> {
    let (activity, mut fingerprint) = file_stamp(metadata)?;
    let stem = logical.file_stem().unwrap_or_default().to_string_lossy();
    let pieces: Vec<_> = stem.split('-').collect();
    let id = pieces[pieces.len().saturating_sub(5)..].join("-");
    fingerprint.push_str(&crate::hash::hex(&Sha256::digest(serde_json::to_vec(
        &titles.get(&id),
    )?)));
    Ok(Item {
        cursor_composer_key: None,
        key: logical.to_string_lossy().into_owned(),
        path: Some(logical),
        activity,
        fingerprint,
        target: false,
        bytes: metadata.len(),
    })
}

fn codex_inventory(source: &AgentSource) -> Result<Vec<Item>> {
    use crate::agents::codex::rollout;
    let titles = codex_titles(&source.data_root)?;
    let mut items = Vec::new();
    for (path, physical) in rollout::files(&source.data_root)? {
        let metadata = match std::fs::metadata(&physical) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        items.push(codex_item(path, &metadata, &titles)?);
    }
    Ok(items)
}

fn path_under_root(root: &Path, path: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(root).ok()?;
    let mut joined = root.to_path_buf();
    let mut pushed = false;
    for component in relative.components() {
        let std::path::Component::Normal(part) = component else {
            return None;
        };
        joined.push(part);
        pushed = true;
    }
    pushed.then_some(joined)
}

/// Builds inventory items for a small batch of modified regular session files without walking the
/// full source tree. Returns `Ok(None)` when any path requires a full inventory scan (deletions,
/// directories, companion/index files, or agents with cross-file dependencies).
pub fn targeted_items(
    source: &AgentSource,
    paths: &[PathBuf],
    known_keys: &std::collections::HashSet<&str>,
) -> Result<Option<Vec<Item>>> {
    if paths.is_empty()
        || (!matches!(source.agent.as_str(), "antigravity" | "antigravity-cli")
            && paths.len() > BATCH_SIZE)
    {
        return Ok(None);
    }
    let empty_context = crate::hash::hex(&Sha256::digest(b"[]"));
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::with_capacity(paths.len());
    match source.agent.as_str() {
        "claudecode" | "qoder" | "qoder-cn" => {
            let root = crate::agents::session_root(&source.agent, &source.scan_path);
            let mut index_summaries = HashMap::new();
            for path in paths {
                let Some(path) = path_under_root(&root, path) else {
                    return Ok(None);
                };
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    return Ok(None);
                };
                if !metadata.file_type().is_file() {
                    return Ok(None);
                }
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let direct = path.parent().and_then(Path::parent) == Some(root.as_path());
                let subagent = crate::agents::claudecode::subagents_dir(&path).is_some();
                if !name.ends_with(".jsonl") || !(direct || subagent) {
                    return Ok(None);
                }
                let key = path.to_string_lossy().into_owned();
                if !seen.insert(key.clone()) {
                    continue;
                }
                let (activity, mut fingerprint) = file_stamp(&metadata)?;
                append_claude_companions(
                    &path,
                    |candidate| Ok(candidate.try_exists()?),
                    &mut index_summaries,
                    &mut fingerprint,
                )?;
                fingerprint.push_str(&empty_context);
                items.push(Item {
                    cursor_composer_key: None,
                    key,
                    path: Some(path),
                    activity,
                    fingerprint,
                    target: false,
                    bytes: metadata.len(),
                });
            }
            Ok(Some(items))
        }
        "gemini-cli" => {
            let root = crate::agents::session_root(&source.agent, &source.scan_path);
            for path in paths {
                let Some(path) = path_under_root(&root, path) else {
                    return Ok(None);
                };
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    return Ok(None);
                };
                if !metadata.file_type().is_file()
                    || !crate::agents::gemini_cli::is_source(&root, &path)
                {
                    return Ok(None);
                }
                let key = path.to_string_lossy().into_owned();
                if !seen.insert(key.clone()) {
                    continue;
                }
                let (activity, mut fingerprint) = file_stamp(&metadata)?;
                fingerprint.push_str(&empty_context);
                items.push(Item {
                    cursor_composer_key: None,
                    key,
                    path: Some(path),
                    activity,
                    fingerprint,
                    target: false,
                    bytes: metadata.len(),
                });
            }
            Ok(Some(items))
        }
        "omp" => {
            let root = crate::agents::session_root(&source.agent, &source.scan_path);
            for path in paths {
                let Some(path) = path_under_root(&root, path) else {
                    return Ok(None);
                };
                let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                    return Ok(None);
                };
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !metadata.file_type().is_file() || !name.ends_with(".jsonl") {
                    return Ok(None);
                }
                let key = path.to_string_lossy().into_owned();
                if !seen.insert(key.clone()) {
                    continue;
                }
                let (activity, mut fingerprint) = file_stamp(&metadata)?;
                fingerprint.push_str(&empty_context);
                items.push(Item {
                    cursor_composer_key: None,
                    key,
                    path: Some(path),
                    activity,
                    fingerprint,
                    target: false,
                    bytes: metadata.len(),
                });
            }
            Ok(Some(items))
        }
        "codex" => {
            use crate::agents::codex::rollout;
            let sessions_dir = source.data_root.join("sessions");
            let archived_dir = source.data_root.join("archived_sessions");
            let mut resolved = Vec::with_capacity(paths.len());
            for path in paths {
                if !rollout::is_rollout(path) {
                    return Ok(None);
                }
                let in_sessions = path.starts_with(&sessions_dir);
                let in_archived = path.starts_with(&archived_dir);
                let base = if in_sessions {
                    &sessions_dir
                } else if in_archived {
                    &archived_dir
                } else {
                    return Ok(None);
                };
                let Some(logical) = path_under_root(base, &rollout::logical_path(path)) else {
                    return Ok(None);
                };
                let key = logical.to_string_lossy().into_owned();
                if in_archived && !known_keys.contains(key.as_str()) {
                    return Ok(None);
                }
                let Some(physical) = rollout::physical_path(&logical)? else {
                    return Ok(None);
                };
                let Ok(metadata) = std::fs::symlink_metadata(&physical) else {
                    return Ok(None);
                };
                if !metadata.file_type().is_file() {
                    return Ok(None);
                }
                if seen.insert(key) {
                    resolved.push((logical, metadata));
                }
            }
            let titles = codex_titles(&source.data_root)?;
            for (logical, metadata) in resolved {
                items.push(codex_item(logical, &metadata, &titles)?);
            }
            Ok(Some(items))
        }
        "antigravity" | "antigravity-cli" => {
            let scan_roots = source.scan_roots()?;
            let mut resolved = Vec::new();
            for path in paths {
                let Some(scan_root) = scan_roots
                    .iter()
                    .find(|root| path_under_root(root, path).is_some())
                else {
                    return Ok(None);
                };
                let raw = path.to_string_lossy();
                let db_path = raw
                    .strip_suffix("-wal")
                    .or_else(|| raw.strip_suffix("-journal"))
                    .map(PathBuf::from)
                    .unwrap_or_else(|| path.to_owned());
                let name = db_path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.ends_with(".db") {
                    if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_file())
                    {
                        continue;
                    }
                    return Ok(None);
                }
                if db_path.parent() != Some(scan_root.as_path()) {
                    return Ok(None);
                }
                let Some(db_path) = path_under_root(scan_root, &db_path) else {
                    return Ok(None);
                };
                let Ok(metadata) = std::fs::symlink_metadata(&db_path) else {
                    return Ok(None);
                };
                if !metadata.file_type().is_file() {
                    return Ok(None);
                }
                let key = db_path.to_string_lossy().into_owned();
                if !seen.insert(key.clone()) {
                    continue;
                }
                if resolved.len() >= BATCH_SIZE {
                    return Ok(None);
                }
                resolved.push((key, db_path, metadata));
            }
            let mut contexts = crate::agents::antigravity::LeafContextBatch::default();
            for (key, db_path, metadata) in resolved {
                let (activity, mut fingerprint) = file_stamp(&metadata)?;
                let Some(conversations) = db_path.parent() else {
                    return Ok(None);
                };
                let id = db_path.file_stem().unwrap_or_default().to_string_lossy();
                fingerprint.push(':');
                let Some(context) = contexts.fingerprint(conversations, &id)? else {
                    return Ok(None);
                };
                fingerprint.push_str(&context);
                fingerprint.push_str(&empty_context);
                items.push(Item {
                    cursor_composer_key: None,
                    key,
                    path: Some(db_path),
                    activity,
                    fingerprint,
                    target: false,
                    bytes: metadata.len(),
                });
            }
            Ok(Some(items))
        }
        _ => Ok(None),
    }
}

#[derive(Default)]
pub struct ItemScope {
    pub paths: std::collections::HashSet<PathBuf>,
    pub keys: std::collections::HashSet<String>,
}
impl ItemScope {
    pub fn new(items: &[Item]) -> Self {
        Self {
            paths: items.iter().filter_map(|item| item.path.clone()).collect(),
            keys: items.iter().map(|item| item.key.clone()).collect(),
        }
    }
}

pub fn target_key(source: &AgentSource, target: &str) -> Result<String> {
    if !matches!(source.agent.as_str(), "opencode" | "zcode") {
        return Ok(target.into());
    }
    let path = if source.agent == "opencode" {
        source.scan_path.clone()
    } else {
        source.scan_path.join("cli/db/db.sqlite")
    };
    if !path.try_exists()? {
        return Ok(target.into());
    }
    let db = crate::agents::open_readonly_sqlite(path)?;
    let v2 = source.agent == "opencode"
        && db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_v2')",
            [],
            |row| row.get::<_, bool>(0),
        )?;
    let sql = if v2 {
        "SELECT id,parent_id FROM session_v2"
    } else {
        "SELECT id,parent_id FROM session"
    };
    let mut statement = db.prepare(sql)?;
    let parents: std::collections::HashMap<String, Option<String>> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut key = target.to_owned();
    let mut visited = std::collections::HashSet::new();
    while visited.insert(key.clone()) {
        if let Some(parent) = parents
            .get(&key)
            .and_then(Option::as_ref)
            .filter(|parent| parents.contains_key(*parent))
        {
            key = parent.clone();
        } else {
            break;
        }
    }
    Ok(key)
}
