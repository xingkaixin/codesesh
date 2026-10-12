use super::{claudecode::common::*, codex::ParsedSession};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
};

pub fn is_source(root: &Path, path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext == "json" || ext == "jsonl")
        && path
            .strip_prefix(root)
            .is_ok_and(|relative| relative.components().count() >= 3)
        && in_chats(root, path)
}

fn in_chats(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    let components: Vec<_> = relative.components().collect();
    components.len() <= 1 || components.len() <= 4 && components[1].as_os_str() == "chats"
}

fn sources(root: &Path, paths: &[PathBuf]) -> Result<BTreeSet<PathBuf>> {
    let mut sources = BTreeSet::new();
    for path in paths {
        let path = if root.starts_with(path) {
            root
        } else if path.starts_with(root) {
            path.as_path()
        } else {
            continue;
        };
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_dir() => {
                let entries = walkdir::WalkDir::new(path)
                    .follow_links(false)
                    .into_iter()
                    .filter_entry(|entry| in_chats(root, entry.path()));
                for entry in entries {
                    let entry = entry.context("enumerating Gemini CLI sources")?;
                    if entry.file_type().is_file() && is_source(root, entry.path()) {
                        sources.insert(entry.into_path());
                    }
                }
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        if is_source(root, path) {
            sources.insert(path.with_extension("json"));
            sources.insert(path.with_extension("jsonl"));
        }
    }
    Ok(sources)
}

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let mut sessions = Vec::new();
    for source in sources(root, &[root.to_owned()])? {
        match parse(&source, root, pricing) {
            Err(error) if error.is::<InvalidSession>() => {}
            result => sessions.extend(result?),
        }
    }
    Ok(sessions)
}

