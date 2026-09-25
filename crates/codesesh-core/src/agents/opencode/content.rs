use super::{number, optional_string, string};
use crate::{contract::*, pricing::Pricing};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

static CLEANERS: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    let mut result = Vec::new();
    for tag in [
        "command-message",
        "command-name",
        "local-command-caveat",
        "local-command-stdout",
        "system-reminder",
    ] {
        result.push((
            Regex::new(&format!(
                r"(?i)(^|\r?\n)[ \t]*<{tag}\b[^>]*>[\s\S]*?</{tag}>[ \t]*(?:\r?\n|$)"
            ))
            .unwrap(),
            "$1".into(),
        ));
        result.push((
            Regex::new(&format!(r"(?i)<{tag}\b[^>]*>[\s\S]*?</{tag}>")).unwrap(),
            String::new(),
        ));
        result.push((
            Regex::new(&format!(r"(?i)\n*<{tag}\b[^>]*>[\s\S]*$")).unwrap(),
            String::new(),
        ));
    }
    for tag in [
        "command-message",
        "command-name",
        "local-command-caveat",
        "local-command-stdout",
        "system-reminder",
        "command-args",
    ] {
        result.push((
            Regex::new(&format!(r"(?i)</?{tag}\b[^>]*>")).unwrap(),
            String::new(),
        ));
    }
    result
});
pub(super) fn clean(text: &str) -> String {
    let mut text = text.to_owned();
    for (regex, replacement) in CLEANERS.iter() {
        text = regex.replace_all(&text, replacement).into_owned();
    }
    let lines = text
        .split('\n')
        .map(|line| {
            let cr = line.ends_with('\r');
            let line = line.trim_end_matches([' ', '\t', '\r']);
            format!("{line}{}", if cr { "\r" } else { "" })
        })
        .collect::<Vec<_>>()
        .join("\n");
    let result = lines.trim_end_matches(['\n', '\r']).to_owned();
    if result.trim().is_empty() {
        String::new()
    } else {
        result
    }
}
fn clean_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(clean(text)),
        Value::Array(values) => Value::Array(values.iter().map(clean_value).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), clean_value(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}
