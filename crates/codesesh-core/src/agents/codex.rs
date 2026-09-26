use super::codex_usage::Usage;
use crate::pricing::Pricing;
use crate::{contract::*, projects::path_identity};
use anyhow::{Context, Result};
use chrono::DateTime;
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::File,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::LazyLock,
};
use walkdir::WalkDir;

#[derive(Clone, Debug)]
pub struct ParsedSession {
    pub head: SessionHead,
    pub source: PathBuf,
    pub detail: SessionDetail,
}

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let sessions_root = root.join("sessions");
    if !sessions_root.exists() {
        return Ok(Vec::new());
    }
    let mut titles = HashMap::new();
    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if let Ok(record) = serde_json::from_str::<Value>(&line)
                && let (Some(id), Some(title)) =
                    (record["id"].as_str(), record["thread_name"].as_str())
            {
                titles.insert(id.to_owned(), title.to_owned());
            }
        }
    }
    let mut sessions = Vec::new();
    for entry in WalkDir::new(sessions_root).follow_links(false) {
        let entry = entry.context("enumerating Codex sources")?;
        let name = entry.file_name().to_string_lossy();
        if !entry.file_type().is_file()
            || !name.starts_with("rollout-")
            || !name.ends_with(".jsonl")
        {
            continue;
        }
        if let Some(detail) = parse(entry.path(), &titles, pricing)? {
            sessions.push(ParsedSession {
                source: entry.into_path(),
                head: detail.head.clone(),
                detail,
            });
        }
    }
    merge_children(&mut sessions, pricing, None, &[])?;
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
) -> Result<super::ScanDelta> {
    if paths.iter().any(|path| {
        path.file_name()
            .is_some_and(|name| name == "session_index.jsonl")
            || path == root
    }) {
        let upserts = scan(root, pricing)?;
        for old in previous {
            if old.source.try_exists()?
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
                if entry.file_type().is_file()
                    && entry.file_name().to_string_lossy().starts_with("rollout-")
                    && entry.path().extension().is_some_and(|ext| ext == "jsonl")
                {
                    files.insert(entry.into_path());
                }
            }
        } else if path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("rollout-"))
        {
            files.insert(path.clone());
        }
    }
    for session in previous {
        if paths.iter().any(|path| session.source.starts_with(path)) {
            files.insert(session.source.clone());
        }
    }
    let mut titles = HashMap::new();
    if let Ok(file) = File::open(root.join("session_index.jsonl")) {
        for line in BufReader::new(file).lines() {
            if let Ok(value) = serde_json::from_str::<Value>(&line?)
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
        if file.try_exists()?
            && let Some(detail) = parse(file, &titles, pricing)?
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
        } else if file.try_exists()? && previous.iter().any(|session| session.source == *file) {
            anyhow::bail!("Codex source is incomplete: {}", file.display());
        }
    }
    for session in previous.iter().filter(|session| {
        affected.contains(&session.head.reference.session_id) && !files.contains(&session.source)
    }) {
        if session.source.try_exists()? {
            if let Some(detail) = parse(&session.source, &titles, pricing)? {
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
    merge_children(&mut all, pricing, Some(&affected), previous)?;
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
            children
                .entry(parent.session_id.clone())
                .or_default()
                .push(child_summary(head, source, pricing)?);
        }
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
        let tags = super::smart_tags::classify(&session.detail.messages);
        session.head.smart_tags = tags.clone();
        session.detail.head.smart_tags = tags;
    }
    Ok(())
}

