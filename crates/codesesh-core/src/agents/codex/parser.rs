use super::{clean, content, exec, message, patch, rollout, tool_events, usage::Usage};
use crate::{
    agents::{file_activity, jsonl::timestamp},
    model::*,
    pricing::Pricing,
    projects::path_identity,
};
use anyhow::Result;
use regex::Regex;
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::LazyLock};

#[derive(Clone)]
pub(super) struct Parser {
    id: String,
    directory: String,
    created: f64,
    parent: Option<String>,
    updated: f64,
    messages: Vec<Message>,
    model: Option<String>,
    service_tier: Option<String>,
    usage: Usage,
    head_usage: Usage,
    head_model: Option<String>,
    message_count: usize,
    message_title: Option<String>,
    current: Option<usize>,
    pending_plan: Option<MessagePart>,
    latest_text: Option<usize>,
    tools: HashMap<String, (usize, usize)>,
    tool_events: tool_events::ToolEvents,
    has_record: bool,
    next_index: usize,
}

impl Parser {
    pub(super) fn new(path: &Path, physical: &Path, first_line: &str) -> Result<Option<Self>> {
        let Ok(first) = serde_json::from_str::<Value>(first_line) else {
            return Ok(None);
        };
        let logical = rollout::logical_path(path);
        let filename = logical.file_stem().unwrap_or_default().to_string_lossy();
        let pieces = filename.split('-').collect::<Vec<_>>();
        let id = pieces[pieces.len().saturating_sub(5)..].join("-");
        let created = timestamp(&first).max(timestamp(&first["payload"]));
        let created = if created > 0.0 {
            created
        } else {
            crate::time::file_mtime_ms(physical)?
        };
        Ok(Some(Self {
            id,
            directory: first["payload"]["cwd"].as_str().unwrap_or("").to_owned(),
            created,
            parent: (first["payload"]["thread_source"] == "subagent")
                .then(|| first["payload"]["parent_thread_id"].as_str())
                .flatten()
                .map(str::to_owned),
            updated: created,
            messages: Vec::new(),
            model: None,
            service_tier: None,
            usage: Usage::new(&first["payload"]),
            head_usage: Usage::new(&first["payload"]),
            head_model: None,
            message_count: 0,
            message_title: None,
            current: None,
            pending_plan: None,
            latest_text: None,
            tools: HashMap::new(),
            tool_events: Default::default(),
            has_record: false,
            next_index: 0,
        }))
    }

