use super::{ParsedSession, deepchat::common, open_readonly_sqlite};
use crate::{model::*, pricing::Pricing};
use anyhow::{Context, Result};
use prost::Message as _;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::BufRead,
    path::{Path, PathBuf},
};

mod proto;

pub fn scan(root: &Path, pricing: &Pricing, agent: &str) -> Result<Vec<ParsedSession>> {
    let mut paths = Vec::new();
    if root.try_exists()? {
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = entry?;
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|ext| ext == "db")
            {
                paths.push(entry.into_path());
            }
        }
    }
    scan_paths(pricing, &paths, agent)
}

pub fn scan_paths(pricing: &Pricing, paths: &[PathBuf], agent: &str) -> Result<Vec<ParsedSession>> {
    let mut stores = BTreeMap::<_, std::collections::BTreeSet<_>>::new();
    for path in paths {
        let conversations = path
            .parent()
            .context("conversation has no parent directory")?;
        let root = conversations
            .parent()
            .context("Antigravity conversation has no store directory")?;
        stores
            .entry((root, conversations))
            .or_default()
            .insert(path);
    }
    let mut sessions = Vec::new();
    for ((root, conversations), paths) in stores {
        let summary_path = root.join("conversation_summaries.db");
        let summaries = if summary_path.try_exists()? {
            let db = open_readonly_sqlite(summary_path)?;
            db.execute_batch("BEGIN")?;
            Some(db)
        } else {
            None
        };
        let mut ctx = StoreContext {
            agent,
            root,
            conversations,
            summaries: summaries.as_ref(),
            history: None,
            resolved: HashMap::new(),
            visited: HashSet::new(),
        };
        for path in paths {
            if path.try_exists()?
                && let Some(session) = parse(path, &mut ctx, pricing)?
            {
                sessions.push(session);
            }
        }
    }
    Ok(sessions)
}

struct StoreContext<'a> {
    agent: &'a str,
    root: &'a Path,
    conversations: &'a Path,
    summaries: Option<&'a Connection>,
    history: Option<HashMap<String, String>>,
    resolved: HashMap<String, String>,
    visited: HashSet<String>,
}

impl StoreContext<'_> {
    fn history_workspace(&mut self, id: &str) -> Result<Option<&str>> {
        if self.history.is_none() {
            self.history = Some(history_workspaces(self.root)?);
        }
        Ok(self
            .history
            .as_ref()
            .and_then(|history| history.get(id).map(String::as_str)))
    }
}

#[derive(Default)]
struct Summary {
    title: String,
    workspaces: String,
    modified: String,
    parent: String,
    agent_name: String,
}

pub(crate) struct ContextFingerprints {
    summaries: HashMap<String, Summary>,
    history: HashMap<String, String>,
}

impl ContextFingerprints {
    pub(crate) fn load(root: &Path) -> Result<Self> {
        let mut summaries = HashMap::new();
        let summary_path = root.join("conversation_summaries.db");
        if summary_path.try_exists()? {
            let db = open_readonly_sqlite(summary_path)?;
            db.execute_batch("BEGIN")?;
            let has_table: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries')",
                [],
                |row| row.get(0),
            )?;
            if has_table {
                let mut query = db.prepare(
                    "SELECT conversation_id,title,workspace_uris,last_modified_time,parent_conversation_id,agent_name FROM conversation_summaries",
                )?;
                let mut rows = query.query([])?;
                while let Some(row) = rows.next()? {
                    let id: String = row.get(0)?;
                    summaries.insert(
                        id,
                        Summary {
                            title: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                            workspaces: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                            modified: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                            parent: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                            agent_name: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                        },
                    );
                }
            }
        }
        let history = history_workspaces(root)?;
        Ok(Self { summaries, history })
    }

    pub(crate) fn fingerprint(&self, root: &Path, id: &str) -> Result<String> {
        hash_conversation_context(root, id, |key| self.summaries.get(key), &self.history)
    }
}