fn child_summary(
    head: &SessionHead,
    source: &Path,
    pricing: &Pricing,
) -> Result<(SessionStats, Option<Message>)> {
    let mut usage = Usage::default();
    let mut model = None;
    let mut nickname = None;
    let mut latest = None;
    let mut final_output = None;
    let fallback = crate::time::file_mtime_ms(source)?;
    for line in BufReader::new(File::open(source)?).lines() {
        let Ok(record) = serde_json::from_str::<Value>(&line?) else {
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
                if record["type"] == "session_meta" {
                    nickname = payload["agent_nickname"].as_str().map(str::to_owned);
                }
            }
            "event_msg" if payload["type"] == "token_count" => {
                usage.consume(payload, model.as_deref(), pricing, &mut [])
            }
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

pub fn timestamp(record: &Value) -> f64 {
    if let Some(value) = record["timestamp"].as_f64() {
        return value;
    }
    let Some(value) = record["timestamp"].as_str() else {
        return 0.0;
    };
    let mut value = value.trim().replacen(' ', "T", 1);
    static SUFFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:Z|[+-]\d{2}:?\d{2})$").unwrap());
    if !SUFFIX.is_match(&value) {
        value.push('Z');
    }
    DateTime::parse_from_rfc3339(&value)
        .or_else(|_| DateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .map(|date| date.timestamp_millis() as f64)
        .unwrap_or(0.0)
}

fn internal(value: &Value) -> bool {
    matches!(
        value
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase()
            .replace(['_', '-'], " ")
            .as_str(),
        "progress" | "file history snapshot" | "queue operation" | "last prompt"
    )
}

fn clean(text: &str) -> String {
    let text = super::message_text::strip_tags(text);
    static TRAILING_SPACE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?m)[ \t]+(\r?$)").unwrap());
    static TRAILING_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:\r?\n)+$").unwrap());
    let text = TRAILING_SPACE.replace_all(&text, "$1");
    TRAILING_LINES.replace_all(&text, "").into_owned()
}

fn developer_message(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "agents.md instructions for",
        "<instructions>",
        "<environment_context>",
        "<permissions instructions>",
        "<collaboration_mode>",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn title(text: &str) -> Option<String> {
    let cleaned = clean(text);
    let line = cleaned.lines().find(|line| !line.trim().is_empty())?;
    let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(
        String::from_utf16_lossy(&words.encode_utf16().take(100).collect::<Vec<_>>())
            .trim()
            .to_owned(),
    )
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

fn projected_record(line: &str) -> serde_json::Result<Value> {
    #[derive(serde::Deserialize)]
    struct Record<'a> {
        #[serde(default, rename = "type")]
        kind: Value,
        #[serde(default)]
        timestamp: Value,
        #[serde(borrow)]
        payload: Option<&'a serde_json::value::RawValue>,
    }
    #[derive(Default, serde::Deserialize)]
    struct Header {
        #[serde(default, rename = "type")]
        kind: Value,
        #[serde(default)]
        timestamp: Value,
        #[serde(default)]
        model: Value,
    }
    let Ok(record) = serde_json::from_str::<Record<'_>>(line) else {
        return serde_json::from_str(line);
    };
    let raw = record.payload.map_or("null", |payload| payload.get());
    let header = if raw == "null" {
        Header::default()
    } else if let Ok(header) = serde_json::from_str::<Header>(raw) {
        header
    } else {
        return serde_json::from_str(line);
    };
    let payload = if !internal(&record.kind)
        && !internal(&header.kind)
        && (record.kind == "response_item"
            || (record.kind == "event_msg" && header.kind == "token_count"))
    {
        serde_json::from_str(raw)?
    } else {
        serde_json::json!({"type":header.kind,"timestamp":header.timestamp,"model":header.model})
    };
    Ok(serde_json::json!({"type":record.kind,"timestamp":record.timestamp,"payload":payload}))
}

