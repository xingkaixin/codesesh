mod checkpoints;
mod exec;
mod parser;
mod patch;
pub(crate) mod rollout;
mod tool_events;
mod usage;

use super::{ParsedSession, jsonl::timestamp};
use crate::{model::*, pricing::Pricing};
use anyhow::Result;
pub use checkpoints::Checkpoints;
use parser::Parser;
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
    sync::LazyLock,
};
use usage::Usage;
use walkdir::WalkDir;

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let mut titles = HashMap::new();
    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        let mut lines = super::jsonl::JsonLines::new(file);
        while let Ok(Some(line)) = lines.next_line() {
            if let Ok(record) = serde_json::from_str::<Value>(line)
                && let (Some(id), Some(title)) =
                    (record["id"].as_str(), record["thread_name"].as_str())
            {
                titles.insert(id.to_owned(), title.to_owned());
            }
        }
    }
    let mut sessions = Vec::new();
    for path in rollout::paths(root)? {
        if let Some(detail) = parse(&path, &titles, pricing)? {
            sessions.push(ParsedSession {
                source: path,
                head: detail.head.clone(),
                detail,
            });
        }
    }
    merge_children(&mut sessions, pricing, None, &[], None)?;
    sessions.sort_by(|a, b| {
        b.detail
            .head
            .time_updated
            .total_cmp(&a.detail.head.time_updated)
            .then_with(|| {
                a.detail
                    .head
                    .reference
                    .session_id
                    .cmp(&b.detail.head.reference.session_id)
            })
    });
    Ok(sessions)
}

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    paths: &[PathBuf],
    previous: &[crate::agents::SessionRecord],
    checkpoints: &mut Checkpoints,
) -> Result<super::ScanDelta> {
    if paths.iter().any(|path| {
        path.file_name()
            .is_some_and(|name| name == "session_index.jsonl")
            || path == root
    }) {
        let upserts = scan(root, pricing)?;
        for old in previous {
            if rollout::physical_path(&old.source)?.is_some()
                && !upserts.iter().any(|session| session.source == old.source)
            {
                anyhow::bail!("Codex source is incomplete: {}", old.source.display());
            }
        }
        let ids: std::collections::HashSet<_> = upserts
            .iter()
            .map(|session| session.head.reference.clone())
            .collect();
        let removed = previous
            .iter()
            .filter(|session| !ids.contains(&session.head.reference))
            .map(|session| session.head.reference.clone())
            .collect();
        return Ok(super::ScanDelta {
            upserts,
            removed,
            complete: true,
        });
    }
    let mut files = std::collections::HashSet::<PathBuf>::new();
    for path in paths {
        if path.is_dir() {
            for entry in WalkDir::new(path) {
                let entry = entry?;
                if entry.file_type().is_file() && rollout::is_rollout(entry.path()) {
                    files.insert(rollout::logical_path(entry.path()));
                }
            }
        } else if rollout::is_rollout(path) {
            files.insert(rollout::logical_path(path));
        }
    }
    for session in previous {
        if paths.iter().any(|path| session.source.starts_with(path)) {
            files.insert(session.source.clone());
        }
    }
    let mut titles = HashMap::new();
    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        let mut lines = super::jsonl::JsonLines::new(file);
        while let Some(line) = lines.next_line()? {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && let (Some(id), Some(title)) =
                    (value["id"].as_str(), value["thread_name"].as_str())
            {
                titles.insert(id.into(), title.into());
            }
        }
    }
    let mut affected = std::collections::HashSet::<String>::new();
    for session in previous
        .iter()
        .filter(|session| files.contains(&session.source))
    {
        affected.insert(session.head.reference.session_id.clone());
        if let Some(parent) = &session.head.parent_reference {
            affected.insert(parent.session_id.clone());
        }
    }
    let mut changed = Vec::new();
    for file in &files {
        if rollout::physical_path(file)?.is_some()
            && let Some(detail) = checkpoints.parse(file, &titles, pricing)?
        {
            affected.insert(detail.head.reference.session_id.clone());
            if let Some(parent) = &detail.head.parent_reference {
                affected.insert(parent.session_id.clone());
            }
            changed.push(ParsedSession {
                source: file.clone(),
                head: detail.head.clone(),
                detail,
            });
        } else if rollout::physical_path(file)?.is_some()
            && previous.iter().any(|session| session.source == *file)
        {
            anyhow::bail!("Codex source is incomplete: {}", file.display());
        }
    }
    for session in previous.iter().filter(|session| {
        affected.contains(&session.head.reference.session_id) && !files.contains(&session.source)
    }) {
        if rollout::physical_path(&session.source)?.is_some() {
            if let Some(detail) = checkpoints.parse(&session.source, &titles, pricing)? {
                changed.push(ParsedSession {
                    source: session.source.clone(),
                    head: detail.head.clone(),
                    detail,
                });
            } else {
                anyhow::bail!("Codex source is incomplete: {}", session.source.display());
            }
        }
    }
    let mut all = changed;
    merge_children(
        &mut all,
        pricing,
        Some(&affected),
        previous,
        Some(&mut checkpoints.children),
    )?;
    let upserts: Vec<_> = all
        .into_iter()
        .filter(|session| affected.contains(&session.head.reference.session_id))
        .collect();
    let current: std::collections::HashSet<_> = upserts
        .iter()
        .map(|session| session.head.reference.clone())
        .collect();
    let removed = previous
        .iter()
        .filter(|session| {
            affected.contains(&session.head.reference.session_id)
                && !current.contains(&session.head.reference)
        })
        .map(|session| session.head.reference.clone())
        .collect();
    Ok(super::ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}