    pub(super) fn feed(&mut self, line: &str, pricing: &Pricing) {
        let Self {
            updated,
            messages,
            model,
            service_tier,
            usage,
            head_usage,
            head_model,
            message_count,
            message_title,
            current,
            pending_plan,
            latest_text,
            tools,
            tool_events,
            has_record,
            next_index,
            ..
        } = self;
        let line_index = *next_index;
        *next_index += 1;
        let Ok(record) = projected_record(line) else {
            return;
        };
        let payload = &record["payload"];
        if internal(&record["type"]) || internal(&payload["type"]) {
            return;
        }
        *has_record = true;
        let time = timestamp(&record).max(timestamp(payload));
        let kind = record["type"].as_str().unwrap_or("");
        let activity = match kind {
            "response_item" => match payload["type"].as_str().unwrap_or("") {
                "message" => matches!(payload["role"].as_str(), Some("user" | "assistant")),
                "reasoning"
                | "function_call"
                | "function_call_output"
                | "custom_tool_call"
                | "custom_tool_call_output" => true,
                _ => false,
            },
            "event_msg" => matches!(
                payload["type"].as_str(),
                Some(
                    "task_started"
                        | "task_complete"
                        | "turn_aborted"
                        | "token_count"
                        | "item_completed"
                        | "user_message"
                        | "agent_message"
                        | "agent_reasoning"
                )
            ),
            "token_usage_record" => true,
            _ => false,
        };
        if activity {
            *updated = updated.max(time);
        }
        if matches!(kind, "session_meta" | "turn_context") {
            if let Some(name) = payload["model"].as_str().filter(|s| !s.trim().is_empty()) {
                *model = Some(name.trim().to_owned());
                *head_model = model.clone();
            }
            if kind == "turn_context" {
                usage.turn(payload);
                head_usage.turn(payload);
            }
            return;
        }
        if kind == "event_msg" && payload["type"] == "thread_settings_applied" {
            if let Some(tier) = payload["thread_settings"]["service_tier"].as_str() {
                *service_tier = Some(tier.to_owned());
            }
            return;
        }
        if kind == "event_msg" && payload["type"] == "token_count" {
            let tier = service_tier.as_deref();
            usage.consume(payload, model.as_deref(), tier, pricing, messages);
            head_usage.consume(payload, head_model.as_deref(), tier, pricing, &mut []);
            return;
        }
        if kind == "token_usage_record" {
            usage.record(payload);
            head_usage.record(payload);
            return;
        }
        if kind == "compacted" {
            let tier = service_tier.as_deref();
            usage.compacted(payload, model.as_deref(), tier, pricing, messages);
            head_usage.compacted(payload, head_model.as_deref(), tier, pricing, &mut []);
            return;
        }
        if kind == "event_msg" && payload["type"] == "item_completed" {
            let item = &payload["item"];
            if item["type"] == "McpToolCall"
                && let Some(part) = tool_events.complete(item, messages, time)
            {
                *current = Some(assistant_part(
                    messages,
                    *current,
                    *latest_text,
                    part,
                    time,
                    model.clone(),
                ));
            }
            return;
        }
        if kind != "response_item" {
            return;
        }
        if matches!(
            payload["type"].as_str(),
            Some("message" | "function_call" | "function_call_output")
        ) {
            *message_count += 1;
        }
        if let Some(name) = payload["info"]
            .get("model")
            .unwrap_or(&payload["model"])
            .as_str()
            .filter(|name| !name.trim().is_empty())
        {
            *head_model = Some(name.trim().into());
        }
        match payload["type"].as_str().unwrap_or("") {
            "message" => {
                let role = payload["role"].as_str().unwrap_or("");
                if !matches!(role, "user" | "assistant") {
                    return;
                }
                let full_text = content(payload, role == "assistant");
                let full_text = if role == "user" {
                    tool_events::record_question_reply(&full_text, messages, tools)
                        .unwrap_or(full_text)
                } else {
                    full_text
                };
                static PLAN: LazyLock<Regex> = LazyLock::new(|| {
                    Regex::new(r"(?s)<proposed_plan>\s*(.*?)\s*</proposed_plan>").unwrap()
                });
                let text = if role == "assistant" {
                    if let Some(captures) = PLAN.captures(&full_text) {
                        *pending_plan = Some(MessagePart::Plan {
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
                    return;
                }
                if role == "user"
                    && text.trim_start().starts_with("PLEASE IMPLEMENT THIS PLAN")
                    && let (Some(index), Some(plan)) = (*current, pending_plan.take())
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
                        *current = None;
                        *latest_text = None;
                        return;
                    }
                }
                if role == "user" && line_index < 20 && message_title.is_none() {
                    *message_title = title(&text);
                }
                let part = MessagePart::Text {
                    text,
                    time_created: Some(time),
                };
                if role == "user" {
                    messages.push(message(Role::User, part, time, None));
                    *current = None;
                    *latest_text = None;
                } else {
                    let target =
                        assistant_part(messages, *current, *latest_text, part, time, model.clone());
                    *current = Some(target);
                    *latest_text = Some(target);
                }
            }
            "reasoning" => {
                *pending_plan = None;
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
                    *current = Some(assistant_part(
                        messages,
                        *current,
                        *latest_text,
                        MessagePart::Reasoning {
                            text,
                            time_created: Some(time),
                        },
                        time,
                        model.clone(),
                    ));
                    *latest_text = None;
                }
            }
            "function_call" | "custom_tool_call" => {
                *pending_plan = None;
                let name = payload["name"].as_str().unwrap_or("").trim();
                if name.is_empty() {
                    return;
                }
                let call_id = payload["call_id"].as_str().unwrap_or("").trim().to_owned();
                let input = if payload["type"] == "custom_tool_call" {
                    if name == "apply_patch" {
                        patch::parse(&payload["input"])
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
                    exec::decode(&payload["input"])
                } else {
                    Vec::new()
                };
                let output_target = exec::output_target(&decoded);
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
                            let (name, namespace) = exec::split_tool_name(&call.name);
                            let input = if name == "apply_patch" {
                                patch::parse(&Value::String(exec::patch_text(&call.args).into()))
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
                    let position = tool_part(messages, latest_text.or(*current), part, time, model);
                    tool_events.register(&namespace, &name, position);
                    tools.insert(call_id, position);
                    *current = Some(position.0);
                }
            }
            "web_search_call" | "tool_search_call" | "image_generation_call" => {
                *pending_plan = None;
                let (tool, input) = match payload["type"].as_str().unwrap_or("") {
                    "web_search_call" => ("web_search", payload["action"].clone()),
                    "tool_search_call" => ("tool_search", payload["arguments"].clone()),
                    _ => (
                        "image_generation",
                        serde_json::json!({"revised_prompt": payload["revised_prompt"]}),
                    ),
                };
                let call_id = payload["call_id"].as_str().map(str::to_owned);
                let part = MessagePart::Tool {
                    title: Some(format!("Tool: {tool}")),
                    tool: tool.into(),
                    call_id: call_id.clone(),
                    state: Box::new(ToolState {
                        // Only tool search records its result in a later item.
                        status: if tool == "tool_search" {
                            "running"
                        } else {
                            "completed"
                        }
                        .into(),
                        input: Some(clean_value(input)),
                        output: Some(Value::Null),
                        error: None,
                        metadata: None,
                    }),
                    time_created: Some(time),
                };
                let position = tool_part(messages, latest_text.or(*current), part, time, model);
                if let Some(call_id) = call_id {
                    tools.insert(call_id, position);
                }
                *current = Some(position.0);
            }
            "tool_search_output" => {
                let found = payload["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|tool| {
                        let name = tool["name"].as_str().unwrap_or("");
                        let nested = tool["tools"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|tool| tool["name"].as_str())
                            .collect::<Vec<_>>()
                            .join(", ");
                        if nested.is_empty() {
                            name.to_owned()
                        } else {
                            format!("{name}: {nested}")
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Some((i, p)) = tools.get(payload["call_id"].as_str().unwrap_or(""))
                    && let MessagePart::Tool { state, .. } = &mut messages[*i].parts[*p]
                    && state.status == "running"
                {
                    state.output = Some(
                        serde_json::json!([{ "type": "text", "text": found, "time_created": time }]),
                    );
                    state.status = "completed".into();
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = payload["call_id"].as_str().unwrap_or("");
                if payload["type"] == "custom_tool_call_output" {
                    if let Some((i, p)) = tools.get(call_id)
                        && let MessagePart::Tool { state, .. } = &mut messages[*i].parts[*p]
                        && state.status == "running"
                    {
                        let (output, status) = exec::output(&payload["output"], time);
                        let output = clean_value(output);
                        state.error = (status == "error").then(|| output.clone());
                        state.output = Some(output);
                        state.status = status.into();
                    }
                    return;
                }
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
                    && state.status == "running"
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

    pub(super) fn finish(self, titles: &HashMap<String, String>) -> Option<SessionDetail> {
        let Self {
            id,
            directory,
            created,
            parent,
            updated,
            mut messages,
            head_usage,
            message_count,
            message_title,
            current,
            pending_plan,
            has_record,
            ..
        } = self;
        if let (Some(index), Some(plan)) = (current, pending_plan) {
            messages[index].parts.push(plan);
        }
        if !has_record {
            return None;
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
                source_node_id: crate::model::local_source_node_id(),
                agent_name: "codex".into(),
                session_id: id,
            },
            title,
            directory,
            display_title: None,
            parent_reference: parent.map(|id| SessionReference {
                source_node_id: crate::model::local_source_node_id(),
                agent_name: "codex".into(),
                session_id: id,
            }),
            project_identity,
            project_identity_resolver_revision: Some("project-identity-v2".into()),
            project_identity_input_signature: Some(signature),
            time_created: created,
            time_updated: updated,
            stats: head_usage.stats(message_count),
            model_usage: head_usage.models(),
            smart_tags: Vec::new(),
            smart_tags_source_updated_at: Some(updated),
            smart_tags_classifier_revision: Some("smart-tags-v1".into()),
        };
        let file_activity = file_activity::summarize(&head, &messages);
        Some(SessionDetail {
            head,
            messages,
            detail_freshness: "fresh".into(),
            message_cursor: None,
            message_update: None,
            file_activity,
        })
    }
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

pub(super) fn title(text: &str) -> Option<String> {
    let cleaned = clean(text);
    let line = cleaned.lines().find(|line| !line.trim().is_empty())?;
    let words = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(
        String::from_utf16_lossy(&words.encode_utf16().take(100).collect::<Vec<_>>())
            .trim()
            .to_owned(),
    )
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
    struct Header<'a> {
        #[serde(default, rename = "type")]
        kind: Value,
        #[serde(default)]
        timestamp: Value,
        #[serde(default)]
        model: Value,
        #[serde(default)]
        turn_id: Value,
        #[serde(default)]
        compaction_response_id: Value,
        #[serde(default, borrow)]
        item: Option<&'a serde_json::value::RawValue>,
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
    let mcp_completion = header.kind == "item_completed"
        && header.item.as_ref().is_some_and(|item| {
            #[derive(serde::Deserialize)]
            struct ItemType {
                #[serde(rename = "type")]
                kind: String,
                #[serde(default)]
                server: String,
                #[serde(default)]
                tool: String,
            }
            serde_json::from_str::<ItemType>(item.get()).is_ok_and(|item| {
                item.kind == "McpToolCall"
                    && item.server == "codex_app"
                    && item.tool == "read_thread"
            })
        });
    let payload = if !internal(&record.kind)
        && !internal(&header.kind)
        && (record.kind == "response_item"
            || record.kind == "token_usage_record"
            || (record.kind == "event_msg"
                && (header.kind == "token_count"
                    || header.kind == "thread_settings_applied"
                    || mcp_completion)))
    {
        serde_json::from_str(raw)?
    } else {
        serde_json::json!({"type":header.kind,"timestamp":header.timestamp,"model":header.model,"turn_id":header.turn_id,"compaction_response_id":header.compaction_response_id})
    };
    Ok(serde_json::json!({"type":record.kind,"timestamp":record.timestamp,"payload":payload}))
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

fn tool_part(
    messages: &mut Vec<Message>,
    target: Option<usize>,
    part: MessagePart,
    time: f64,
    model: &Option<String>,
) -> (usize, usize) {
    let index = if let Some(target) = target {
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
    (index, messages[index].parts.len() - 1)
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