pub(crate) fn leaf_context_fingerprint(conversations: &Path, id: &str) -> Result<Option<String>> {
    let root = conversations
        .parent()
        .context("conversation directory has no store")?;
    let mut summaries = HashMap::new();
    let summary_path = root.join("conversation_summaries.db");
    if summary_path.try_exists()? {
        let db = open_readonly_sqlite(summary_path)?;
        db.execute_batch("BEGIN")?;
        let has_table: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_summaries')",
            [],
            |row| row.get(0),
        )?;
        if has_table {
            if db.query_row("SELECT EXISTS(SELECT 1 FROM conversation_summaries WHERE parent_conversation_id=?1)", [id], |row| row.get::<_, bool>(0))? {
                return Ok(None);
            }
            let mut current = Some(id.to_owned());
            while let Some(key) = current.take() {
                if summaries.contains_key(&key) {
                    break;
                }
                if let Some(summary) = query_summary(&db, &key)? {
                    let next = (!summary.parent.is_empty() && summary.parent != key)
                        .then(|| summary.parent.clone());
                    summaries.insert(key, summary);
                    current = next;
                }
            }
        }
    }
    let history = history_workspaces(root)?;
    hash_conversation_context(conversations, id, |key| summaries.get(key), &history).map(Some)
}

fn hash_str(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value.as_bytes());
}

fn hash_opt_str(hash: &mut Sha256, value: Option<&str>) {
    match value {
        Some(value) => {
            hash.update([1]);
            hash_str(hash, value);
        }
        None => hash.update([0]),
    }
}

fn hash_conversation_files(hash: &mut Sha256, conversations: &Path, id: &str) -> Result<()> {
    for suffix in [".db", ".db-wal", ".db-journal"] {
        let path = conversations.join(format!("{id}{suffix}"));
        let metadata = match path.metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        hash_str(hash, suffix);
        hash_str(hash, &crate::hash::file_stamp(&metadata)?.1);
        #[cfg(windows)]
        {
            // NTFS can preserve creation time when a different file takes the same name.
            let handle = winapi_util::Handle::from_path(&path)?;
            let info = winapi_util::file::information(&handle)?;
            hash.update(info.volume_serial_number().to_le_bytes());
            hash.update(info.file_index().to_le_bytes());
        }
    }
    Ok(())
}

fn hash_conversation_context<'a>(
    root: &Path,
    id: &str,
    summary_for: impl Fn(&str) -> Option<&'a Summary>,
    history: &HashMap<String, String>,
) -> Result<String> {
    let mut hash = Sha256::new();
    hash_conversation_files(&mut hash, root, id)?;
    let own = summary_for(id);
    match own {
        Some(summary) => {
            hash.update([1]);
            hash_str(&mut hash, &summary.title);
            hash_str(&mut hash, &summary.workspaces);
            hash_str(&mut hash, &summary.modified);
            hash_str(&mut hash, &summary.parent);
            hash_str(&mut hash, &summary.agent_name);
        }
        None => hash.update([0]),
    }
    hash_opt_str(&mut hash, history.get(id).map(String::as_str));
    let mut visited = HashSet::new();
    visited.insert(id);
    let mut parent = own
        .map(|summary| summary.parent.as_str())
        .filter(|parent| !parent.is_empty());
    while let Some(ancestor) = parent {
        if !visited.insert(ancestor) {
            break;
        }
        hash_str(&mut hash, ancestor);
        hash_conversation_files(&mut hash, root, ancestor)?;
        hash_opt_str(&mut hash, history.get(ancestor).map(String::as_str));
        if let Some(summary) = summary_for(ancestor) {
            hash.update([1]);
            hash_str(&mut hash, &summary.workspaces);
            hash_str(&mut hash, &summary.parent);
            parent = (!summary.parent.is_empty()).then_some(summary.parent.as_str());
        } else {
            hash.update([0]);
            break;
        }
    }
    Ok(crate::hash::hex(&hash.finalize()))
}

fn query_summary(db: &Connection, id: &str) -> Result<Option<Summary>> {
    Ok(db
        .query_row(
            "SELECT title,workspace_uris,last_modified_time,parent_conversation_id,agent_name FROM conversation_summaries WHERE conversation_id=?1",
            [id],
            |row| {
                Ok(Summary {
                    title: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    workspaces: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    modified: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    parent: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    agent_name: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                })
            },
        )
        .optional()?)
}

fn load_summary(summaries: Option<&Connection>, id: &str) -> Result<Summary> {
    Ok(summaries
        .map(|db| query_summary(db, id))
        .transpose()?
        .flatten()
        .unwrap_or_default())
}