pub fn parse(
    path: &Path,
    titles: &HashMap<String, String>,
    pricing: &Pricing,
) -> Result<Option<SessionDetail>> {
    let file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut lines = super::jsonl::JsonLines::new(file);
    let Some(line) = lines.next_line()? else {
        return Ok(None);
    };
    let first_line = line.to_owned();
    let Ok(first) = serde_json::from_str::<Value>(&first_line) else {
        return Ok(None);
    };
    let filename = path.file_stem().unwrap_or_default().to_string_lossy();
    let pieces = filename.split('-').collect::<Vec<_>>();
    let id = pieces[pieces.len().saturating_sub(5)..].join("-");
    let directory = first["payload"]["cwd"].as_str().unwrap_or("").to_owned();
    let created = timestamp(&first).max(timestamp(&first["payload"]));
    let created = if created > 0.0 {
        created
    } else {
        crate::time::file_mtime_ms(path)?
    };
    let mut updated = created;
    let mut messages = Vec::<Message>::new();
    let mut model = None;
    let mut usage = Usage::default();
    let mut head_usage = Usage::default();
    let mut head_model = None;
    let mut message_count = 0;
    let mut message_title = None;
    let mut current: Option<usize> = None;
    let mut pending_plan = None;
    let mut latest_text = None;
    let mut tools = HashMap::<String, (usize, usize)>::new();
    let mut has_record = false;
    let mut next_index = 0;
    loop {
        let line = if next_index == 0 {
            first_line.as_str()
        } else if let Some(line) = lines.next_line()? {
            line
        } else {
            break;
        };
        let line_index = next_index;
        next_index += 1;
        let Ok(record) = projected_record(line) else {
            continue;
        };
        let payload = &record["payload"];
        if internal(&record["type"]) || internal(&payload["type"]) {
            continue;
        }
        has_record = true;
        let time = timestamp(&record).max(timestamp(payload));
        updated = updated.max(time);
        let kind = record["type"].as_str().unwrap_or("");
        if matches!(kind, "session_meta" | "turn_context") {
            if let Some(name) = payload["model"].as_str().filter(|s| !s.trim().is_empty()) {
                model = Some(name.trim().to_owned());
                head_model = model.clone();
            }
            continue;
        }
        if kind == "event_msg" && payload["type"] == "token_count" {
            usage.consume(payload, model.as_deref(), pricing, &mut messages);
            head_usage.consume(payload, head_model.as_deref(), pricing, &mut []);
            continue;
        }
        if kind != "response_item" {
            continue;
        }
        if matches!(
            payload["type"].as_str(),
            Some("message" | "function_call" | "function_call_output")
        ) {
            message_count += 1;
        }
        if let Some(name) = payload["info"]
            .get("model")
            .unwrap_or(&payload["model"])
            .as_str()
            .filter(|name| !name.trim().is_empty())
        {
            head_model = Some(name.trim().into());
        }
        match payload["type"].as_str().unwrap_or("") {
            "message" => {
                let role = payload["role"].as_str().unwrap_or("");
                if !matches!(role, "user" | "assistant") {
                    continue;
                }
                let full_text = content(payload, role == "assistant");
                static PLAN: LazyLock<Regex> = LazyLock::new(|| {
                    Regex::new(r"(?s)<proposed_plan>\s*(.*?)\s*</proposed_plan>").unwrap()
                });
                let text = if role == "assistant" {
                    if let Some(captures) = PLAN.captures(&full_text) {
                        pending_plan = Some(MessagePart::Plan {
                            text: captures[1].trim().into(),
                            approval_status: "success".into(),
                            time_created: Some(time),
                        });
                    }
                    clean(&PLAN.replace(&full_text, ""))
                } else {
                    clean(&full_text)
                };
                if text.trim().is_empty() || (role == "user" && developer_message(&text)) {
                    continue;
                }
                if role == "user"
                    && text.trim_start().starts_with("PLEASE IMPLEMENT THIS PLAN")
                    && let (Some(index), Some(plan)) = (current, pending_plan.take())
                {
                    messages[index].parts.push(plan);
                }
                if role == "user" && !text.trim_start().starts_with("PLEASE IMPLEMENT THIS PLAN") {
                    static NOTIFICATION: LazyLock<Regex> = LazyLock::new(|| {
                        Regex::new(
                            r"(?s)<subagent_notification>\s*(.*?)\s*</subagent_notification>",
                        )
                        .unwrap()
                    });
                    if let Some(captures) = NOTIFICATION.captures(&text)
                        && let Ok(Value::Object(notification)) =
                            serde_json::from_str::<Value>(&captures[1])
                    {
                        let nickname = notification
                            .get("nickname")
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let completed = notification
                            .get("completed")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .unwrap_or_else(|| format!("Subagent {nickname} completed"));
                        let mut notification_message = message(
                            Role::Assistant,
                            MessagePart::Text {
                                text: completed,
                                time_created: Some(time),
                            },
                            time,
                            None,
                        );
                        notification_message.subagent_id = notification
                            .get("agent_id")
                            .and_then(Value::as_str)
                            .filter(|id| !id.is_empty())
                            .map(str::to_owned);
                        notification_message.nickname =
                            (!nickname.is_empty()).then(|| nickname.to_owned());
                        messages.push(notification_message);
                        current = None;
                        latest_text = None;
                        continue;
                    }
                }
                if role == "user" && line_index < 20 && message_title.is_none() {
                    message_title = title(&text);
                }
                let part = MessagePart::Text {
                    text,
                    time_created: Some(time),
                };
                if role == "user" {
                    messages.push(message(Role::User, part, time, None));
                    current = None;
                    latest_text = None;
                } else {
                    let target = assistant_part(
                        &mut messages,
                        current,
                        latest_text,
                        part,
                        time,
                        model.clone(),
                    );
                    current = Some(target);
                    latest_text = Some(target);
                }
            }
            "reasoning" => {
                pending_plan = None;
                let text = payload["summary"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| item["type"] == "summary_text")
                    .filter_map(|item| item["text"].as_str())
                    .filter(|text| !text.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                let text = clean(&text);
                if !text.trim().is_empty() {
                    current = Some(assistant_part(
                        &mut messages,
                        current,
                        latest_text,
                        MessagePart::Reasoning {
                            text,
                            time_created: Some(time),
                        },
                        time,
                        model.clone(),
                    ));
                    latest_text = None;
                }
            }
            "function_call" | "custom_tool_call" => {
                pending_plan = None;
                let name = payload["name"].as_str().unwrap_or("").trim();
                if name.is_empty() {
                    continue;
                }
                let call_id = payload["call_id"].as_str().unwrap_or("").trim().to_owned();
                let input = if payload["type"] == "custom_tool_call" {
                    if name == "apply_patch" {
                        super::codex_patch::parse(&payload["input"])
                    } else {
                        payload["input"].clone()
                    }
                } else {
                    payload["arguments"]
                        .as_str()
                        .and_then(|text| serde_json::from_str(text).ok())
                        .unwrap_or_else(|| payload["arguments"].clone())
                };
                let decoded = if name == "exec" && payload["type"] == "custom_tool_call" {
                    super::codex_exec::decode(&payload["input"])
                } else {
                    Vec::new()
                };
                let output_target = super::codex_exec::output_target(&decoded);
                let calls = if decoded.is_empty() {
                    vec![(
                        name.to_owned(),
                        payload["namespace"]
                            .as_str()
                            .unwrap_or("")
                            .trim()
                            .to_owned(),
                        input,
                        call_id.clone(),
                    )]
                } else {
                    decoded
                        .into_iter()
                        .enumerate()
                        .map(|(index, call)| {
                            let (name, namespace) = super::codex_exec::split_tool_name(&call.name);
                            let input = if name == "apply_patch" {
                                super::codex_patch::parse(&Value::String(
                                    super::codex_exec::patch_text(&call.args).into(),
                                ))
                            } else {
                                call.args
                            };
                            (
                                name.to_owned(),
                                namespace.unwrap_or("").to_owned(),
                                input,
                                if Some(index) == output_target {
                                    call_id.clone()
                                } else {
                                    format!("{call_id}#{index}")
                                },
                            )
                        })
                        .collect()
                };
                for (name, namespace, input, call_id) in calls {
                    let (tool, metadata) = tool_identity(&name, &namespace);
                    let part = MessagePart::Tool {
                        title: Some(format!("Tool: {tool}")),
                        tool,
                        call_id: Some(call_id.clone()),
                        state: Box::new(ToolState {
                            status: "running".into(),
                            input: Some(clean_value(input)),
                            output: Some(Value::Null),
                            error: None,
                            metadata,
                        }),
                        time_created: Some(time),
                    };
                    let index = if let Some(target) = latest_text.or(current) {
                        messages[target].parts.push(part);
                        target
                    } else {
                        messages.push(message(Role::Assistant, part, time, model.clone()));
                        messages.len() - 1
                    };
                    messages[index].mode = Some("tool".into());
                    if messages[index].model.is_none() {
                        messages[index].model = model.clone();
                    }
                    tools.insert(call_id, (index, messages[index].parts.len() - 1));
                    current = Some(index);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = payload["call_id"].as_str().unwrap_or("");
                let output = match &payload["output"] {
                    Value::String(s) => s.clone(),
                    Value::Array(items) => items
                        .iter()
                        .filter_map(|item| item.as_str().or_else(|| item["text"].as_str()))
                        .collect::<Vec<_>>()
                        .join(""),
                    _ => String::new(),
                };
                static ENVELOPE: LazyLock<Regex> = LazyLock::new(|| {
                    Regex::new(r"^Script completed\nWall time [^\n]*\nOutput:\n?").unwrap()
                });
                let output = clean(&ENVELOPE.replace(&output, ""));
                if !output.is_empty()
                    && let Some((i, p)) = tools.get(call_id)
                    && let MessagePart::Tool { state, .. } = &mut messages[*i].parts[*p]
                {
                    state.output = Some(
                        serde_json::json!([{ "type": "text", "text": output, "time_created": time }]),
                    );
                    state.status = "completed".into();
                }
            }
            _ => {}
        }
    }
    if let (Some(index), Some(plan)) = (current, pending_plan) {
        messages[index].parts.push(plan);
    }
    if !has_record {
        return Ok(None);
    }
    for (index, message) in messages.iter_mut().enumerate() {
        message.id = format!("{id}:{index}");
    }
    let (project_identity, signature) = path_identity(&directory);
    let fallback = Path::new(&directory)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    let title = titles
        .get(&id)
        .and_then(|text| title(text))
        .or(message_title)
        .or_else(|| fallback.and_then(|text| title(&text)))
        .unwrap_or_else(|| "Untitled Session".into());
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: "codex".into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: (first["payload"]["thread_source"] == "subagent")
            .then(|| first["payload"]["parent_thread_id"].as_str())
            .flatten()
            .map(|id| SessionReference {
                agent_name: "codex".into(),
                session_id: id.into(),
            }),
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats: head_usage.stats(message_count),
        model_usage: head_usage.models(),
        smart_tags: super::smart_tags::classify(&messages),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::file_activity::summarize(&head, &messages);
    Ok(Some(SessionDetail {
        head,
        messages,
        detail_freshness: "fresh".into(),
        message_cursor: None,
        message_update: None,
        file_activity,
    }))
}

fn message(role: Role, part: MessagePart, time: f64, model: Option<String>) -> Message {
    let agent = (role == Role::Assistant).then(|| "codex".into());
    Message {
        cost_inputs: Vec::new(),
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

fn assistant_part(
    messages: &mut Vec<Message>,
    current: Option<usize>,
    latest_text: Option<usize>,
    part: MessagePart,
    time: f64,
    model: Option<String>,
) -> usize {
    let target = current.filter(|index| {
        let has_tool = messages[*index].mode.as_deref() == Some("tool");
        let has_text = latest_text == Some(*index);
        !has_tool && (matches!(part, MessagePart::Text { .. }) || !has_text)
    });
    if let Some(index) = target {
        messages[index].parts.push(part);
        if messages[index].model.is_none() {
            messages[index].model = model;
        }
        index
    } else {
        messages.push(message(Role::Assistant, part, time, model));
        messages.len() - 1
    }
}

fn tool_identity(name: &str, namespace: &str) -> (String, Option<Value>) {
    let mapped = match name {
        "exec_command" => Some("bash"),
        "apply_patch" | "patch" => Some("patch"),
        "spawn_agent" | "subagent" => Some("subagent"),
        _ => None,
    };
    if let Some(tool) = mapped {
        (tool.to_owned(), None)
    } else if namespace.is_empty() {
        (name.to_owned(), None)
    } else {
        let suffix = namespace.rsplit("__").next().unwrap_or(namespace);
        let normalized = name.trim_start_matches(['_', '.']);
        let normalized = if normalized.is_empty() {
            name
        } else {
            normalized
        };
        (
            if suffix.is_empty() {
                normalized.to_owned()
            } else {
                format!("{suffix}.{normalized}")
            },
            Some(serde_json::json!({"name":name,"namespace":namespace})),
        )
    }
}

fn clean_value(value: Value) -> Value {
    match value {
        Value::String(value) => Value::String(clean(&value)),
        Value::Array(values) => Value::Array(values.into_iter().map(clean_value).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (key, clean_value(value)))
                .collect(),
        ),
        value => value,
    }
}

#[cfg(test)]
mod incremental_tests {
    use super::*;

    #[test]
    fn title_trims_after_utf16_limit() {
        let text = format!("{} trailing", "x".repeat(99));
        assert_eq!(title(&text).unwrap(), "x".repeat(99));
    }

    #[test]
    fn child_returns_are_merged_chronologically_in_full_and_incremental_scans() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let parent = "00000000-0000-0000-0000-000000000001";
        let child = "00000000-0000-0000-0000-000000000002";
        let mut parent_path = PathBuf::new();
        for (id, parent_id, messages) in [
            (
                parent,
                None,
                vec![(1000, "first"), (3000, "last"), (3000, "same-time")],
            ),
            (child, Some(parent), vec![(2000, "child result")]),
        ] {
            let mut records = vec![serde_json::json!({
                "type":"session_meta", "timestamp":500,
                "payload":{"id":id,"cwd":"/project","thread_source":parent_id.map(|_| "subagent"),"parent_thread_id":parent_id}
            })];
            for (time, text) in messages {
                records.push(serde_json::json!({
                    "type":"response_item", "timestamp":time,
                    "payload":{"type":"message","role":if parent_id.is_some() {"assistant"} else {"user"},"phase":"final_answer","content":[{"type":"output_text","text":text}]}
                }));
            }
            let path = sessions.join(format!("rollout-2026-01-01-{id}.jsonl"));
            let contents = records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            std::fs::write(&path, contents).unwrap();
            if id == parent {
                parent_path = path;
            }
        }
        let pricing = Pricing::bundled();
        let full = scan(root.path(), &pricing).unwrap();
        let previous = full
            .iter()
            .map(crate::agents::SessionRecord::from)
            .collect::<Vec<_>>();
        let incremental = scan_changed(root.path(), &pricing, &[parent_path], &previous).unwrap();
        for result in [&full, &incremental.upserts] {
            let messages = &result
                .iter()
                .find(|session| session.head.reference.session_id == parent)
                .unwrap()
                .detail
                .messages;
            assert_eq!(
                messages
                    .iter()
                    .map(|message| message.time_created)
                    .collect::<Vec<_>>(),
                [1000.0, 2000.0, 3000.0, 3000.0]
            );
            assert_eq!(messages[1].subagent_id.as_deref(), Some(child));
            let texts = messages
                .iter()
                .flat_map(|message| &message.parts)
                .filter_map(|part| match part {
                    MessagePart::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(texts, ["first", "child result", "last", "same-time"]);
        }
    }

    #[test]
    fn partial_existing_source_is_not_a_deletion() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        std::fs::create_dir(&sessions).unwrap();
        let path = sessions.join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
        std::fs::write(&path, concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"cwd\":\"/project\"}}\n",
            "{\"type\":\"response_item\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n"
        )).unwrap();
        let pricing = Pricing::bundled();
        let previous = scan(root.path(), &pricing).unwrap();
        assert_eq!(previous.len(), 1);
        std::fs::write(&path, "{\"type\":").unwrap();
        assert!(
            scan_changed(
                root.path(),
                &pricing,
                std::slice::from_ref(&path),
                &previous
                    .iter()
                    .map(crate::agents::SessionRecord::from)
                    .collect::<Vec<_>>()
            )
            .is_err()
        );
        assert!(
            scan_changed(
                root.path(),
                &pricing,
                &[root.path().to_owned()],
                &previous
                    .iter()
                    .map(crate::agents::SessionRecord::from)
                    .collect::<Vec<_>>()
            )
            .is_err()
        );
        std::fs::remove_file(&path).unwrap();
        let deleted = scan_changed(
            root.path(),
            &pricing,
            &[path],
            &previous
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(deleted.removed, vec![previous[0].head.reference.clone()]);
        assert!(deleted.upserts.is_empty());
    }
}
