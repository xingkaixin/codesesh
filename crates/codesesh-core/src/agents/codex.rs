use crate::{contract::*, projects::path_identity};
use anyhow::{Context, Result, bail};
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

pub struct ParsedSession {
    pub source: PathBuf,
    pub detail: SessionDetail,
}

pub fn scan(root: &Path) -> Result<Vec<ParsedSession>> {
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
        if let Some(detail) = parse(entry.path(), &titles)? {
            sessions.push(ParsedSession {
                source: entry.into_path(),
                detail,
            });
        }
    }
    sessions.sort_by(|a, b| {
        b.detail
            .head
            .time_updated
            .cmp(&a.detail.head.time_updated)
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

pub fn timestamp(record: &Value) -> i64 {
    record["timestamp"]
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|date| date.timestamp_millis())
        .unwrap_or(0)
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

static CLEANUP: LazyLock<Vec<(Regex, Regex, Regex)>> = LazyLock::new(|| {
    [
        "command-message",
        "command-name",
        "local-command-caveat",
        "local-command-stdout",
        "system-reminder",
    ]
    .iter()
    .map(|tag| {
        (
            Regex::new(&format!(
                r"(?is)(^|\r?\n)[ \t]*<{tag}\b[^>]*>.*?</{tag}>[ \t]*(?:\r?\n|$)"
            ))
            .unwrap(),
            Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")).unwrap(),
            Regex::new(&format!(r"(?is)\n*<{tag}\b[^>]*>.*$")).unwrap(),
        )
    })
    .collect()
});
static LOOSE_TAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)</?(?:command-message|command-name|local-command-caveat|local-command-stdout|system-reminder|command-args)\b[^>]*>").unwrap()
});

