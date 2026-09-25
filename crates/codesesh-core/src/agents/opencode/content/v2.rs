use super::*;
use anyhow::{Result, bail};
use serde_json::json;
use std::collections::HashSet;

fn describe(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| serde_json::to_string_pretty(value).unwrap_or_default())
}
fn attachment(value: &Value, source: bool) -> String {
    let mut bits = vec![&value["name"], &value["mime"]];
    let uri = if source {
        value
            .get("uri")
            .filter(|v| !v.is_null())
            .unwrap_or(&value["source"]["uri"])
    } else {
        &value["uri"]
    };
    bits.push(uri);
    format!(
        "[Attachment] {}",
        bits.into_iter()
            .filter(|v| !v.is_null() && **v != Value::Bool(false) && **v != "")
            .map(string)
            .collect::<Vec<_>>()
            .join(" · ")
    )
}
fn output(value: &Value) -> Option<Value> {
    value.as_array().map(|values| {
        Value::String(clean(
            &values
                .iter()
                .map(|v| match v["type"].as_str() {
                    Some("text") => v["text"].as_str().unwrap_or("").into(),
                    Some("file") => attachment(v, false),
                    _ => describe(v),
                })
                .collect::<Vec<_>>()
                .join("\n\n"),
        ))
    })
}
fn assistant_part(value: &Value) -> Option<MessagePart> {
    match value["type"].as_str() {
        Some("text") => text(value["text"].as_str().unwrap_or(""), None),
        Some("reasoning") => {
            let text = clean(value["text"].as_str().unwrap_or(""));
            (!text.is_empty()).then_some(MessagePart::Reasoning {
                text,
                time_created: None,
            })
        }
        Some("tool") if value["name"].as_str().is_some_and(|name| !name.is_empty()) => {
            let state = &value["state"];
            Some(MessagePart::Tool {
                tool: string(&value["name"]),
                call_id: optional_string(&value["id"]),
                title: None,
                time_created: value["time"]["created"].as_f64(),
                state: Box::new(ToolState {
                    status: match state["status"].as_str() {
                        Some("completed") => "completed",
                        Some("error") => "error",
                        _ => "running",
                    }
                    .into(),
                    input: state.get("input").map(clean_value),
                    output: output(&state["content"]),
                    error: state.get("error").map(clean_value),
                    metadata: state.get("metadata").map(clean_value),
                }),
            })
        }
        _ => text(format!("[Unknown content] {}", describe(value)), None),
    }
}
pub(super) fn message(row: &Value) -> Result<Option<Message>> {
    let raw: Value = serde_json::from_str(row["data"].as_str().unwrap_or(""))?;
    if !raw.is_object() {
        bail!("Invalid OpenCode V2 message: {}", string(&row["id"]));
    }
    let kind = string(&row["type"]);
    if kind == "idle" {
        return Ok(None);
    }
    let mut m = empty_message(row);
    m.role = if ["user", "synthetic", "system", "skill"].contains(&kind.as_str()) {
        Role::User
    } else {
        Role::Assistant
    };
    m.agent = optional_string(&raw["agent"]);
    m.model = optional_string(&raw["model"]["id"]);
    m.provider = optional_string(&raw["model"]["providerID"]);
    m.time_completed = raw["time"]["completed"].as_f64();
    m.mode = (!["user", "assistant"].contains(&kind.as_str())).then_some(kind.clone());
    m.automated = ["synthetic", "system", "skill"]
        .contains(&kind.as_str())
        .then_some(true);
    m.cost = raw["cost"].as_f64();
    m.cost_source = m.cost.map(|_| CostSource::Recorded);
    m.tokens = raw["tokens"].as_object().map(|_| {
        let t = &raw["tokens"];
        MessageTokens {
            input: t["input"].as_f64(),
            output: t["output"].as_f64(),
            reasoning: t["reasoning"].as_f64(),
            cache_read: t["cache"]["read"].as_f64(),
            cache_create: t["cache"]["write"].as_f64(),
        }
    });
    match kind.as_str() {
        "user" => {
            m.parts
                .extend(text(raw["text"].as_str().unwrap_or(""), None));
            for file in raw["files"].as_array().into_iter().flatten() {
                if file["mime"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("image/"))
                    && file["data"].as_str().is_some_and(|s| !s.is_empty())
                {
                    m.parts.push(MessagePart::Image {
                        data: optional_string(&file["data"]),
                        mime_type: optional_string(&file["mime"]),
                        url: None,
                        time_created: None,
                    });
                } else {
                    m.parts.extend(text(attachment(file, true), None));
                }
            }
            for mention in ["agents", "skills"]
                .iter()
                .flat_map(|key| raw[key].as_array().into_iter().flatten())
            {
                if let Some(name) = nonempty(&mention["name"]) {
                    m.parts.extend(text(format!("@{name}"), None));
                }
            }
        }
        "assistant" => {
            let Some(contents) = raw["content"].as_array() else {
                bail!("Invalid OpenCode V2 content: {}", m.id);
            };
            m.parts = contents.iter().filter_map(assistant_part).collect();
            let children: HashSet<_> = m
                .parts
                .iter()
                .filter_map(|part| match part {
                    MessagePart::Tool { tool, state, .. } if tool == "subagent" => state
                        .metadata
                        .as_ref()
                        .and_then(|v| nonempty(&v["sessionID"])),
                    _ => None,
                })
                .collect();
            if children.len() == 1 {
                m.subagent_id = children.into_iter().next();
            }
        }
        "shell" => {
            let status = if raw["status"] == "running" {
                "running"
            } else if raw["status"] == "exited"
                && (raw["exit"].is_null() || number(&raw["exit"]) == 0.0)
            {
                "completed"
            } else {
                "error"
            };
            let mut metadata = Map::new();
            for key in ["shellID", "exit"] {
                if let Some(v) = raw.get(key) {
                    metadata.insert(key.into(), v.clone());
                }
            }
            if let Some(out) = raw["output"].as_object() {
                metadata.extend(out.clone());
            }
            let mut input = Map::new();
            if let Some(command) = raw.get("command") {
                input.insert("command".into(), command.clone());
            }
            m.parts.push(MessagePart::Tool {
                tool: "shell".into(),
                call_id: optional_string(&raw["shellID"]),
                title: None,
                time_created: None,
                state: Box::new(ToolState {
                    status: status.into(),
                    input: Some(clean_value(&Value::Object(input))),
                    output: raw["output"]["output"]
                        .as_str()
                        .map(|s| Value::String(clean(s))),
                    error: (status == "error").then(|| {
                        json!(format!(
                            "Shell {} (exit: {})",
                            string(&raw["status"]),
                            raw.get("exit")
                                .filter(|v| !v.is_null())
                                .map(string)
                                .unwrap_or_else(|| "unknown".into())
                        ))
                    }),
                    metadata: Some(clean_value(&Value::Object(metadata))),
                }),
            });
        }
        "compaction" => {
            let mut values = vec![format!(
                "[Compaction: {}]",
                raw.get("status")
                    .map(string)
                    .unwrap_or_else(|| "undefined".into())
            )];
            for key in ["summary", "recent"] {
                if let Some(s) = nonempty(&raw[key]) {
                    values.push(s);
                }
            }
            m.parts.extend(text(values.join("\n\n"), None));
        }
        "synthetic" | "system" | "skill" => {
            m.parts.extend(text(
                format!(
                    "[{kind}] {}",
                    raw["description"]
                        .as_str()
                        .or_else(|| raw["name"].as_str())
                        .unwrap_or("")
                ),
                None,
            ));
            m.parts
                .extend(text(raw["text"].as_str().unwrap_or(""), None));
        }
        _ => m
            .parts
            .extend(text(format!("[{kind}] {}", describe(&raw)), None)),
    }
    if !raw["error"].is_null() {
        m.parts
            .extend(text(format!("[Error] {}", describe(&raw["error"])), None));
    }
    let has_usage = m.cost.unwrap_or(0.0) > 0.0
        || m.tokens.as_ref().is_some_and(|t| {
            [t.input, t.output, t.reasoning, t.cache_read, t.cache_create]
                .into_iter()
                .flatten()
                .any(|v| v > 0.0)
        });
    Ok((!m.parts.is_empty() || has_usage).then_some(m))
}