fn merge_children(
    sessions: &mut [ParsedSession],
    pricing: &Pricing,
    selected: Option<&std::collections::HashSet<String>>,
    previous: &[crate::agents::SessionRecord],
    mut cache: Option<&mut HashMap<PathBuf, ChildSummary>>,
) -> Result<()> {
    let mut children = HashMap::<String, Vec<(SessionStats, Option<Message>)>>::new();
    let current: std::collections::HashSet<_> =
        sessions.iter().map(|s| &s.head.reference).collect();
    let records = sessions
        .iter()
        .map(|s| (&s.head, s.source.as_path()))
        .chain(
            previous
                .iter()
                .filter(|s| {
                    !current.contains(&s.head.reference)
                        && selected.is_none_or(|ids| !ids.contains(&s.head.reference.session_id))
                })
                .map(|s| (&s.head, s.source.as_path())),
        );
    for (head, source) in records {
        if let Some(parent) = &head.parent_reference
            && selected.is_none_or(|ids| ids.contains(&parent.session_id))
        {
            let summary = match cache.as_deref_mut() {
                Some(cache) => cached_child_summary(cache, head, source, pricing)?,
                None => child_summary(head, source, pricing)?,
            };
            children
                .entry(parent.session_id.clone())
                .or_default()
                .push(summary);
        }
    }
    if let Some(cache) = cache {
        let known: std::collections::HashSet<_> = sessions
            .iter()
            .map(|session| &session.source)
            .chain(previous.iter().map(|session| &session.source))
            .collect();
        cache.retain(|source, _| known.contains(source));
    }
    for session in sessions {
        if selected.is_some_and(|ids| !ids.contains(&session.head.reference.session_id)) {
            continue;
        }
        let Some(summaries) = children.get_mut(&session.head.reference.session_id) else {
            continue;
        };
        summaries.sort_by(|(_, a), (_, b)| {
            a.as_ref()
                .map(|m| m.time_created)
                .unwrap_or(0.0)
                .total_cmp(&b.as_ref().map(|m| m.time_created).unwrap_or(0.0))
        });
        for (stats, message) in summaries.iter() {
            session.detail.head.stats.total_input_tokens += stats.total_input_tokens;
            session.detail.head.stats.total_output_tokens += stats.total_output_tokens;
            session.detail.head.stats.total_cost += stats.total_cost;
            session
                .detail
                .head
                .stats
                .cost_inputs
                .extend(stats.cost_inputs.iter().cloned());
            if let Some(count) = stats.total_cache_read_tokens.filter(|count| *count != 0.0) {
                *session
                    .detail
                    .head
                    .stats
                    .total_cache_read_tokens
                    .get_or_insert(0.0) += count;
            }
            if let Some(message) = message {
                let text = message.parts.iter().find_map(|part| match part {
                    MessagePart::Text { text, .. } => Some(text),
                    _ => None,
                });
                let exists = session.detail.messages.iter().any(|visible| {
                    message.subagent_id.is_some() && message.subagent_id == visible.subagent_id
                        || message.nickname.is_some() && message.nickname == visible.nickname && visible.parts.iter().any(|part| matches!(part, MessagePart::Text {text:existing,..} if Some(existing)==text))
                });
                if !exists {
                    session.detail.messages.push(message.clone());
                }
            }
        }
        session
            .detail
            .messages
            .sort_by(|a, b| a.time_created.total_cmp(&b.time_created));
        session.detail.head.stats.message_count = session.detail.messages.len();
    }
    Ok(())
}

struct ChildSummary {
    physical: PathBuf,
    len: u64,
    modified: std::time::SystemTime,
    generation: u64,
    summary: (SessionStats, Option<Message>),
}

// A parent refresh re-summarizes every child; unchanged children would be read in full each time.
fn cached_child_summary(
    cache: &mut HashMap<PathBuf, ChildSummary>,
    head: &SessionHead,
    source: &Path,
    pricing: &Pricing,
) -> Result<(SessionStats, Option<Message>)> {
    let physical = rollout::physical_path(source)?.unwrap_or_else(|| rollout::logical_path(source));
    let metadata = std::fs::metadata(&physical)?;
    let modified = metadata.modified()?;
    if let Some(entry) = cache.get(source)
        && entry.physical == physical
        && entry.len == metadata.len()
        && entry.modified == modified
        && entry.generation == pricing.generation()
    {
        return Ok(entry.summary.clone());
    }
    let summary = child_summary(head, source, pricing)?;
    cache.insert(
        source.to_owned(),
        ChildSummary {
            physical,
            len: metadata.len(),
            modified,
            generation: pricing.generation(),
            summary: summary.clone(),
        },
    );
    Ok(summary)
}