pub fn scan_changed(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> Result<super::ScanDelta> {
    let mut sources = sources(root, changed_paths)?;
    sources.extend(
        previous
            .iter()
            .filter(|old| {
                changed_paths
                    .iter()
                    .any(|path| old.source.starts_with(path))
            })
            .map(|old| old.source.clone()),
    );
    let mut upserts = Vec::new();
    for source in &sources {
        match parse(source, root, pricing) {
            Err(error)
                if error.is::<InvalidSession>()
                    && !previous.iter().any(|old| &old.source == source) => {}
            result => upserts.extend(result?),
        }
    }
    let retained: HashSet<_> = upserts.iter().map(|s| &s.head.reference).collect();
    let removed = previous
        .iter()
        .filter(|old| sources.contains(&old.source) && !retained.contains(&old.head.reference))
        .map(|old| old.head.reference.clone())
        .collect();
    Ok(super::ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}

#[derive(Default)]
struct Conversation {
    metadata: Map<String, Value>,
    order: Vec<String>,
    messages: HashMap<String, Value>,
}

impl Conversation {
    fn load(text: &str) -> Self {
        let mut conversation = Self::default();
        for line in text.lines() {
            if let Ok(Value::Object(record)) = serde_json::from_str(line) {
                conversation.apply(record);
            }
        }
        if !conversation.metadata.contains_key("sessionId")
            && let Ok(Value::Object(record)) = serde_json::from_str(text)
        {
            conversation = Self::default();
            conversation.merge(record, false);
        }
        conversation
    }

    // Mirrors ChatRecordingService's JSONL accumulator: a rewind drops its target too.
    fn apply(&mut self, mut record: Map<String, Value>) {
        if let Some(Value::String(target)) = record.get("$rewindTo") {
            let start = self.order.iter().position(|id| id == target).unwrap_or(0);
            for id in self.order.drain(start..) {
                self.messages.remove(&id);
            }
        } else if let Some(Value::Object(patch)) = record.get("$patch") {
            self.patch(patch);
            for update in patch
                .get("updates")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(update) = update.as_object() {
                    self.patch(update);
                }
            }
            for id in patch
                .get("removeIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(id) = id.as_str()
                    && self.messages.remove(id).is_some()
                {
                    self.order.retain(|existing| existing != id);
                }
            }
            if let Some(ids) = patch.get("orderIds").and_then(Value::as_array) {
                let mut ordered = Vec::new();
                for id in ids.iter().filter_map(Value::as_str) {
                    if self.messages.contains_key(id) && !ordered.contains(&id) {
                        ordered.push(id);
                    }
                }
                self.order.retain(|id| !ordered.contains(&id.as_str()));
                self.order.extend(ordered.into_iter().map(str::to_owned));
            }
        } else if record.get("id").is_some_and(Value::is_string) {
            self.insert(Value::Object(record));
        } else if let Some(Value::Object(set)) = record.remove("$set") {
            self.merge(set, true);
        } else if record.get("sessionId").is_some_and(Value::is_string)
            && record.get("projectHash").is_some_and(Value::is_string)
        {
            self.merge(record, false);
        }
    }

    fn patch(&mut self, patch: &Map<String, Value>) {
        let Some(message) = patch
            .get("id")
            .and_then(Value::as_str)
            .and_then(|id| self.messages.get_mut(id))
        else {
            return;
        };
        if let Some(content) = patch.get("content") {
            message["content"] = content.clone();
        }
        if message["type"] == "gemini"
            && let Some(calls) = message.get_mut("toolCalls").and_then(Value::as_array_mut)
        {
            for update in patch
                .get("toolCalls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(result) = update.get("result")
                    && let Some(call) = calls.iter_mut().find(|call| call["id"] == update["id"])
                {
                    call["result"] = result.clone();
                }
            }
        }
    }

    fn insert(&mut self, message: Value) {
        let Some(id) = message["id"].as_str().map(str::to_owned) else {
            return;
        };
        if self.messages.insert(id.clone(), message).is_none() {
            self.order.push(id);
        }
    }

    fn merge(&mut self, mut record: Map<String, Value>, replace: bool) {
        if let Some(Value::Array(messages)) = record.remove("messages") {
            if replace {
                self.order.clear();
                self.messages.clear();
            }
            for message in messages {
                self.insert(message);
            }
        }
        self.metadata.extend(record);
    }
}

fn time(value: &Value) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value.as_str()?)
        .ok()
        .map(|time| time.timestamp_millis() as f64)
}

fn parts(content: &Value) -> &[Value] {
    match content {
        Value::Array(items) => items,
        Value::Null => &[],
        _ => std::slice::from_ref(content),
    }
}

fn part_text(part: &Value) -> Option<&str> {
    part.as_str().or_else(|| part["text"].as_str())
}

fn push_text(parts: &mut Vec<MessagePart>, reasoning: bool, value: &str, time: f64) {
    match (parts.last_mut(), reasoning) {
        (Some(MessagePart::Reasoning { text, .. }), true)
        | (Some(MessagePart::Text { text, .. }), false) => text.push_str(value),
        (_, true) => parts.push(MessagePart::Reasoning {
            text: value.into(),
            time_created: Some(time),
        }),
        (_, false) => parts.push(MessagePart::Text {
            text: value.into(),
            time_created: Some(time),
        }),
    }
}

// Some versions copy a whole parallel functionResponse turn into each call's result.
fn response(
    call: &Value,
    id: Option<&str>,
    name: &str,
    later: &HashMap<&str, &Value>,
) -> Option<Value> {
    if let Some(output) = call["result"].as_str() {
        return Some(json!({ "output": output }));
    }
    parts(&call["result"])
        .iter()
        .find_map(|part| {
            let response = part.get("functionResponse")?;
            match response["id"].as_str() {
                Some(other) => Some(other) == id,
                None => response["name"].as_str() == Some(name),
            }
            .then(|| response["response"].clone())
        })
        .or_else(|| later.get(id?).map(|response| (*response).clone()))
}