fn parse(
    path: &Path,
    ctx: &mut StoreContext<'_>,
    pricing: &Pricing,
) -> Result<Option<ParsedSession>> {
    let id = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let summary = load_summary(ctx.summaries, &id)?;
    let mut candidates = serde_json::from_str::<Vec<String>>(&summary.workspaces)
        .ok()
        .map(|uris| workspace_paths(uris, path))
        .unwrap_or_default();
    let time = match chrono::DateTime::parse_from_str(&summary.modified, "%Y-%m-%d %H:%M:%S%.f%:z")
    {
        Ok(time) => time.timestamp_millis() as f64,
        Err(_) => crate::time::file_mtime_ms(path)?,
    };
    let db = open_readonly_sqlite(path)?;
    db.execute_batch("BEGIN")?;
    if candidates.is_empty() {
        candidates = trajectory_workspaces(&db, path)?;
    }
    let normalized_candidates: Vec<String> = candidates
        .iter()
        .map(|candidate| crate::projects::normalize_project_directory(candidate))
        .collect();
    let mut direct_hits = vec![0usize; candidates.len()];
    let mut command_hits = vec![0usize; candidates.len()];
    let models = model_names(&db, path)?;
    let mut statement = db
        .prepare("SELECT idx,step_type,status,step_payload,error_details FROM steps ORDER BY idx")
        .with_context(|| format!("unsupported Antigravity database {}", path.display()))?;
    let mut rows = statement.query([])?;
    let mut messages = Vec::new();
    let mut title = summary.title;
    let mut unsupported = 0;
    let mut stats = SessionStats::default();
    let mut model_usage = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut pending = Vec::new();
    while let Some(row) = rows.next()? {
        let index: i64 = row.get(0)?;
        let kind: i64 = row.get(1)?;
        let status: i64 = row.get(2)?;
        let Some(payload) = row.get_ref(3)?.as_blob_or_null()? else {
            unsupported += 1;
            continue;
        };
        let step = proto::Step::decode(payload)
            .with_context(|| format!("invalid Antigravity step {index} in {}", path.display()))?;
        let output = tool_output(&step, kind);
        let error = row
            .get_ref(4)?
            .as_blob_or_null()?
            .map(proto::ErrorDetails::decode)
            .transpose()
            .with_context(|| {
                format!(
                    "invalid Antigravity error at step {index} in {}",
                    path.display()
                )
            })?
            .and_then(tool_error)
            .or_else(|| step.error.and_then(tool_error));
        let metadata = step.metadata.unwrap_or_default();
        let created = metadata
            .created
            .filter(|created| created.seconds > 0)
            .map(|created| created.seconds as f64 * 1000.0 + f64::from(created.nanos / 1_000_000))
            .unwrap_or(time);
        let step_model = metadata.model.and_then(|model| {
            model
                .api_name
                .filter(|name| !name.is_empty())
                .or_else(|| model.name.filter(|name| !name.is_empty()))
        });
        // Retries can switch models; step metadata names only the primary request.
        for (usage, fallback_model) in metadata
            .usage
            .into_iter()
            .map(|usage| (usage, step_model.clone()))
            .chain(
                metadata
                    .retries
                    .into_iter()
                    .filter_map(|retry| retry.usage)
                    .map(|usage| (usage, None)),
            )
        {
            let Some(tokens) = tokens(&usage) else {
                continue;
            };
            let ids = [
                ("response", usage.response_id),
                ("provider", usage.provider_message_id),
                ("message", usage.message_id),
            ]
            .into_iter()
            .filter_map(|(kind, id)| Some(format!("{kind}:{}", id.filter(|id| !id.is_empty())?)));
            // Record every id without short-circuiting so later copies sharing any id are skipped.
            if !ids.fold(true, |fresh, id| seen.insert(id) && fresh) {
                continue;
            }
            let model = match usage.model_id {
                Some(id) => models.get(&id).cloned(),
                None => fallback_model,
            };
            pending.push((index, created, model, tokens));
        }
        let part = match kind {
            14 => step.user.and_then(|user| {
                if candidates.len() > 1 {
                    record_user_context(&user, &normalized_candidates, &mut direct_hits);
                }
                user_prompt_text(user).map(|text| (Role::User, common::text(text, None)))
            }),
            15 => step
                .assistant
                .and_then(|value| value.text)
                .filter(|text| !text.is_empty())
                .map(|text| (Role::Assistant, common::text(text, None))),
            23 => {
                if let Some(value) = step
                    .title
                    .and_then(|title| title.text)
                    .filter(|text| !text.is_empty())
                {
                    title = value;
                }
                continue;
            }
            _ => None,
        };
        let mut subagent_id = None;
        let part = part.or_else(|| {
            let call = metadata.call?;
            let name = call
                .name
                .filter(|name| !name.is_empty())
                .or(call.secondary_name)?;
            let input = call
                .input
                .map(|input| serde_json::from_str(&input).unwrap_or(Value::String(input)));
            if error.is_none() {
                subagent_id = swarm_child_id(&name, input.as_ref(), output.as_deref());
            }
            if candidates.len() > 1
                && let Some(input) = &input
            {
                record_tool_input(
                    input,
                    "",
                    0,
                    &normalized_candidates,
                    &mut direct_hits,
                    &mut command_hits,
                );
            }
            Some((
                Role::Assistant,
                MessagePart::Tool {
                    tool: name,
                    call_id: call.id,
                    title: None,
                    time_created: None,
                    state: Box::new(ToolState {
                        status: if error.is_some() {
                            ToolPartStatus::Error
                        } else {
                            ToolPartStatus::Unknown
                        },
                        input,
                        output: output.map(Value::String),
                        error: error.map(Value::String),
                        metadata: Some(
                            json!({"antigravity_step_type":kind,"antigravity_status":status}),
                        ),
                    }),
                },
            ))
        });
        if let Some((role, part)) = part {
            let mut message = common::message(format!("{id}:{index}"), role, created, vec![part]);
            message.subagent_id = subagent_id;
            if message.role == Role::Assistant {
                message.agent = Some(ctx.agent.into());
                attach(
                    &mut message,
                    &mut pending,
                    pricing,
                    &mut stats,
                    &mut model_usage,
                );
            }
            messages.push(message);
        } else {
            unsupported += 1;
        }
    }
    if let Some(&(index, created, ..)) = pending.first() {
        let mut message = common::message(
            format!("{id}:{index}:usage"),
            Role::Assistant,
            created,
            Vec::new(),
        );
        message.agent = Some(ctx.agent.into());
        attach(
            &mut message,
            &mut pending,
            pricing,
            &mut stats,
            &mut model_usage,
        );
        messages.push(message);
    }
    if messages.is_empty() && unsupported == 0 {
        return Ok(None);
    }
    ctx.visited.insert(id.clone());
    let resolved = resolve_directory(
        &id,
        &summary.parent,
        &candidates,
        &normalized_candidates,
        &direct_hits,
        &command_hits,
        ctx,
    );
    ctx.visited.remove(&id);
    let directory = resolved?;
    ctx.resolved.insert(id.clone(), directory.clone());
    let prompt = messages
        .iter()
        .find(|message| message.role == Role::User)
        .and_then(|message| message.parts.first())
        .and_then(|part| match part {
            MessagePart::Text { text, .. } => Some(text.as_str()),
            _ => None,
        });
    let agent_name =
        (!summary.parent.is_empty() && summary.parent != id).then_some(summary.agent_name.as_str());
    let title = common::title(&[Some(&title), agent_name, prompt]);
    stats.message_count = messages.len();
    let times = messages.iter().map(|message| message.time_created);
    let created = times.clone().fold(time, f64::min);
    let updated = times.fold(time, f64::max);
    let mut session = common::finish(
        path,
        ctx.agent,
        id.clone(),
        title,
        directory,
        created,
        updated,
        (!summary.parent.is_empty() && summary.parent != id).then_some(summary.parent),
        stats,
        (!model_usage.is_empty()).then_some(model_usage),
        messages,
    );
    let notice = format!(
        "Partial Antigravity import: {unsupported} unsupported steps. Numeric tool statuses remain unknown; explicit results and errors are retained."
    );
    session.head.summary_files = Some(Value::String(notice));
    session.detail.head = session.head.clone();
    Ok(Some(session))
}

