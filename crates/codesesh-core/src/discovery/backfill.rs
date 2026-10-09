use super::AgentSource;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

pub const BATCH_SIZE: usize = 32;
#[derive(Clone, Debug)]
pub struct Item {
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
    stamp_metadata(&std::fs::metadata(path)?)
}
fn stamp_metadata(metadata: &std::fs::Metadata) -> Result<(f64, String)> {
    let time = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut stamp = format!(
        "{}:{}:{}",
        metadata.len(),
        time.as_secs(),
        time.subsec_nanos()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        stamp.push_str(&format!(
            ":{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        stamp.push_str(&format!(
            ":{}:{}",
            metadata.creation_time(),
            metadata.file_attributes()
        ));
    }
    Ok((time.as_secs_f64() * 1000.0, stamp))
}
/// File state of a database-backed source; `None` for file-backed sources.
pub fn database_stamp(source: &AgentSource) -> Result<Option<String>> {
    let database = match source.agent.as_str() {
        "cursor" => source.scan_path.join("globalStorage/state.vscdb"),
        "opencode" => source.scan_path.clone(),
        "zcode" => source.scan_path.join("cli/db/db.sqlite"),
        "deepchat" => source.scan_path.join("app_db/agent.db"),
        "cherrystudio" => source.scan_path.join("Data/cherrystudio.sqlite"),
        "minimax-code" => source.scan_path.join("v2/sqlite/runtime-state.sqlite"),
        _ => return Ok(None),
    };
    let mut database_stamp = String::new();
    for suffix in ["", "-wal", "-journal"] {
        let path = PathBuf::from(format!("{}{suffix}", database.to_string_lossy()));
        if path.try_exists()? {
            database_stamp.push_str(&stamp(&path)?.1);
        }
    }
    Ok(Some(database_stamp))
}
/// Per-session content fingerprints, so writes that leave a session untouched do not invalidate it.
/// Cursor pages never reuse items and keep the database stamp.
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
    if source.agent == "codex" {
        return codex_inventory(source);
    }
    let root = if source.agent == "dsh" {
        source.scan_path.join("sessions")
    } else {
        source.scan_path.clone()
    };
    let keys = match source.agent.as_str() {
        "cursor" => Some(
            crate::agents::cursor::enumerate_session_keys(&source.scan_path)?
                .into_iter()
                .map(|key| (key.id, key.activity))
                .collect::<Vec<_>>(),
        ),
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
        "antigravity-cli" => &[
            "conversation_summaries.db",
            "conversation_summaries.db-wal",
            "conversation_summaries.db-journal",
        ],
        "kimi-code" => &["session_index.jsonl"],
        "kimi" => &["kimi.json", "config.toml"],
        _ => &[],
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
    let files: std::collections::HashSet<&Path> = if source.agent == "claudecode" {
        entries
            .iter()
            .filter(|entry| entry.file_type().is_file())
            .map(walkdir::DirEntry::path)
            .collect()
    } else {
        Default::default()
    };
    let mut index_stamps = std::collections::HashMap::new();
    for entry in &entries {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        let selected = match source.agent.as_str() {
            "claudecode" => {
                name.ends_with(".jsonl")
                    && (entry.depth() == 2
                        || entry
                            .path()
                            .parent()
                            .and_then(Path::file_name)
                            .is_some_and(|name| name == "subagents"))
            }
            "pi" => name.ends_with(".jsonl"),
            "antigravity-cli" => name.ends_with(".db"),
            "grok" => name == "summary.json",
            "dsh" => {
                entry.depth() == 3
                    && matches!(name.as_ref(), "session.jsonl" | "session.jsonl.zstd")
            }
            "kimi" => {
                entry.depth() == 3
                    && (name == "state.json"
                        || name == "metadata.json"
                            && !entry.path().with_file_name("state.json").exists())
            }
            "kimi-code" => {
                entry.depth() == 3
                    && name == "state.json"
                    && entry
                        .path()
                        .parent()
                        .unwrap()
                        .join("agents/main/wire.jsonl")
                        .exists()
            }
            _ => false,
        };
        if !selected {
            continue;
        }
        let metadata = std::fs::metadata(entry.path())?;
        let (mut activity, mut fingerprint) = stamp_metadata(&metadata)?;
        let mut bytes = metadata.len();
        if source.agent == "antigravity-cli" {
            for suffix in ["-wal", "-journal"] {
                let related = PathBuf::from(format!("{}{suffix}", entry.path().to_string_lossy()));
                if related.try_exists()? {
                    fingerprint.push_str(&stamp(&related)?.1);
                }
            }
        }
        if source.agent == "claudecode" {
            let parent = entry.path().parent().unwrap();
            let project = if parent.file_name().is_some_and(|name| name == "subagents") {
                parent.parent().and_then(Path::parent).unwrap_or(parent)
            } else {
                parent
            };
            let index = project.join("sessions-index.json");
            if files.contains(index.as_path()) {
                if !index_stamps.contains_key(&index) {
                    let value = stamp(&index)?.1;
                    index_stamps.insert(index.clone(), value);
                }
                fingerprint.push_str(&index_stamps[&index]);
            }
            let meta = entry.path().with_extension("meta.json");
            if files.contains(meta.as_path()) {
                fingerprint.push_str(&stamp(&meta)?.1);
            }
        }
        let path = if matches!(source.agent.as_str(), "kimi" | "kimi-code") {
            entry.path().parent().unwrap().to_owned()
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

fn codex_inventory(source: &AgentSource) -> Result<Vec<Item>> {
    use crate::agents::codex_rollout;
    use std::io::BufRead;
    let mut titles = std::collections::HashMap::new();
    if let Ok(file) = std::fs::File::open(source.data_root.join("session_index.jsonl")) {
        for line in std::io::BufReader::new(file).lines() {
            if let Ok(record) = serde_json::from_str::<serde_json::Value>(&line?)
                && let (Some(id), Some(title)) =
                    (record["id"].as_str(), record["thread_name"].as_str())
            {
                titles.insert(id.to_owned(), title.to_owned());
            }
        }
    }
    let mut items = Vec::new();
    for (path, physical) in codex_rollout::files(&source.data_root)? {
        let metadata = match std::fs::metadata(&physical) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let (activity, mut fingerprint) = stamp_metadata(&metadata)?;
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        let pieces: Vec<_> = stem.split('-').collect();
        let id = pieces[pieces.len().saturating_sub(5)..].join("-");
        fingerprint.push_str(&crate::hash::hex(&Sha256::digest(serde_json::to_vec(
            &titles.get(&id),
        )?)));
        items.push(Item {
            key: path.to_string_lossy().into_owned(),
            path: Some(path),
            activity,
            fingerprint,
            target: false,
            bytes: metadata.len(),
        });
    }
    Ok(items)
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
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
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
