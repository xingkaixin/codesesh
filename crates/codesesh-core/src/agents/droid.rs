use super::{
    claudecode::common::*,
    codex::{ParsedSession, timestamp},
};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File},
    path::{Path, PathBuf},
};

pub fn scan(root: &Path, data_root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let mut paths = Vec::new();
    if root.try_exists()? {
        for entry in walkdir::WalkDir::new(root).max_depth(2).follow_links(false) {
            let entry = entry.context("enumerating Droid sources")?;
            if entry.file_type().is_file()
                && entry.path().extension().is_some_and(|ext| ext == "jsonl")
            {
                paths.push(entry.into_path());
            }
        }
    }
    let models = custom_models(data_root);
    let mut sessions = Vec::new();
    for path in paths {
        match parse(&path, &models, pricing) {
            Err(error) if error.is::<InvalidSession>() => continue,
            result => sessions.extend(result?),
        }
    }
    Ok(sessions)
}

pub fn scan_paths(
    data_root: &Path,
    pricing: &Pricing,
    paths: &[PathBuf],
) -> Result<Vec<ParsedSession>> {
    let models = custom_models(data_root);
    let mut sessions = Vec::new();
    for path in paths.iter().collect::<BTreeSet<_>>() {
        if path.try_exists()? {
            sessions.extend(parse(path, &models, pricing)?);
        }
    }
    Ok(sessions)
}

fn custom_models(data_root: &Path) -> HashMap<String, String> {
    let settings = read_json(&data_root.join("settings.json"));
    settings["customModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            Some((
                entry["id"].as_str()?.into(),
                entry["model"].as_str()?.into(),
            ))
        })
        .collect()
}