fn tool_output(step: &proto::Step, kind: i64) -> Option<String> {
    match kind {
        132 => step.tool.as_ref()?.result.as_ref()?.text.clone(),
        8 => step.view_file.as_ref()?.content.clone(),
        21 => step.run_command.as_ref()?.output.as_ref()?.text.clone(),
        38 => step.mcp.as_ref()?.result.clone(),
        _ => None,
    }
    .filter(|text| !text.is_empty())
}

fn tool_error(error: proto::ErrorDetails) -> Option<String> {
    let mut parts = Vec::new();
    for text in [error.message, error.details].into_iter().flatten() {
        if !text.trim().is_empty() && !parts.contains(&text) {
            parts.push(text);
        }
    }
    (!parts.is_empty()).then(|| parts.join("\n"))
}

fn swarm_child_id(tool: &str, input: Option<&Value>, output: Option<&str>) -> Option<String> {
    if tool != "swarm" || input?.get("action")?.as_str()? != "add" {
        return None;
    }
    let output = output?;
    let body = if output.starts_with("Created At: ") {
        let (_, rest) = output.split_once('\n')?;
        rest.strip_prefix("Completed At: ")?.split_once('\n')?.1
    } else {
        output
    };
    let result: Value = serde_json::from_str(body).ok()?;
    if result.get("status")?.as_str()? != "added" {
        return None;
    }
    result
        .get("conversation_id")?
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
}