fn clean(text: &str) -> String {
    let mut text = text.to_owned();
    for (line, block, open) in CLEANUP.iter() {
        text = line.replace_all(&text, "$1").into_owned();
        text = block.replace_all(&text, "").into_owned();
        text = open.replace_all(&text, "").into_owned();
    }
    text = LOOSE_TAG.replace_all(&text, "").into_owned();
    text.lines()
        .map(|line| line.trim_end_matches([' ', '\t', '\r']))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end_matches('\n')
        .to_owned()
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
    Some(String::from_utf16_lossy(
        &words.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
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

pub fn parse(path: &Path, titles: &HashMap<String, String>) -> Result<Option<SessionDetail>> {
    let file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut lines = BufReader::new(file).lines();
    let Some(line) = lines.next().transpose()? else {
        return Ok(None);
    };
    let Ok(first) = serde_json::from_str::<Value>(&line) else {
        return Ok(None);
    };
    let filename = path.file_stem().unwrap_or_default().to_string_lossy();
    let pieces = filename.split('-').collect::<Vec<_>>();
    let id = pieces[pieces.len().saturating_sub(5)..].join("-");
    let directory = first["payload"]["cwd"].as_str().unwrap_or("").to_owned();
    if first["payload"]["thread_source"] == "subagent" {
        bail!(
            "Rust P1 does not yet support Codex subagent rollouts: {}",
            path.display()
        );
    }
    let created = timestamp(&first).max(timestamp(&first["payload"]));
    let created = if created > 0 {
        created
    } else {
        path.metadata()?
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64
    };
    let mut updated = created;
    let mut messages = Vec::<Message>::new();
    let mut model = None;
    let mut message_title = None;
    let mut current = None;
    let mut latest_text = None;
    let mut tools = HashMap::<String, (usize, usize)>::new();
    let mut has_record = false;
    for (line_index, line) in std::iter::once(Ok(line)).chain(lines).enumerate() {
        let line = line?;
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
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
            }
            continue;
        }
        if kind == "event_msg" && payload["type"] == "token_count" {
            bail!(
                "Rust P1 does not yet support token usage records: {}",
                path.display()
            );
        }
        if kind != "response_item" {
            continue;
        }
        match payload["type"].as_str().unwrap_or("") {
            "message" => {
                let role = payload["role"].as_str().unwrap_or("");
                if !matches!(role, "user" | "assistant") {
                    continue;
                }
                let text = clean(&content(payload, role == "assistant"));
                if text.trim().is_empty() || (role == "user" && developer_message(&text)) {
                    continue;
                }
                if text.contains("<proposed_plan>") || text.contains("<subagent_notification>") {
                    bail!(
                        "Rust P1 does not yet support Codex plans or subagent notifications: {}",
                        path.display()
                    );
                }
                if role == "user" && line_index < 20 && message_title.is_none() {
                    message_title = title(&text);
                }
                let part = MessagePart::Text {
                    text,
                    time_created: time,
                };
                if role == "user" {
                    messages.push(message(Role::User, part, time, None));
                    current = None;
                    latest_text = None;
                } else {
                    let target = assistant_part(&mut messages, current, part, time, model.clone());
                    current = Some(target);
                    latest_text = Some(target);
                }
            }
            "reasoning" => {
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
                        MessagePart::Reasoning {
                            text,
                            time_created: time,
                        },
                        time,
                        model.clone(),
                    ));
                    latest_text = None;
                }
            }
            "function_call" | "custom_tool_call" => {
                let name = payload["name"].as_str().unwrap_or("").trim();
                if name.is_empty() {
                    continue;
                }
                if matches!(name, "exec" | "apply_patch" | "spawn_agent") {
                    bail!(
                        "Rust P1 does not yet support the Codex {name} tool: {}",
                        path.display()
                    );
                }
                let call_id = payload["call_id"].as_str().unwrap_or("").trim().to_owned();
                let tool = match name {
                    "exec_command" => "bash",
                    "patch" => "patch",
                    "subagent" => "subagent",
                    _ => name,
                }
                .to_owned();
                let input = if payload["type"] == "custom_tool_call" {
                    payload["input"].clone()
                } else {
                    payload["arguments"]
                        .as_str()
                        .and_then(|text| serde_json::from_str(text).ok())
                        .unwrap_or_else(|| payload["arguments"].clone())
                };
                let part = MessagePart::Tool {
                    title: Some(format!("Tool: {tool}")),
                    tool,
                    call_id: Some(call_id.clone()),
                    state: Box::new(ToolState {
                        status: "running".into(),
                        input: Some(input),
                        output: Some(Value::Null),
                        error: None,
                        metadata: None,
                    }),
                    time_created: time,
                };
                let index = if let Some(target) = latest_text.or(current) {
                    messages[target].parts.push(part);
                    target
                } else {
                    messages.push(message(Role::Assistant, part, time, model.clone()));
                    messages.len() - 1
                };
                messages[index].mode = Some("tool".into());
                tools.insert(call_id, (index, messages[index].parts.len() - 1));
                current = Some(index);
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
                let output = clean(&output);
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
        reference: SessionReference {
            agent_name: "codex".into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: None,
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats: SessionStats {
            message_count: messages.len(),
            ..Default::default()
        },
        model_usage: None,
        smart_tags: Vec::new(),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    Ok(Some(SessionDetail {
        head,
        messages,
        detail_freshness: "fresh".into(),
        message_cursor: None,
        message_update: None,
        file_activity: Vec::new(),
    }))
}

fn message(role: Role, part: MessagePart, time: i64, model: Option<String>) -> Message {
    let agent = (role == Role::Assistant).then(|| "codex".into());
    Message {
        id: String::new(),
        role,
        agent,
        time_created: time,
        time_completed: None,
        mode: None,
        model,
        provider: None,
        tokens: None,
        cost: 0.0,
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
    part: MessagePart,
    time: i64,
    model: Option<String>,
) -> usize {
    let target = current.filter(|i| {
        let parts = &messages[*i].parts;
        let has_tool = parts
            .iter()
            .any(|part| matches!(part, MessagePart::Tool { .. }));
        let has_text = parts
            .iter()
            .any(|part| matches!(part, MessagePart::Text { .. }));
        !has_tool && (matches!(part, MessagePart::Text { .. }) || !has_text)
    });
    if let Some(index) = target {
        messages[index].parts.push(part);
        index
    } else {
        messages.push(message(Role::Assistant, part, time, model));
        messages.len() - 1
    }
}