fn child_summary(
    head: &SessionHead,
    source: &Path,
    pricing: &Pricing,
) -> Result<(SessionStats, Option<Message>)> {
    let mut usage = Usage::default();
    let mut model = None;
    let mut service_tier = None;
    let mut nickname = None;
    let mut meta_seen = false;
    let mut latest = None;
    let mut final_output = None;
    let (reader, physical) = rollout::open(source)?;
    let fallback = crate::time::file_mtime_ms(&physical)?;
    let mut lines = super::jsonl::JsonLines::new(reader);
    while let Some(line) = lines.next_line()? {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let payload = &record["payload"];
        match record["type"].as_str().unwrap_or("") {
            "session_meta" | "turn_context" => {
                if let Some(value) = payload["model"]
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                {
                    model = Some(value.trim().to_owned());
                }
                // A forked rollout replays its parent's session_meta later in the file.
                if record["type"] == "session_meta" && !meta_seen {
                    meta_seen = true;
                    nickname = payload["agent_nickname"].as_str().map(str::to_owned);
                    usage = Usage::new(payload);
                }
                if record["type"] == "turn_context" {
                    usage.turn(payload);
                }
            }
            "event_msg" if payload["type"] == "thread_settings_applied" => {
                if let Some(tier) = payload["thread_settings"]["service_tier"].as_str() {
                    service_tier = Some(tier.to_owned());
                }
            }
            "event_msg" if payload["type"] == "token_count" => usage.consume(
                payload,
                model.as_deref(),
                service_tier.as_deref(),
                pricing,
                &mut [],
            ),
            "token_usage_record" => usage.record(payload),
            "compacted" => usage.compacted(
                payload,
                model.as_deref(),
                service_tier.as_deref(),
                pricing,
                &mut [],
            ),
            "response_item" if payload["type"] == "message" && payload["role"] == "assistant" => {
                let text = clean(&content(payload, true));
                if text.is_empty() {
                    continue;
                }
                let time = timestamp(&record);
                let time = if time != 0.0 {
                    time
                } else {
                    let time = timestamp(payload);
                    if time != 0.0 { time } else { fallback }
                };
                let mut output = message(
                    Role::Assistant,
                    MessagePart::Text {
                        text,
                        time_created: Some(time),
                    },
                    time,
                    None,
                );
                output.id = payload["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("codex-subagent-{}", head.reference.session_id));
                output.subagent_id = Some(head.reference.session_id.clone());
                output.nickname = nickname.clone();
                if record["phase"] == "final_answer" || payload["phase"] == "final_answer" {
                    final_output = Some(output.clone());
                }
                latest = Some(output);
            }
            _ => {}
        }
    }
    Ok((usage.stats(0), final_output.or(latest)))
}

fn clean(text: &str) -> String {
    let text = super::message_text::strip_tags(text);
    static TRAILING_SPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)[ \t]+(\r?$)").unwrap());
    static TRAILING_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:\r?\n)+$").unwrap());
    let text = TRAILING_SPACE.replace_all(&text, "$1");
    TRAILING_LINES.replace_all(&text, "").into_owned()
}

fn content(payload: &Value, assistant: bool) -> String {
    match &payload["content"] {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                if assistant && item["type"] != "output_text" {
                    return None;
                }
                item["text"].as_str().or_else(|| item.as_str())
            })
            .collect::<Vec<_>>()
            .join(if assistant { "\n" } else { " " }),
        Value::String(text) if !assistant => text.clone(),
        _ => String::new(),
    }
}

pub fn parse(
    path: &Path,
    titles: &HashMap<String, String>,
    pricing: &Pricing,
) -> Result<Option<SessionDetail>> {
    let (reader, physical) = rollout::open(path)?;
    let mut lines = super::jsonl::JsonLines::new(reader);
    let Some(line) = lines.next_line()? else {
        return Ok(None);
    };
    let Some(mut parser) = Parser::new(path, &physical, line)? else {
        return Ok(None);
    };
    parser.feed(line, pricing);
    while let Some(line) = lines.next_line()? {
        parser.feed(line, pricing);
    }
    Ok(parser.finish(titles))
}

fn message(role: Role, part: MessagePart, time: f64, model: Option<String>) -> Message {
    let agent = (role == Role::Assistant).then(|| "codex".into());
    Message {
        cost_inputs: Vec::new(),
        cost_breakdown: None,
        id: String::new(),
        role,
        agent,
        time_created: time,
        time_completed: None,
        mode: None,
        model,
        provider: None,
        tokens: None,
        cost: Some(0.0),
        cost_source: None,
        parts: vec![part],
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}

#[cfg(test)]
mod tests;