fn user_prompt_text(user: proto::UserPrompt) -> Option<String> {
    user.text.filter(|text| !text.is_empty()).or_else(|| {
        let joined: String = user
            .items
            .into_iter()
            .filter_map(|item| item.text)
            .collect();
        (!joined.is_empty()).then_some(joined)
    })
}

fn record_user_context(
    user: &proto::UserPrompt,
    normalized_candidates: &[String],
    direct_hits: &mut [usize],
) {
    for item in &user.items {
        if let Some(context) = &item.context {
            for uri in [&context.file, &context.directory]
                .into_iter()
                .flatten()
                .filter_map(|target| target.uri.as_deref())
            {
                if let Some(idx) = match_candidate(uri, normalized_candidates) {
                    direct_hits[idx] += 1;
                }
            }
        }
    }
}

fn workspace_paths(uris: impl IntoIterator<Item = String>, conversation: &Path) -> Vec<String> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    for uri in uris {
        let Some(path) = url::Url::parse(&uri)
            .ok()
            .and_then(|url| url.to_file_path().ok())
        else {
            continue;
        };
        let mut value = path.to_string_lossy().into_owned();
        while value.len() > 1 && value.ends_with(['/', '\\']) && !is_windows_root(&value) {
            value.pop();
        }
        if !value.is_empty() && seen.insert(value.clone()) {
            paths.push(value);
        }
    }
    if paths.len() > 1 {
        paths.retain(|workspace| !is_t3_shared_attachments(conversation, workspace));
    }
    paths
}

fn is_t3_shared_attachments(conversation: &Path, workspace: &str) -> bool {
    let workspace = Path::new(workspace);
    let Some(store) = conversation.parent().and_then(Path::parent) else {
        return false;
    };
    workspace.ends_with("userdata/attachments")
        && store.ends_with("antigravity-acp")
        && workspace.parent().is_some_and(|userdata| {
            store.parent().and_then(Path::parent)
                == Some(userdata.join("providers/antigravity").as_path())
        })
}

fn is_windows_root(path: &str) -> bool {
    path.len() == 3
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && matches!(path.as_bytes()[2], b'/' | b'\\')
}

fn trajectory_workspaces(db: &Connection, path: &Path) -> Result<Vec<String>> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_metadata_blob')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(Vec::new());
    }
    let mut statement = db.prepare("SELECT data FROM trajectory_metadata_blob")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let data = row.get_ref(0)?.as_blob()?;
        let metadata = proto::TrajectoryMetadata::decode(data).with_context(|| {
            format!(
                "invalid Antigravity workspace metadata in {}",
                path.display()
            )
        })?;
        let directories = workspace_paths(metadata.workspaces, path);
        if !directories.is_empty() {
            return Ok(directories);
        }
    }
    Ok(Vec::new())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryEntry {
    conversation_id: Option<String>,
    workspace: Option<String>,
}