pub(super) fn title(text: &str) -> Option<String> {
    let text = clean(text);
    let text = text
        .lines()
        .find(|line| !line.trim().is_empty())?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    Some(String::from_utf16_lossy(
        &text.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
}
pub(super) fn internal(value: &Value) -> bool {
    let normalized = string(value).trim().to_lowercase().replace(['_', '-'], " ");
    matches!(
        normalized.as_str(),
        "progress" | "file history snapshot" | "queue operation" | "last prompt"
    )
}
fn text(text: impl AsRef<str>, time: Option<f64>) -> Option<MessagePart> {
    let text = clean(text.as_ref());
    (!text.is_empty()).then_some(MessagePart::Text {
        text,
        time_created: time,
    })
}
fn plan_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.into();
    }
    if value.is_object() {
        for key in ["text", "plan", "content"] {
            if let Some(value) = value.get(key) {
                return plan_text(value);
            }
        }
    }
    String::new()
}
fn first(values: &[Option<&Value>]) -> Option<Value> {
    values.iter().flatten().next().map(|v| clean_value(v))
}
fn nonempty(value: &Value) -> Option<String> {
    optional_string(value).filter(|s| !s.is_empty())
}
pub(super) fn part(raw: &Value, time: f64) -> Option<MessagePart> {
    let time = Some(time);
    match raw["type"].as_str()? {
        "text" => text(raw["text"].as_str()?, time),
        "reasoning" => {
            let text = clean(raw["text"].as_str()?);
            (!text.is_empty()).then_some(MessagePart::Reasoning {
                text,
                time_created: time,
            })
        }
        "plan" => {
            let approval_status = if raw["approval_status"] == "fail" {
                "fail"
            } else {
                "success"
            };
            let text = clean(&plan_text(
                raw.get("text").filter(|v| !v.is_null()).unwrap_or(
                    &raw[if approval_status == "fail" {
                        "output"
                    } else {
                        "input"
                    }],
                ),
            ));
            (!text.is_empty()).then_some(MessagePart::Plan {
                text,
                approval_status: approval_status.into(),
                time_created: time,
            })
        }
        "image" => {
            let data = nonempty(&raw["data"]);
            let url = nonempty(&raw["url"]);
            let mime_type = nonempty(&raw["mime_type"]);
            ((data.is_some() && mime_type.is_some()) || url.is_some()).then_some(
                MessagePart::Image {
                    data,
                    url,
                    mime_type,
                    time_created: time,
                },
            )
        }
        "tool" => {
            let title = nonempty(&raw["title"]);
            let tool = nonempty(&raw["tool"])
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    title.as_ref().map(|s| {
                        if s.to_lowercase().starts_with("tool:") {
                            s[5..].trim().into()
                        } else {
                            s.trim().into()
                        }
                    })
                })?;
            if tool.is_empty() {
                return None;
            }
            let state = &raw["state"];
            let input = first(&[state.get("input"), state.get("arguments"), raw.get("input")]);
            let output = first(&[state.get("output"), state.get("result"), raw.get("output")]);
            let error = state.get("error").map(clean_value);
            let status = match state["status"].as_str() {
                Some("running") => "running",
                Some("error") => "error",
                Some("completed" | "success") => "completed",
                _ if error.as_ref().is_some_and(|v| !v.is_null()) => "error",
                _ if output.is_some() => "completed",
                _ => "running",
            };
            let mut metadata = state
                .get("metadata")
                .filter(|v| !v.is_null())
                .or_else(|| state.get("meta"))
                .cloned();
            let extras: Map<_, _> = state
                .as_object()
                .into_iter()
                .flatten()
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
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            if !extras.is_empty() {
                let mut merged = metadata
                    .as_ref()
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                merged.extend(extras);
                metadata = Some(Value::Object(merged));
            }
            Some(MessagePart::Tool {
                tool,
                title: title.map(|s| clean(&s)).filter(|s| !s.is_empty()),
                call_id: nonempty(&raw["callID"]),
                time_created: time,
                state: Box::new(ToolState {
                    status: status.into(),
                    input,
                    output,
                    error,
                    metadata: metadata.as_ref().map(clean_value),
                }),
            })
        }
        _ => None,
    }
}
fn empty_message(row: &Value) -> Message {
    Message {
        id: string(&row["id"]),
        role: Role::Assistant,
        agent: None,
        time_created: number(&row["time_created"]),
        time_completed: None,
        mode: None,
        model: None,
        provider: None,
        tokens: None,
        cost: None,
        cost_source: None,
        parts: Vec::new(),
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}
pub(super) fn v1_message(
    row: &Value,
    raw: &Value,
    parts: Vec<MessagePart>,
    pricing: &Pricing,
) -> Message {
    let tokens = raw["tokens"].as_object().map(|_| MessageTokens {
        input: Some(number(&raw["tokens"]["input"])),
        output: Some(number(&raw["tokens"]["output"])),
        reasoning: None,
        cache_read: None,
        cache_create: None,
    });
    let model = optional_string(&raw["modelID"]);
    let recorded = number(&raw["cost"]);
    let estimated = if recorded > 0.0 {
        None
    } else {
        pricing.estimate(
            model.as_deref(),
            &tokens.clone().unwrap_or(MessageTokens {
                input: Some(0.0),
                output: Some(0.0),
                reasoning: None,
                cache_read: None,
                cache_create: None,
            }),
            0.0,
        )
    };
    let cost = if recorded != 0.0 {
        recorded
    } else {
        estimated.unwrap_or(0.0)
    };
    Message {
        role: match raw["role"].as_str() {
            Some("user") => Role::User,
            Some("tool") => Role::Tool,
            _ => Role::Assistant,
        },
        agent: optional_string(&raw["agent"]),
        mode: optional_string(&raw["mode"]),
        model,
        provider: optional_string(&raw["providerID"]),
        tokens,
        cost: Some(cost),
        cost_source: (cost > 0.0).then_some(if recorded > 0.0 {
            CostSource::Recorded
        } else {
            CostSource::Estimated
        }),
        parts,
        ..empty_message(row)
    }
}
pub(super) fn stats(messages: &[Message]) -> SessionStats {
    let mut stats = SessionStats {
        message_count: messages.len(),
        ..Default::default()
    };
    let mut estimated = false;
    for m in messages {
        stats.total_cost += m.cost.unwrap_or(0.0);
        if let Some(t) = &m.tokens {
            stats.total_input_tokens += t.input.unwrap_or(0.0);
            stats.total_output_tokens += t.output.unwrap_or(0.0);
        }
        estimated |= m.cost_source == Some(CostSource::Estimated);
    }
    stats.cost_source = (stats.total_cost > 0.0).then_some(if estimated {
        CostSource::Estimated
    } else {
        CostSource::Recorded
    });
    stats
}
pub(super) fn token_total(tokens: &MessageTokens) -> f64 {
    [
        tokens.input,
        tokens.output,
        tokens.reasoning,
        tokens.cache_read,
        tokens.cache_create,
    ]
    .into_iter()
    .flatten()
    .sum()
}

mod v2;

pub(super) fn v2_message(row: &Value) -> anyhow::Result<Option<Message>> {
    v2::message(row)
}