fn tool(call: &Value, time: f64, later: &HashMap<&str, &Value>) -> MessagePart {
    let id = call["id"].as_str().filter(|id| !id.is_empty());
    let name = text(&call["name"]).trim().to_owned();
    let name = if name.is_empty() { "tool".into() } else { name };
    let response = response(call, id, &name, later);
    let error = response
        .as_ref()
        .map(|response| &response["error"])
        .filter(|error| !error.is_null())
        .cloned();
    let status = match call["status"].as_str() {
        Some("success") => "completed",
        Some("error" | "cancelled") => "error",
        Some(_) => "running",
        None if error.is_some() => "error",
        None if response.is_some() => "completed",
        None => "unknown",
    };
    let output = response
        .filter(|_| error.is_none())
        .map(|response| response.get("output").cloned().unwrap_or(response));
    MessagePart::Tool {
        tool: name,
        call_id: id.map(str::to_owned),
        title: None,
        time_created: Some(time),
        state: Box::new(ToolState {
            status: status.into(),
            input: Some(
                call.get("args")
                    .filter(|args| !args.is_null())
                    .cloned()
                    .unwrap_or(json!({})),
            ),
            output,
            error,
            metadata: None,
        }),
    }
}

fn parse(path: &Path, root: &Path, pricing: &Pricing) -> Result<Option<ParsedSession>> {
    if path.extension().is_some_and(|ext| ext == "json")
        && path.with_extension("jsonl").try_exists()?
    {
        return Ok(None);
    }
    let contents = match std::fs::read_to_string(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result.with_context(|| format!("reading {}", path.display()))?,
    };
    let conversation = Conversation::load(&contents);
    let meta = &conversation.metadata;
    let Some(session_id) = meta
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Err(InvalidSession("missing Gemini CLI session id").into());
    };
    let relative: Vec<_> = path.strip_prefix(root)?.components().collect();
    let directory = match std::fs::read_to_string(root.join(relative[0]).join(".project_root")) {
        Ok(directory) => directory.trim().to_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let ordered: Vec<&Value> = conversation
        .order
        .iter()
        .filter_map(|id| conversation.messages.get(id))
        .collect();
    let created = meta
        .get("startTime")
        .and_then(time)
        .or_else(|| {
            ordered
                .iter()
                .find_map(|message| time(&message["timestamp"]))
        })
        .map_or_else(|| mtime(path), Ok)?;
    let mut updated = meta
        .get("lastUpdated")
        .and_then(time)
        .unwrap_or(created)
        .max(created);
    let mut later = HashMap::new();
    for message in ordered.iter().filter(|message| message["type"] == "user") {
        for part in parts(&message["content"]) {
            let response = &part["functionResponse"];
            if let Some(id) = response["id"].as_str() {
                later.entry(id).or_insert(&response["response"]);
            }
        }
    }
    let mut messages = Vec::new();
    let mut models = BTreeMap::<String, f64>::new();
    let mut reasoning_tokens = 0.0;
    let mut prompt = None;
    for raw in ordered {
        let id = raw["id"].as_str().unwrap_or_default().to_owned();
        let ts = time(&raw["timestamp"]).unwrap_or(created);
        updated = updated.max(ts);
        match raw["type"].as_str() {
            Some("user") => {
                let shown = match &raw["displayContent"] {
                    Value::Null => &raw["content"],
                    display => display,
                };
                let value: String = parts(shown).iter().filter_map(part_text).collect();
                let mut message = message(
                    id,
                    Role::User,
                    ts,
                    text_part(&value, ts).into_iter().collect(),
                );
                let start = value.trim_start();
                if start.starts_with("<session_context>") || start.starts_with("<hook_context>") {
                    message.automated = Some(true);
                } else if prompt.is_none() {
                    prompt = title(&value);
                }
                messages.push(message);
            }
            Some("gemini") => {
                let content = &raw["content"];
                let mut message_parts = Vec::new();
                if !parts(content).iter().any(|part| part["thought"] == true) {
                    let thoughts: Vec<_> = raw["thoughts"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|thought| {
                            let subject = text(&thought["subject"]);
                            let description = text(&thought["description"]);
                            if subject.trim().is_empty() {
                                description
                            } else {
                                format!("**{subject}** {description}")
                            }
                        })
                        .collect();
                    if !thoughts.is_empty() {
                        push_text(&mut message_parts, true, &thoughts.join("\n\n"), ts);
                    }
                }
                let records: Vec<&Value> =
                    raw["toolCalls"].as_array().into_iter().flatten().collect();
                let mut recorded = HashSet::new();
                for part in parts(content) {
                    if let Some(call) = part.get("functionCall") {
                        let record = call["id"].as_str().and_then(|id| {
                            records
                                .iter()
                                .position(|record| record["id"].as_str() == Some(id))
                        });
                        if let Some(index) = record {
                            recorded.insert(index);
                        }
                        message_parts.push(tool(
                            record.map_or(call, |index| records[index]),
                            ts,
                            &later,
                        ));
                    } else if let Some(value) = part_text(part) {
                        push_text(&mut message_parts, part["thought"] == true, value, ts);
                    }
                }
                for (index, record) in records.iter().enumerate() {
                    if !recorded.contains(&index) {
                        message_parts.push(tool(record, ts, &later));
                    }
                }
                let mut message = message(id, Role::Assistant, ts, message_parts);
                message.agent = Some("gemini-cli".into());
                message.model = raw["model"]
                    .as_str()
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_owned);
                if let Some(usage) = raw["tokens"].as_object() {
                    let count = |key: &str| {
                        usage
                            .get(key)
                            .and_then(Value::as_f64)
                            .filter(|count| count.is_finite() && *count > 0.0)
                            .unwrap_or(0.0)
                    };
                    // Gemini's prompt count includes cached tokens; thoughts and tool-use prompts are separate.
                    let input = count("input") + count("tool");
                    let (output, cached, thoughts) =
                        (count("output"), count("cached"), count("thoughts"));
                    let tokens = MessageTokens {
                        input: Some(input),
                        output: Some(output),
                        reasoning: (thoughts > 0.0).then_some(thoughts),
                        cache_read: (cached > 0.0).then_some(cached),
                        ..Default::default()
                    };
                    message.cost = pricing.estimate_tracked(
                        message.model.as_deref(),
                        &tokens,
                        0.0,
                        &mut message.cost_inputs,
                    );
                    message.cost_source = message
                        .cost
                        .filter(|cost| *cost > 0.0)
                        .map(|_| CostSource::Estimated);
                    if let Some(model) = &message.model
                        && input + output + thoughts > 0.0
                    {
                        *models.entry(model.clone()).or_default() += input + output + thoughts;
                    }
                    reasoning_tokens += thoughts;
                    message.tokens = Some(tokens);
                }
                messages.push(message);
            }
            _ => {}
        }
    }
    finish_messages(&mut messages);
    if messages.is_empty() {
        return Ok(None);
    }
    let title = meta
        .get("summary")
        .and_then(Value::as_str)
        .and_then(title)
        .or(prompt)
        .unwrap_or_else(|| "Untitled Session".into());
    let mut detail = detail(
        SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "gemini-cli".into(),
            session_id: session_id.to_owned(),
        },
        directory,
        title,
        created,
        updated,
        messages,
        models,
    );
    detail.head.stats.total_output_tokens += reasoning_tokens;
    if meta.get("kind").is_some_and(|kind| kind == "subagent") && relative.len() == 4 {
        detail.head.parent_reference = Some(SessionReference {
            source_node_id: crate::contract::local_source_node_id(),
            agent_name: "gemini-cli".into(),
            session_id: relative[2].as_os_str().to_string_lossy().into_owned(),
        });
    }
    Ok(Some(ParsedSession {
        source: path.to_owned(),
        head: detail.head.clone(),
        detail,
    }))
}

#[cfg(test)]
mod tests;
