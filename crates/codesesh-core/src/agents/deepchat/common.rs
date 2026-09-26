use crate::{agents::codex::ParsedSession, contract::*, projects::path_identity};
use anyhow::Result;
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Map, Value, json};
use std::path::Path;

pub fn rows(db: &Connection, sql: &str) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| (*s).into())
        .collect();
    let result = statement
        .query_map([], |row| {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into()),
                    ValueRef::Blob(_) => Value::Null,
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(result)
}
pub fn s(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}
pub fn n(value: &Value) -> f64 {
    value.as_f64().unwrap_or(0.0)
}
pub fn nonnegative(value: &Value) -> f64 {
    n(value).max(0.0)
}
pub fn parse(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| value.clone())
}
pub fn strict_parse(value: &Value) -> Result<Value> {
    Ok(if let Some(s) = value.as_str() {
        serde_json::from_str(s)?
    } else {
        value.clone()
    })
}
pub fn text(text: impl Into<String>, time: Option<f64>) -> MessagePart {
    MessagePart::Text {
        text: text.into(),
        time_created: time,
    }
}
pub fn title(values: &[Option<&str>]) -> String {
    for value in values.iter().flatten() {
        let value = clean(value);
        if let Some(line) = value.lines().find(|line| !line.trim().is_empty()) {
            let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
            return String::from_utf16_lossy(
                &normalized.encode_utf16().take(100).collect::<Vec<_>>(),
            );
        }
    }
    "Untitled Session".into()
}
pub fn message(id: String, role: Role, time: f64, parts: Vec<MessagePart>) -> Message {
    Message {
        id,
        role,
        agent: None,
        time_created: time,
        time_completed: None,
        mode: None,
        model: None,
        provider: None,
        tokens: None,
        cost: None,
        cost_source: None,
        parts,
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}
#[allow(clippy::too_many_arguments)]
pub fn finish(
    source: &Path,
    agent: &str,
    id: String,
    title: String,
    directory: String,
    created: f64,
    updated: f64,
    parent: Option<String>,
    stats: SessionStats,
    model_usage: Option<std::collections::BTreeMap<String, f64>>,
    messages: Vec<Message>,
) -> ParsedSession {
    let (project_identity, signature) = path_identity(&directory);
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: agent.into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: parent.map(|session_id| SessionReference {
            agent_name: agent.into(),
            session_id,
        }),
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage,
        smart_tags: super::super::smart_tags::classify(&messages),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::super::file_activity::summarize(&head, &messages);
    ParsedSession {
        source: source.into(),
        head: head.clone(),
        detail: SessionDetail {
            head,
            messages,
            detail_freshness: "fresh".into(),
            message_cursor: None,
            message_update: None,
            file_activity,
        },
    }
}
pub fn add_tokens(base: &mut MessageTokens, other: &MessageTokens) {
    for (left, right) in [
        (&mut base.input, other.input),
        (&mut base.output, other.output),
        (&mut base.reasoning, other.reasoning),
        (&mut base.cache_read, other.cache_read),
        (&mut base.cache_create, other.cache_create),
    ] {
        if let Some(right) = right {
            *left = Some(left.unwrap_or(0.0) + right);
        }
    }
}
pub fn empty_tokens() -> MessageTokens {
    MessageTokens {
        input: None,
        output: None,
        reasoning: None,
        cache_read: None,
        cache_create: None,
    }
}
pub fn add_stats(
    stats: &mut SessionStats,
    tokens: &MessageTokens,
    total: f64,
    cost: f64,
    source: Option<CostSource>,
) {
    stats.total_input_tokens += tokens.input.unwrap_or(0.0);
    stats.total_output_tokens += tokens.output.unwrap_or(0.0);
    stats.total_tokens = Some(stats.total_tokens.unwrap_or(0.0) + total);
    stats.total_cache_read_tokens =
        Some(stats.total_cache_read_tokens.unwrap_or(0.0) + tokens.cache_read.unwrap_or(0.0));
    stats.total_cache_create_tokens =
        Some(stats.total_cache_create_tokens.unwrap_or(0.0) + tokens.cache_create.unwrap_or(0.0));
    stats.total_cost += cost;
    if source == Some(CostSource::Estimated) || stats.cost_source.is_none() {
        stats.cost_source = source;
    }
}

pub fn clean(text: &str) -> String {
    use regex::Regex;
    use std::sync::LazyLock;
    static SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)[ \t]+(\r?$)").unwrap());
    static LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:\r?\n)+$").unwrap());
    let text = super::super::message_text::strip_tags(text);
    let text = SPACE.replace_all(&text, "$1");
    let text = LINES.replace_all(&text, "");
    if text.trim().is_empty() {
        String::new()
    } else {
        text.into_owned()
    }
}
fn clean_value(value: &mut Value) {
    match value {
        Value::String(s) => *s = clean(s),
        Value::Array(values) => {
            for value in values {
                clean_value(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                clean_value(value);
            }
        }
        _ => {}
    }
}
pub fn clean_part(mut part: MessagePart) -> Option<MessagePart> {
    match &mut part {
        MessagePart::Text { text, .. }
        | MessagePart::Reasoning { text, .. }
        | MessagePart::Plan { text, .. } => {
            *text = clean(text);
            if text.is_empty() {
                return None;
            }
        }
        MessagePart::Tool { title, state, .. } => {
            *title = title.as_ref().map(|t| clean(t)).filter(|t| !t.is_empty());
            for value in [
                &mut state.input,
                &mut state.output,
                &mut state.error,
                &mut state.metadata,
            ]
            .into_iter()
            .flatten()
            {
                clean_value(value);
            }
        }
        _ => {}
    }
    Some(part)
}

pub fn reachable_sessions<'a>(
    parents: impl Iterator<Item = (&'a str, Option<&'a str>)>,
) -> std::collections::HashSet<String> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let parents: HashMap<_, _> = parents.collect();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut queue = VecDeque::new();
    for (id, parent) in &parents {
        if let Some(parent) = parent.filter(|p| parents.contains_key(p)) {
            children.entry(parent).or_default().push(id);
        } else {
            queue.push_back(*id);
        }
    }
    let mut selected = HashSet::new();
    while let Some(id) = queue.pop_front() {
        if selected.insert(id.to_owned()) {
            queue.extend(children.get(id).into_iter().flatten().copied());
        }
    }
    selected
}

