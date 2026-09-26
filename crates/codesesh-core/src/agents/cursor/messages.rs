use super::text::{clean_value, js_string};
use super::{clean, internal, model, number, string};
use crate::{
    contract::{CostSource, Message, MessagePart, MessageTokens, Role, SessionStats, ToolState},
    pricing::Pricing,
};
use anyhow::Result;
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn tokens(input: f64, output: f64) -> MessageTokens {
    MessageTokens {
        input: Some(input),
        output: Some(output),
        reasoning: None,
        cache_read: None,
        cache_create: None,
    }
}
fn map_tool(tool: &str) -> &str {
    match tool {
        "read_file_v2" => "read",
        "edit_file_v2" => "edit",
        "run_terminal_command_v2" => "bash",
        "ripgrep_raw_search" => "grep",
        "glob_file_search" => "glob",
        other => other,
    }
}
fn base_message(id: String, role: Role, time: f64, parts: Vec<MessagePart>) -> Message {
    Message {
        cost_inputs: Vec::new(),
        id,
        role,
        agent: Some("cursor".into()),
        time_created: time,
        time_completed: None,
        mode: None,
        model: None,
        provider: None,
        tokens: None,
        cost: Some(0.0),
        cost_source: None,
        parts,
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}
pub(super) fn messages(
    bubbles: &[(String, Value)],
    initial_model: Option<&str>,
    pricing: &Pricing,
) -> Vec<Message> {
    let mut active_model = initial_model.map(str::to_owned);
    let mut result = Vec::new();
    for (key, bubble) in bubbles {
        if ["eventType", "kind", "subtype", "name"]
            .iter()
            .any(|field| internal(&bubble[*field]))
        {
            continue;
        }
        let role = if number(bubble, "type") == Some(2.0) {
            Role::Assistant
        } else {
            Role::User
        };
        let time = number(&bubble["timingInfo"], "clientRpcSendTime")
            .filter(|v| *v != 0.0)
            .map(f64::floor)
            .or_else(|| number(bubble, "createdAt").filter(|v| *v != 0.0))
            .or_else(|| number(bubble, "timestamp").filter(|v| *v != 0.0))
            .unwrap_or(0.0);
        let bubble_model = string(&bubble["modelInfo"], "modelName");
        if let Some(name) = bubble_model.filter(|s| !s.is_empty()) {
            active_model = Some(name.into());
        }
        let mut parts = Vec::new();
        let text = clean(string(bubble, "text").unwrap_or(""));
        if !text.is_empty() {
            parts.push(MessagePart::Text {
                text,
                time_created: Some(time),
            });
        }
        if let Some(part) = tool_former(&bubble["toolFormerData"], time) {
            parts.push(part);
        }
        if parts.is_empty() {
            continue;
        }
        let composer_id = key.split(':').nth(1).unwrap_or("");
        let fallback = result.len().to_string();
        let bubble_id = key
            .rsplit(':')
            .next()
            .filter(|s| !s.is_empty())
            .unwrap_or(&fallback);
        let is_tool =
            role == Role::Assistant && parts.iter().any(|p| matches!(p, MessagePart::Tool { .. }));
        let mut message = base_message(
            format!("cursor-{composer_id}-{bubble_id}"),
            role,
            time,
            parts,
        );
        message.mode = is_tool.then(|| "tool".into());
        message.model = bubble_model
            .map(str::to_owned)
            .or_else(|| active_model.clone());
        let usage = tokens(
            number(&bubble["tokenCount"], "inputTokens").unwrap_or(0.0),
            number(&bubble["tokenCount"], "outputTokens").unwrap_or(0.0),
        );
        let cost = pricing.estimate_tracked(
            message.model.as_deref(),
            &usage,
            0.0,
            &mut message.cost_inputs,
        );
        message.tokens = Some(usage);
        message.cost = Some(cost.unwrap_or(0.0));
        message.cost_source = cost.map(|_| CostSource::Estimated);
        result.push(message);
    }
    result
}
fn parse_json(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| value.clone())
}
pub(super) fn tool_former(value: &Value, time: f64) -> Option<MessagePart> {
    let name = string(value, "name").filter(|s| !s.is_empty())?;
    let status = match string(value, "status") {
        Some("completed") => "completed",
        Some("error" | "failed") => "error",
        _ => "running",
    };
    let input = value.get("params").filter(|v| truthy(v)).map(|v| {
        if let Some(text) = v.as_str() {
            serde_json::from_str(text).unwrap_or_else(|_| json!({"_raw":text}))
        } else {
            v.clone()
        }
    });
    let output = value.get("result").map(parse_json);
    let error = output.as_ref().filter(|_| status == "error").map(|v| {
        v.get("error")
            .filter(|v| !v.is_null())
            .or_else(|| v.get("message").filter(|v| !v.is_null()))
            .or_else(|| v.get("stderr").filter(|v| !v.is_null()))
            .unwrap_or(v)
            .clone()
    });
    if name == "create_plan" {
        let text = input
            .as_ref()
            .and_then(|v| v.get("plan"))
            .filter(|v| !v.is_null())
            .map(js_string)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if !text.is_empty() {
            let text = clean(&text);
            return (!text.is_empty()).then(|| MessagePart::Plan {
                text,
                approval_status: if status == "completed" {
                    "success"
                } else {
                    "fail"
                }
                .into(),
                time_created: Some(time),
            });
        }
    }
    let tool = if name == "create_plan" {
        "plan"
    } else {
        map_tool(name)
    };
    Some(MessagePart::Tool {
        tool: tool.into(),
        call_id: Some(string(value, "toolCallId").unwrap_or("").into()),
        title: Some(format!("Tool: {tool}")),
        time_created: Some(time),
        state: Box::new(ToolState {
            status: status.into(),
            input: input.map(clean_value),
            output: output.map(clean_value),
            error: error.map(clean_value),
            metadata: None,
        }),
    })
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(super) fn model_usage(messages: &[Message]) -> Option<BTreeMap<String, f64>> {
    let mut usage = BTreeMap::new();
    for message in messages {
        if let (Some(model), Some(tokens)) = (&message.model, &message.tokens) {
            let count = tokens.input.unwrap_or(0.0) + tokens.output.unwrap_or(0.0);
            if !model.is_empty() && count > 0.0 {
                *usage.entry(model.clone()).or_default() += count;
            }
        }
    }
    (!usage.is_empty()).then_some(usage)
}
pub(super) fn detail_stats(
    messages: &[Message],
    composer: &Value,
    pricing: &Pricing,
) -> SessionStats {
    let mut input: f64 = messages
        .iter()
        .filter_map(|m| m.tokens.as_ref()?.input)
        .sum();
    let mut output: f64 = messages
        .iter()
        .filter_map(|m| m.tokens.as_ref()?.output)
        .sum();
    let mut cost: f64 = messages.iter().map(|m| m.cost.unwrap_or(0.0)).sum();
    if input == 0.0 {
        input = number(composer, "inputTokenCount").unwrap_or(0.0);
    }
    if output == 0.0 {
        output = number(composer, "outputTokenCount").unwrap_or(0.0);
    }
    let mut cost_inputs = messages
        .iter()
        .flat_map(|m| m.cost_inputs.iter().cloned())
        .collect();
    if cost == 0.0 {
        cost = pricing
            .estimate_tracked(
                model(composer),
                &tokens(input, output),
                0.0,
                &mut cost_inputs,
            )
            .unwrap_or(0.0);
    }
    SessionStats {
        message_count: messages.len(),
        total_input_tokens: input,
        total_output_tokens: output,
        total_cost: cost,
        cost_inputs,
        cost_source: (cost > 0.0).then_some(CostSource::Estimated),
        ..Default::default()
    }
}

pub(super) fn append_subagents(
    db: &Connection,
    composer: &Value,
    messages: &mut Vec<Message>,
) -> Result<()> {
    let Some(infos) = composer["subagentInfos"].as_array() else {
        return Ok(());
    };
    for info in infos {
        let Some(id) = string(info, "id").filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut statement = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?")?;
        let mut rows = statement.query([format!("bubble:{id}")])?;
        let Some(row) = rows.next()? else { continue };
        let raw: String = row.get(0)?;
        let Ok(bubble) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(chats) = bubble["chatMessages"].as_array() else {
            continue;
        };
        for chat in chats {
            let role = match string(chat, "role")
                .unwrap_or("")
                .trim()
                .to_lowercase()
                .as_str()
            {
                "user" => Role::User,
                "assistant" => Role::Assistant,
                _ => continue,
            };
            let time = ["createdAt", "timestamp"]
                .iter()
                .find_map(|key| number(chat, key).filter(|v| *v > 0.0))
                .unwrap_or(0.0);
            let mut parts = Vec::new();
            let text = clean(string(chat, "text").unwrap_or(""));
            if !text.is_empty() {
                parts.push(MessagePart::Text {
                    text,
                    time_created: Some(time),
                });
            }
            if role == Role::Assistant
                && let Some(actions) = chat["actions"].as_array()
            {
                for action in actions {
                    if internal(&action["type"]) || internal(&action["tool"]) {
                        continue;
                    }
                    if let Some(part) = action_part(action, time) {
                        parts.push(part);
                    }
                }
            }
            if parts.is_empty() {
                continue;
            }
            let mut message = base_message(format!("cursor-sub-{id}"), role, time, parts);
            message.subagent_id = Some(id.into());
            message.nickname = string(info, "nickname")
                .or_else(|| string(info, "title"))
                .map(str::to_owned);
            messages.push(message);
        }
    }
    Ok(())
}
fn output_parts(value: &Value, time: f64) -> Vec<Value> {
    let values = value
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_else(|| std::slice::from_ref(value));
    let is_array = value.is_array();
    values
        .iter()
        .filter_map(|v| {
            let text = match v {
                Value::Null => return None,
                Value::String(s) => s.clone(),
                Value::Object(_) if is_array => v
                    .get("text")
                    .filter(|v| !v.is_null())
                    .or_else(|| v.get("content").filter(|v| !v.is_null()))
                    .map(js_string)
                    .unwrap_or_default(),
                _ if is_array => return None,
                _ => js_string(v),
            };
            let text = clean(&text);
            (!text.is_empty()).then(|| json!({"type":"text","text":text,"time_created":time}))
        })
        .collect()
}
pub(super) fn action_part(action: &Value, time: f64) -> Option<MessagePart> {
    let tool = string(action, "tool").unwrap_or("");
    if tool != "run_terminal_command_v2"
        && (tool.is_empty() || string(action, "type") != Some("tool"))
    {
        return None;
    }
    let state = &action["state"];
    let input = state
        .get("input")
        .or_else(|| state.get("arguments"))
        .or_else(|| action.get("input"))
        .cloned();
    let normalized_output = action.get("output").map(|v| {
        let parts = output_parts(v, 0.0);
        if parts.is_empty() {
            v.clone()
        } else {
            Value::Array(parts)
        }
    });
    let output = state
        .get("output")
        .or_else(|| state.get("result"))
        .cloned()
        .or(normalized_output);
    let error = state.get("error").cloned();
    let status = match string(state, "status") {
        Some("running") => "running",
        Some("completed" | "success") => "completed",
        Some("error") => "error",
        _ if error.as_ref().is_some_and(|v| !v.is_null()) => "error",
        _ if output.is_some() => "completed",
        _ => "running",
    };
    let mut metadata = state
        .get("metadata")
        .filter(|v| !v.is_null())
        .or_else(|| state.get("meta"))
        .cloned();
    if let Some(fields) = state.as_object() {
        let extras: serde_json::Map<String, Value> = fields
            .iter()
            .filter(|(key, _)| {
                ![
                    "status",
                    "input",
                    "arguments",
                    "output",
                    "result",
                    "error",
                    "metadata",
                    "meta",
                ]
                .contains(&key.as_str())
            })
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        if !extras.is_empty() {
            let mut merged = metadata
                .and_then(|v| v.as_object().cloned())
                .unwrap_or_default();
            merged.extend(extras);
            metadata = Some(Value::Object(merged));
        }
    }
    let mut state = ToolState {
        status: status.into(),
        input,
        output,
        error,
        metadata,
    };
    let (call_id, title) = if tool == "run_terminal_command_v2" {
        let command = action["input"]
            .get("command")
            .filter(|v| !v.is_null())
            .map(js_string)
            .unwrap_or_default();
        let description = clean(
            &action["input"]
                .get("commandDescription")
                .filter(|v| !v.is_null())
                .map(js_string)
                .unwrap_or_default(),
        );
        let short = String::from_utf16_lossy(&command.encode_utf16().take(60).collect::<Vec<_>>());
        state.input = Some(json!({"command":command}));
        state.output = Some(Value::Array(
            if let Some(text) = action["output"].as_str() {
                vec![json!({"type":"text","text":text,"time_created":time})]
            } else {
                output_parts(&action["output"], time)
            },
        ));
        (
            String::new(),
            if description.is_empty() {
                format!("bash: {short}")
            } else {
                description
            },
        )
    } else {
        let id = action["input"]
            .get("id")
            .filter(|v| !v.is_null())
            .map(js_string)
            .unwrap_or_default();
        (
            format!("{}:{id}", string(action, "type").unwrap_or("")),
            format!("Tool: {}", map_tool(tool)),
        )
    };
    state.input = state.input.map(clean_value);
    state.output = state.output.map(clean_value);
    state.error = state.error.map(clean_value);
    state.metadata = state.metadata.map(clean_value);
    Some(MessagePart::Tool {
        tool: map_tool(tool).into(),
        call_id: Some(call_id),
        title: Some(title),
        state: Box::new(state),
        time_created: Some(time),
    })
}