fn read_json(path: &Path) -> Value {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

fn model(value: &Value, custom_models: &HashMap<String, String>) -> Option<String> {
    let id = value.as_str().map(str::trim).filter(|id| !id.is_empty())?;
    Some(
        custom_models
            .get(id)
            .cloned()
            .unwrap_or_else(|| id.strip_prefix("custom:").unwrap_or(id).into()),
    )
}

fn output(value: &Value, time: f64) -> Vec<MessagePart> {
    match value {
        Value::String(value) => text_part(value, time).into_iter().collect(),
        Value::Array(items) => items
            .iter()
            .filter_map(|item| text_part(&text(&item["text"]), time))
            .collect(),
        _ => Vec::new(),
    }
}

fn parse(
    path: &Path,
    custom_models: &HashMap<String, String>,
    pricing: &Pricing,
) -> Result<Option<ParsedSession>> {
    let file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut lines = super::jsonl::JsonLines::new(file);
    let start = lines
        .next_line()?
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|record| record["type"] == "session_start")
        .ok_or(InvalidSession("missing Droid session_start"))?;
    let id = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut messages = Vec::<Message>::new();
    let mut tools = HashMap::<String, (usize, usize)>::new();
    while let Some(line) = lines.next_line()? {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let raw = &record["message"];
        if record["type"] != "message" || raw["visibility"] == "llm_only" {
            continue;
        }
        let time = timestamp(&record);
        let content = &raw["content"];
        let blocks = content.as_array().map(Vec::as_slice).unwrap_or_default();
        let mut parts: Vec<_> = content
            .as_str()
            .and_then(|value| text_part(value, time))
            .into_iter()
            .collect();
        let role = if raw["role"] == "assistant" {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => parts.extend(text_part(&text(&block["text"]), time)),
                    Some("thinking") => {
                        let text = clean(&text(&block["thinking"]));
                        if !text.is_empty() {
                            parts.push(MessagePart::Reasoning {
                                text,
                                time_created: Some(time),
                            });
                        }
                    }
                    Some("tool_use") => {
                        let tool = text(&block["name"]);
                        let call = text(&block["id"]);
                        tools.insert(call.clone(), (messages.len(), parts.len()));
                        parts.push(MessagePart::Tool {
                            title: Some(format!("Tool: {tool}")),
                            tool,
                            call_id: Some(call),
                            time_created: Some(time),
                            state: Box::new(ToolState {
                                status: "running".into(),
                                input: Some(
                                    block
                                        .get("input")
                                        .filter(|value| !value.is_null())
                                        .cloned()
                                        .unwrap_or(json!({})),
                                ),
                                output: None,
                                error: None,
                                metadata: None,
                            }),
                        });
                    }
                    _ => {}
                }
            }
            Role::Assistant
        } else {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => parts.extend(text_part(&text(&block["text"]), time)),
                    Some("tool_result") => {
                        if let Some(&(index, part)) = tools.get(&text(&block["tool_use_id"]))
                            && let MessagePart::Tool { state, .. } =
                                &mut messages[index].parts[part]
                        {
                            state.status = if block["is_error"] == true {
                                "error"
                            } else {
                                "completed"
                            }
                            .into();
                            state.output =
                                Some(serde_json::to_value(output(&block["content"], time))?);
                        }
                    }
                    _ => {}
                }
            }
            Role::User
        };
        if parts.is_empty() {
            continue;
        }
        let mut message = message(text(&record["id"]), role, time, parts);
        message.cost = None;
        if message.role == Role::Assistant {
            message.agent = Some("droid".into());
        }
        messages.push(message);
    }
    finish_messages(&mut messages);
    if messages.is_empty() {
        return Ok(None);
    }

    let settings = read_json(&path.with_extension("settings.json"));
    let usage = &settings["tokenUsage"];
    let count = |key: &str| {
        usage[key]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(0.0)
    };
    let (read, create) = (count("cacheReadTokens"), count("cacheCreationTokens"));
    let input = count("inputTokens") + read + create;
    let output = count("outputTokens");
    // Droid counts thinking inside outputTokens: OpenAI reasoning, Gemini thoughts, or an estimate.
    let reasoning = count("thinkingTokens").min(output);
    let model = model(&settings["model"], custom_models);
    let mut stats = SessionStats {
        message_count: messages.len(),
        total_input_tokens: input,
        total_output_tokens: output,
        total_cache_read_tokens: (read > 0.0).then_some(read),
        total_cache_create_tokens: (create > 0.0).then_some(create),
        ..Default::default()
    };
    let mut models = BTreeMap::new();
    if input + output > 0.0 {
        let tokens = MessageTokens {
            input: Some(input),
            output: Some(output - reasoning),
            reasoning: (reasoning > 0.0).then_some(reasoning),
            cache_read: stats.total_cache_read_tokens,
            cache_create: stats.total_cache_create_tokens,
            ..Default::default()
        };
        stats.total_cost = pricing
            .estimate_aggregate_tracked(model.as_deref(), &tokens, 0.0, &mut stats.cost_inputs)
            .unwrap_or(0.0);
        stats.cost_source = (stats.total_cost > 0.0).then_some(CostSource::Estimated);
        if let Some(model) = model {
            models.insert(model, input + output);
        }
    }

    let first = |keys: &[&str]| {
        keys.iter()
            .filter_map(|key| start[*key].as_str().map(str::trim))
            .find(|value| !value.is_empty())
    };
    let directory = first(&["lastCwd", "cwd"]).unwrap_or_default().to_owned();
    let session_title = first(&["sessionTitle", "title"])
        .filter(|value| *value != "New Session")
        .and_then(title)
        .or_else(|| {
            messages
                .iter()
                .filter(|message| message.role == Role::User)
                .flat_map(|message| &message.parts)
                .find_map(|part| match part {
                    MessagePart::Text { text, .. } => title(text),
                    _ => None,
                })
        })
        .or_else(|| title(&Path::new(&directory).file_name()?.to_string_lossy()))
        .unwrap_or_else(|| "Untitled Session".into());
    let parent = first(&["callingSessionId", "parent"])
        .filter(|parent| *parent != id)
        .map(|parent| SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "droid".into(),
            session_id: parent.into(),
        });
    let created = messages[0].time_created;
    let updated = messages.last().unwrap().time_created.max(created);
    let mut detail = detail(
        SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "droid".into(),
            session_id: id,
        },
        directory,
        session_title,
        created,
        updated,
        messages,
        models,
    );
    detail.head.stats = stats;
    detail.head.parent_reference = parent;
    Ok(Some(ParsedSession {
        source: path.to_owned(),
        head: detail.head.clone(),
        detail,
    }))
}

#[cfg(test)]
mod tests;