fn history_workspaces(root: &Path) -> Result<HashMap<String, String>> {
    let path = root.join("history.jsonl");
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error.into()),
    };
    let mut workspaces = HashMap::new();
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else {
            continue;
        };
        let Ok(entry) = serde_json::from_str::<HistoryEntry>(&line) else {
            continue;
        };
        if let (Some(id), Some(workspace)) = (
            entry.conversation_id.filter(|s| !s.is_empty()),
            entry.workspace.filter(|s| !s.is_empty()),
        ) {
            workspaces.insert(id, workspace);
        }
    }
    Ok(workspaces)
}

fn lexical_abs_path(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let path = if trimmed.starts_with("file://") {
        url::Url::parse(trimmed)
            .ok()?
            .to_file_path()
            .ok()?
            .to_string_lossy()
            .into_owned()
    } else if trimmed.starts_with('/')
        || trimmed.starts_with("\\\\")
        || (trimmed.as_bytes().get(1) == Some(&b':')
            && matches!(trimmed.as_bytes().get(2), Some(b'/' | b'\\')))
    {
        trimmed.to_owned()
    } else {
        return None;
    };
    Some(crate::projects::normalize_project_directory(&path))
}

fn match_candidate(raw: &str, normalized_candidates: &[String]) -> Option<usize> {
    let path = lexical_abs_path(raw)?;
    normalized_candidates
        .iter()
        .enumerate()
        .filter(|(_, cand)| {
            !cand.is_empty()
                && (path == **cand
                    || path
                        .strip_prefix(cand.as_str())
                        .is_some_and(|rest| rest.starts_with(['/', '\\']))
                    || (cand.ends_with(['/', '\\']) && path.starts_with(cand.as_str())))
        })
        .min_by(|(left_idx, left), (right_idx, right)| {
            right
                .len()
                .cmp(&left.len())
                .then_with(|| left_idx.cmp(right_idx))
        })
        .map(|(idx, _)| idx)
}

fn record_tool_input(
    value: &Value,
    key: &str,
    depth: usize,
    normalized_candidates: &[String],
    direct_hits: &mut [usize],
    command_hits: &mut [usize],
) {
    if depth > 4 {
        return;
    }
    match value {
        Value::Object(map) => {
            for (child_key, child) in map {
                record_tool_input(
                    child,
                    child_key,
                    depth + 1,
                    normalized_candidates,
                    direct_hits,
                    command_hits,
                );
            }
        }
        Value::Array(items) => {
            for item in items {
                record_tool_input(
                    item,
                    key,
                    depth + 1,
                    normalized_candidates,
                    direct_hits,
                    command_hits,
                );
            }
        }
        Value::String(text) => {
            let lower = key.trim().to_ascii_lowercase();
            if lower.contains("command") {
                let mut order: Vec<usize> = (0..normalized_candidates.len())
                    .filter(|&i| !normalized_candidates[i].is_empty())
                    .collect();
                order.sort_by(|&a, &b| {
                    normalized_candidates[b]
                        .len()
                        .cmp(&normalized_candidates[a].len())
                        .then_with(|| a.cmp(&b))
                });
                let mut matched_spans: Vec<(usize, usize)> = Vec::new();
                let bytes = text.as_bytes();
                for idx in order {
                    let cand = &normalized_candidates[idx];
                    let mut search_from = 0;
                    while let Some(rel) = text[search_from..].find(cand.as_str()) {
                        let start = search_from + rel;
                        let end = start + cand.len();
                        let overlaps = matched_spans.iter().any(|&(s, e)| start < e && end > s);
                        let left_ok = start == 0
                            || b" \t\r\n\"'=:;([".contains(&bytes[start - 1])
                            || text[..start].ends_with("file://");
                        let right_ok =
                            end == text.len() || b"/\\ \t\r\n\"';&|)]:".contains(&bytes[end]);
                        if !overlaps && left_ok && right_ok {
                            command_hits[idx] += 1;
                            matched_spans.push((start, end));
                            search_from = end;
                        } else {
                            search_from =
                                start + text[start..].chars().next().map_or(1, char::len_utf8);
                        }
                    }
                }
            } else if (lower.contains("path")
                || lower.contains("file")
                || lower.contains("dir")
                || matches!(lower.as_str(), "cwd" | "workdir"))
                && let Some(idx) = match_candidate(text, normalized_candidates)
            {
                direct_hits[idx] += 1;
            }
        }
        _ => {}
    }
}

