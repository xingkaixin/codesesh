use super::codex::ParsedSession;
use crate::{contract::*, pricing::Pricing, projects::path_identity};
use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OpenFlags, types::ValueRef};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

mod content;
mod incremental;
mod paging;
pub use incremental::{DatabaseSnapshot, refresh, refresh_database};
pub use paging::scan_selected_snapshot as refresh_selected_database;
pub use paging::{enumerate_session_keys, scan_selected_database, scan_selected_snapshot};
#[cfg(test)]
mod tests;

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    scan_database(&root.join("opencode.db"), "opencode", true, pricing)
}

pub(super) fn scan_database(
    path: &Path,
    agent: &str,
    supports_v2: bool,
    pricing: &Pricing,
) -> Result<Vec<ParsedSession>> {
    Ok(refresh_database(path, agent, supports_v2, pricing, None)?.sessions)
}

fn table(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |row| row.get(0),
    )?)
}
fn rows(db: &Connection, query: &str) -> Result<Vec<Value>> {
    bound_rows(db, query, [])
}
fn bound_rows(db: &Connection, query: &str, params: impl rusqlite::Params) -> Result<Vec<Value>> {
    let mut stmt = db.prepare(query)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(str::to_owned).collect();
    Ok(stmt
        .query_map(params, |row| {
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(value) => Value::from(value),
                    ValueRef::Real(value) => Value::from(value),
                    ValueRef::Text(value) => {
                        Value::String(String::from_utf8_lossy(value).into_owned())
                    }
                    ValueRef::Blob(value) => {
                        Value::Array(value.iter().copied().map(Value::from).collect())
                    }
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<rusqlite::Result<_>>()?)
}
fn has_v2(db: &Connection) -> Result<bool> {
    if !table(db, "session_v2")? {
        if table(db, "session_message")? {
            bail!("Unsupported pre-split OpenCode V2 database");
        }
        return Ok(false);
    }
    if !table(db, "session_message")? {
        bail!("OpenCode V2 session_message table is missing");
    }
    db.prepare("SELECT id, session_id, type, seq, time_created, time_updated, data FROM session_message LIMIT 0")?;
    if table(db, "session")?
        && db.query_row("SELECT EXISTS(SELECT 1 FROM session)", [], |r| {
            r.get::<_, bool>(0)
        })?
    {
        let state = if table(db, "kv")? {
            rows(db, "SELECT value FROM kv WHERE key='migration.v1-v2'")?
                .first()
                .and_then(|row| row["value"].as_str())
                .map(serde_json::from_str::<Value>)
                .transpose()?
        } else {
            None
        };
        if state.as_ref().and_then(|v| v["phase"].as_str()) != Some("completed") {
            bail!("OpenCode V1 to V2 migration is not complete");
        }
    }
    Ok(true)
}
fn string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}
fn number(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0.0)
}
fn optional_string(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
fn data(row: &Value) -> Result<Value> {
    let value: Value = serde_json::from_str(row["data"].as_str().unwrap_or("{}"))?;
    Ok(if value.is_object() {
        value
    } else {
        Value::Object(Map::new())
    })
}
fn reference(agent: &str, id: String) -> SessionReference {
    SessionReference {
        agent_name: agent.into(),
        session_id: id,
    }
}
fn detail(
    row: &Value,
    agent: &str,
    messages: Vec<Message>,
    stats: SessionStats,
    model_usage: Option<BTreeMap<String, f64>>,
) -> SessionDetail {
    let directory = string(&row["directory"]);
    let (project_identity, signature) = path_identity(&directory);
    let created = number(&row["time_created"]);
    let updated = row
        .get("time_updated")
        .filter(|v| !v.is_null())
        .map(number)
        .unwrap_or(created);
    let title = content::title(&string(&row["title"]))
        .or_else(|| {
            messages
                .iter()
                .filter(|m| m.role == Role::User && m.automated != Some(true))
                .flat_map(|m| &m.parts)
                .find_map(|p| match p {
                    MessagePart::Text { text, .. } => content::title(text),
                    _ => None,
                })
        })
        .unwrap_or_else(|| "Untitled Session".into());
    let parent = optional_string(&row["parent_id"]).filter(|s| !s.is_empty());
    let head = SessionHead {
        version: optional_string(&row["version"]),
        summary_files: row.get("summary_files").filter(|v| !v.is_null()).cloned(),
        reference: reference(agent, string(&row["id"])),
        title,
        directory,
        display_title: None,
        parent_reference: parent.map(|id| reference(agent, id)),
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage,
        smart_tags: super::smart_tags::classify(&messages),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::file_activity::summarize(&head, &messages);
    SessionDetail {
        head,
        messages,
        detail_freshness: "fresh".into(),
        message_cursor: None,
        message_update: None,
        file_activity,
    }
}
fn sort(details: &mut [SessionDetail]) {
    details.sort_by(|a, b| {
        b.head
            .time_updated
            .total_cmp(&a.head.time_updated)
            .then_with(|| b.head.time_created.total_cmp(&a.head.time_created))
            .then_with(|| {
                crate::locale::compare(&b.head.reference.session_id, &a.head.reference.session_id)
            })
    });
}
fn selected_ids(sessions: &[Value], v2: bool, parent_column: bool) -> HashSet<String> {
    let known: HashSet<_> = sessions.iter().map(|s| string(&s["id"])).collect();
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    let mut selected = HashSet::new();
    for row in sessions {
        let id = string(&row["id"]);
        let parent = optional_string(&row["parent_id"]);
        let child = parent.as_ref().filter(|parent| {
            if v2 {
                *parent != &id && known.contains(*parent) && !parent.is_empty()
            } else {
                parent_column
            }
        });
        if let Some(parent) = child {
            children.entry(parent.clone()).or_default().push(id);
        } else if v2 || parent_column || row["task_type"].as_str() != Some("subagent_child") {
            selected.insert(id);
        }
    }
    let mut pending: Vec<_> = selected.iter().cloned().collect();
    while let Some(id) = pending.pop() {
        for child in children.get(&id).into_iter().flatten() {
            if selected.insert(child.clone()) {
                pending.push(child.clone());
            }
        }
    }
    selected
}
fn read_v1(
    db: &Connection,
    agent: &str,
    pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
    changed: &HashSet<String>,
    scope: Option<&HashSet<String>>,
) -> Result<Vec<SessionDetail>> {
    db.prepare("SELECT id,title,time_created,time_updated,slug,directory,version,summary_files FROM session LIMIT 0")?;
    let sessions = paging::scoped_rows(
        db,
        "SELECT * FROM session ORDER BY COALESCE(time_updated,time_created) DESC,time_created DESC,id DESC",
        "id",
        scope,
    )?;
    let columns = rows(db, "PRAGMA table_info(session)")?;
    let selected = selected_ids(
        &sessions,
        false,
        columns.iter().any(|c| c["name"] == "parent_id"),
    );
    let has_messages = table(db, "message")?;
    let mut parts: HashMap<String, Vec<MessagePart>> = HashMap::new();
    let mut messages: HashMap<String, Vec<Message>> = HashMap::new();
    if has_messages {
        let message_rows = paging::scoped_rows(
            db,
            "SELECT * FROM message ORDER BY session_id,time_created,id",
            "session_id",
            Some(changed),
        )?
        .into_iter()
        .filter(|row| {
            selected.contains(&string(&row["session_id"]))
                && changed.contains(&string(&row["session_id"]))
        })
        .collect::<Vec<_>>();
        let message_ids: HashSet<_> = message_rows.iter().map(|row| string(&row["id"])).collect();
        for row in paging::scoped_rows(
            db,
            "SELECT * FROM part ORDER BY message_id,time_created,id",
            "part",
            Some(changed),
        )? {
            if !message_ids.contains(&string(&row["message_id"])) {
                continue;
            }
            let raw = data(&row)?;
            if let Some(part) = content::part(&raw, number(&row["time_created"])) {
                parts
                    .entry(string(&row["message_id"]))
                    .or_default()
                    .push(part);
            }
        }
        for row in message_rows {
            let raw = data(&row)?;
            if content::internal(&raw["type"]) {
                continue;
            }
            let visible = parts.remove(&string(&row["id"])).unwrap_or_default();
            if visible.is_empty() {
                continue;
            }
            messages
                .entry(string(&row["session_id"]))
                .or_default()
                .push(content::v1_message(&row, &raw, visible, pricing));
        }
    }
    let mut result = Vec::new();
    for row in sessions {
        let id = string(&row["id"]);
        if id.is_empty() || !selected.contains(&id) {
            continue;
        }
        if !changed.contains(&id) {
            if let Some(detail) = previous.and_then(|p| p.base_details.get(&id)) {
                result.push(detail.clone());
            }
            continue;
        }
        let messages = messages.remove(&id).unwrap_or_default();
        if has_messages && messages.is_empty() {
            continue;
        }
        let stats = content::stats(&messages);
        result.push(detail(&row, agent, messages, stats, None));
    }
    sort(&mut result);
    Ok(result)
}
fn read_v2(
    db: &Connection,
    _pricing: &Pricing,
    previous: Option<&DatabaseSnapshot>,
    changed: &HashSet<String>,
    scope: Option<&HashSet<String>>,
) -> Result<Vec<SessionDetail>> {
    let sessions = paging::scoped_rows(
        db,
        "SELECT id,parent_id,fork_session_id,title,directory,path,version,summary_files,time_created,time_updated,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write FROM session_v2 ORDER BY time_updated DESC,time_created DESC,id DESC",
        "id",
        scope,
    )?;
    let selected = selected_ids(&sessions, true, true);
    let mut by_session: HashMap<String, Vec<Message>> = HashMap::new();
    for row in paging::scoped_rows(
        db,
        "SELECT id,session_id,type,seq,time_created,time_updated,data FROM session_message ORDER BY session_id,seq",
        "session_id",
        Some(changed),
    )? {
        let id = string(&row["session_id"]);
        if selected.contains(&id)
            && changed.contains(&id)
            && let Some(message) = content::v2_message(&row)?
        {
            by_session.entry(id).or_default().push(message);
        }
    }
    let mut result = Vec::new();
    for row in sessions {
        let id = string(&row["id"]);
        if !selected.contains(&id) {
            continue;
        }
        if !changed.contains(&id) {
            if let Some(detail) = previous.and_then(|p| p.base_details.get(&id)) {
                result.push(detail.clone());
            }
            continue;
        }
        let messages = by_session.remove(&id).unwrap_or_default();
        if messages.is_empty() {
            continue;
        }
        let total = [
            "tokens_input",
            "tokens_output",
            "tokens_reasoning",
            "tokens_cache_read",
            "tokens_cache_write",
        ]
        .iter()
        .map(|key| number(&row[key]))
        .sum::<f64>();
        let stats = SessionStats {
            message_count: messages.len(),
            total_input_tokens: number(&row["tokens_input"]),
            total_output_tokens: number(&row["tokens_output"]),
            total_cost: number(&row["cost"]),
            cost_source: Some(CostSource::Recorded),
            total_tokens: Some(total),
            total_cache_read_tokens: Some(number(&row["tokens_cache_read"])),
            total_cache_create_tokens: Some(number(&row["tokens_cache_write"])),
        };
        let mut usage = BTreeMap::new();
        let mut message_total = 0.0;
        let mut unassigned = 0.0;
        for message in &messages {
            let n = message
                .tokens
                .as_ref()
                .map(content::token_total)
                .unwrap_or(0.0);
            message_total += n;
            if let Some(model) = &message.model {
                *usage.entry(model.clone()).or_insert(0.0) += n;
            } else {
                unassigned += n;
            }
        }
        let mut row = row;
        if row["parent_id"] == row["id"] {
            row["parent_id"] = Value::Null;
        }
        let mut session = detail(
            &row,
            "opencode",
            messages,
            stats,
            (message_total == total && unassigned == 0.0).then_some(usage),
        );
        session.head.summary_files = row.get("summary_files").cloned();
        result.push(session);
    }
    sort(&mut result);
    Ok(result)
}

fn descendant_usage(
    db: &Connection,
    own: &HashMap<String, SessionStats>,
) -> Result<HashMap<String, SessionStats>> {
    if !table(db, "message")? {
        return Ok(HashMap::new());
    }
    let sessions = rows(db, "SELECT * FROM session")?;
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for row in &sessions {
        if let Some(parent) = row["parent_id"].as_str() {
            children
                .entry(parent.into())
                .or_default()
                .push(string(&row["id"]));
        }
    }
    if children.is_empty() {
        return Ok(HashMap::new());
    }
    let mut results = HashMap::new();
    for parent in children.keys() {
        let mut seen = HashSet::from([parent.clone()]);
        let mut pending = children[parent].clone();
        let mut stats = SessionStats::default();
        while let Some(id) = pending.pop() {
            if !seen.insert(id.clone()) {
                continue;
            }
            if let Some(child) = own.get(&id) {
                stats.total_cost += child.total_cost;
                stats.total_input_tokens += child.total_input_tokens;
                stats.total_output_tokens += child.total_output_tokens;
                if child.cost_source == Some(CostSource::Estimated) {
                    stats.cost_source = Some(CostSource::Estimated);
                }
            }
            if let Some(next) = children.get(&id) {
                pending.extend(next.iter().cloned());
            }
        }
        results.insert(parent.clone(), stats);
    }
    Ok(results)
}