pub fn selected_query(
    sql: &str,
    column: &str,
    selected: Option<&std::collections::HashSet<String>>,
) -> String {
    let Some(selected) = selected else {
        return sql.into();
    };
    let mut ids: Vec<_> = selected
        .iter()
        .map(|id| format!("'{}'", id.replace('\'', "''")))
        .collect();
    ids.sort();
    let condition = if ids.is_empty() {
        "0".into()
    } else {
        format!("{column} IN ({})", ids.join(","))
    };
    let split = sql
        .find(" ORDER BY ")
        .or_else(|| sql.find(" GROUP BY "))
        .unwrap_or(sql.len());
    let (head, tail) = sql.split_at(split);
    format!(
        "{head} {} {condition}{tail}",
        if head.contains(" WHERE ") {
            "AND"
        } else {
            "WHERE"
        }
    )
}
pub fn fingerprints(
    db: &Connection,
    queries: &[(&str, &str)],
) -> Result<std::collections::HashMap<String, String>> {
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    let mut hashes: HashMap<String, Sha256> = HashMap::new();
    for (sql, key) in queries {
        for row in rows(db, sql)? {
            if let Some(id) = row[*key].as_str() {
                let bytes = serde_json::to_vec(&row)?;
                let hash = hashes.entry(id.into()).or_default();
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            }
        }
    }
    Ok(hashes
        .into_iter()
        .map(|(id, hash)| (id, crate::hash::hex(&hash.finalize())))
        .collect())
}

pub fn selected_fingerprints(
    db: &Connection,
    queries: &[(&str, &str)],
    column: &str,
    selected: Option<&std::collections::HashSet<String>>,
) -> Result<std::collections::HashMap<String, String>> {
    let queries: Vec<_> = queries
        .iter()
        .map(|(sql, key)| (selected_query(sql, column, selected), *key))
        .collect();
    let borrowed: Vec<_> = queries
        .iter()
        .map(|(sql, key)| (sql.as_str(), *key))
        .collect();
    fingerprints(db, &borrowed)
}