fn unique_winner(scores: &[usize]) -> Option<usize> {
    let max = *scores.iter().max()?;
    if max == 0 {
        return None;
    }
    let mut winner = None;
    for (index, &score) in scores.iter().enumerate() {
        if score == max {
            if winner.is_some() {
                return None;
            }
            winner = Some(index);
        }
    }
    winner
}

fn resolve_directory(
    id: &str,
    parent: &str,
    candidates: &[String],
    normalized_candidates: &[String],
    direct_hits: &[usize],
    command_hits: &[usize],
    ctx: &mut StoreContext<'_>,
) -> Result<String> {
    if candidates.is_empty() {
        return Ok(String::new());
    }
    if candidates.len() == 1 {
        return Ok(candidates[0].clone());
    }
    if let Some(idx) = ctx
        .history_workspace(id)?
        .and_then(|ws| match_candidate(ws, normalized_candidates))
    {
        return Ok(candidates[idx].clone());
    }
    if let Some(idx) = unique_winner(direct_hits) {
        return Ok(candidates[idx].clone());
    }
    if let Some(idx) = unique_winner(command_hits) {
        return Ok(candidates[idx].clone());
    }
    if !parent.is_empty() && parent != id {
        if let Some(idx) = ctx
            .history_workspace(parent)?
            .and_then(|ws| match_candidate(ws, normalized_candidates))
        {
            return Ok(candidates[idx].clone());
        }
        if let Some(parent_dir) = resolve_parent_directory(parent, ctx)?
            && let Some(idx) = match_candidate(&parent_dir, normalized_candidates)
        {
            return Ok(candidates[idx].clone());
        }
    }
    Ok(candidates[0].clone())
}

fn resolve_parent_directory(parent_id: &str, ctx: &mut StoreContext<'_>) -> Result<Option<String>> {
    if let Some(dir) = ctx.resolved.get(parent_id) {
        return Ok(Some(dir.clone()));
    }
    if !ctx.visited.insert(parent_id.to_owned()) {
        return Ok(None);
    }
    let result = resolve_uncached_directory(parent_id, ctx);
    ctx.visited.remove(parent_id);
    let directory = result?;
    if let Some(directory) = &directory {
        ctx.resolved.insert(parent_id.to_owned(), directory.clone());
    }
    Ok(directory)
}

fn resolve_uncached_directory(
    parent_id: &str,
    ctx: &mut StoreContext<'_>,
) -> Result<Option<String>> {
    let path = ctx.conversations.join(format!("{parent_id}.db"));
    if !path.try_exists()? {
        return Ok(None);
    }
    let summary = load_summary(ctx.summaries, parent_id)?;
    let mut candidates = serde_json::from_str::<Vec<String>>(&summary.workspaces)
        .ok()
        .map(|uris| workspace_paths(uris, &path))
        .unwrap_or_default();
    let db = open_readonly_sqlite(&path)?;
    db.execute_batch("BEGIN")?;
    if candidates.is_empty() {
        candidates = trajectory_workspaces(&db, &path)?;
    }
    if candidates.len() <= 1 {
        return Ok(Some(candidates.into_iter().next().unwrap_or_default()));
    }
    let normalized_candidates: Vec<String> = candidates
        .iter()
        .map(|candidate| crate::projects::normalize_project_directory(candidate))
        .collect();
    if let Some(idx) = ctx
        .history_workspace(parent_id)?
        .and_then(|ws| match_candidate(ws, &normalized_candidates))
    {
        return Ok(Some(candidates[idx].clone()));
    }
    let mut direct_hits = vec![0usize; candidates.len()];
    let mut command_hits = vec![0usize; candidates.len()];
    let mut statement = db
        .prepare("SELECT idx,step_type,step_payload FROM steps ORDER BY idx")
        .with_context(|| format!("unsupported Antigravity database {}", path.display()))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let index: i64 = row.get(0)?;
        let kind: i64 = row.get(1)?;
        let Some(payload) = row.get_ref(2)?.as_blob_or_null()? else {
            continue;
        };
        let step = proto::Step::decode(payload)
            .with_context(|| format!("invalid Antigravity step {index} in {}", path.display()))?;
        if kind == 23 {
            continue;
        }
        let has_text = match kind {
            14 => {
                if let Some(user) = step.user {
                    record_user_context(&user, &normalized_candidates, &mut direct_hits);
                    user_prompt_text(user).is_some()
                } else {
                    false
                }
            }
            15 => step
                .assistant
                .and_then(|value| value.text)
                .is_some_and(|text| !text.is_empty()),
            _ => false,
        };
        if !has_text
            && let Some(call) = step.metadata.and_then(|metadata| metadata.call)
            && call
                .name
                .filter(|name| !name.is_empty())
                .or(call.secondary_name)
                .is_some()
            && let Some(raw_input) = call.input
        {
            let input = serde_json::from_str(&raw_input).unwrap_or(Value::String(raw_input));
            record_tool_input(
                &input,
                "",
                0,
                &normalized_candidates,
                &mut direct_hits,
                &mut command_hits,
            );
        }
    }
    Ok(Some(resolve_directory(
        parent_id,
        &summary.parent,
        &candidates,
        &normalized_candidates,
        &direct_hits,
        &command_hits,
        ctx,
    )?))
}

fn model_names(db: &Connection, path: &Path) -> Result<HashMap<u64, String>> {
    let mut statement = db
        .prepare("SELECT data FROM gen_metadata WHERE data IS NOT NULL")
        .with_context(|| format!("unsupported Antigravity database {}", path.display()))?;
    let mut rows = statement.query([])?;
    let mut models = HashMap::new();
    while let Some(row) = rows.next()? {
        let data = row.get_ref(0)?.as_blob()?;
        let chat = proto::Generation::decode(data)
            .with_context(|| {
                format!(
                    "invalid Antigravity generation metadata in {}",
                    path.display()
                )
            })?
            .chat
            .unwrap_or_default();
        if let (Some(id), Some(model)) = (chat.model_id, chat.model.filter(|m| !m.is_empty())) {
            models.insert(id, model);
        }
    }
    Ok(models)
}

// The struct update keeps this literal compiling when MessageTokens gains fields.
#[allow(clippy::needless_update)]
fn tokens(usage: &proto::Usage) -> Option<MessageTokens> {
    let input = usage.input as f64 + usage.cache_read as f64 + usage.cache_create as f64;
    let output = usage
        .visible_output
        .max(usage.total_output.saturating_sub(usage.reasoning)) as f64;
    let reasoning = usage.reasoning as f64;
    (input + output + reasoning > 0.0).then_some(MessageTokens {
        input: Some(input),
        output: Some(output),
        reasoning: Some(reasoning),
        cache_read: Some(usage.cache_read as f64),
        cache_create: Some(usage.cache_create as f64),
        ..Default::default()
    })
}

fn attach(
    message: &mut Message,
    pending: &mut Vec<(i64, f64, Option<String>, MessageTokens)>,
    pricing: &Pricing,
    stats: &mut SessionStats,
    model_usage: &mut BTreeMap<String, f64>,
) {
    if pending.is_empty() {
        return;
    }
    let mut tokens = common::empty_tokens();
    let mut cost = 0.0;
    for (_, _, model, usage) in pending.drain(..) {
        let reasoning = usage.reasoning.unwrap_or(0.0);
        let total = usage.input.unwrap_or(0.0) + usage.output.unwrap_or(0.0) + reasoning;
        let estimate =
            pricing.estimate_tracked(model.as_deref(), &usage, 0.0, &mut message.cost_inputs);
        let source = estimate.map(|_| CostSource::Estimated);
        common::add_stats(
            stats,
            &usage,
            total,
            estimate.unwrap_or(0.0),
            source.clone(),
        );
        // Session output includes reasoning so total tokens reconcile as input + output.
        stats.total_output_tokens += reasoning;
        common::add_tokens(&mut tokens, &usage);
        cost += estimate.unwrap_or(0.0);
        message.cost_source = message.cost_source.take().or(source);
        if let Some(model) = model {
            *model_usage.entry(model.clone()).or_default() += total;
            message.model = Some(model);
        }
    }
    stats
        .cost_inputs
        .extend(message.cost_inputs.iter().cloned());
    message.tokens = Some(tokens);
    message.cost = Some(cost);
}

#[cfg(test)]
mod tests;
