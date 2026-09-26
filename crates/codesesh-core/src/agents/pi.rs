use super::{
    claudecode::common::*,
    codex::{ParsedSession, timestamp},
};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    path::Path,
};
use walkdir::WalkDir;

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let nested = root.join("agent/sessions");
    let root = if nested.is_dir() {
        nested.as_path()
    } else {
        root
    };
    match std::fs::metadata(root) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => anyhow::bail!("Agent source root is not a directory: {}", root.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    }
    let mut sessions = Vec::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.context("enumerating Pi sources")?;
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        let result = match parse(entry.path(), pricing) {
            Err(error) if error.is::<InvalidSession>() => continue,
            result => result?,
        };
        if let Some(detail) = result {
            sessions.push(ParsedSession {
                source: entry.into_path(),
                head: detail.head.clone(),
                detail,
            });
        }
    }
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
    changed_paths: &[std::path::PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> Result<super::ScanDelta> {
    let nested = root.join("agent/sessions");
    let root = if nested.is_dir() {
        nested.as_path()
    } else {
        root
    };
    let sources = changed_sources(root, changed_paths, previous)?;
    let mut upserts = Vec::new();
    let mut removed = Vec::new();
    for source in sources {
        let old: Vec<_> = previous.iter().filter(|old| old.source == source).collect();
        let parsed = match std::fs::metadata(&source) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
            Ok(_) => parse(&source, pricing)?,
        };
        for old in old {
            if parsed
                .as_ref()
                .is_none_or(|detail| detail.head.reference != old.head.reference)
            {
                removed.push(old.head.reference.clone());
            }
        }
        if let Some(detail) = parsed {
            upserts.push(ParsedSession {
                source,
                head: detail.head.clone(),
                detail,
            });
        }
    }
    Ok(super::ScanDelta {
        upserts,
        removed,
        complete: false,
    })
}

fn time(entry: &Value) -> f64 {
    entry["timestamp"]
        .as_str()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .unwrap_or_else(|| timestamp(entry))
}

fn coerced_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.0),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        Value::String(s) if s.trim().is_empty() => Some(0.0),
        Value::String(s) => s.trim().parse().ok(),
        Value::Array(a) => coerced_number(&Value::String(
            a.iter().map(text).collect::<Vec<_>>().join(","),
        )),
        _ => None,
    }
}

fn content(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|v| match v["type"].as_str() {
                Some("text") => Some(text(&v["text"])),
                Some("image") => Some("[image]".into()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn text_parts(value: &Value, time: f64) -> Vec<MessagePart> {
    text_part(&content(value), time).into_iter().collect()
}

fn assistant_parts(value: &Value, time: f64) -> Vec<MessagePart> {
    let mut parts = Vec::new();
    for item in value.as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("text") => parts.extend(text_part(&text(&item["text"]), time)),
            Some("thinking") => {
                let text = clean(&text(&item["thinking"]));
                if !text.is_empty() {
                    parts.push(MessagePart::Reasoning {
                        text,
                        time_created: Some(time),
                    });
                }
            }
            Some("toolCall") => {
                let tool = text(&item["name"]).trim().to_owned();
                let tool = if tool.is_empty() { "tool".into() } else { tool };
                let id = text(&item["id"]).trim().to_owned();
                parts.push(MessagePart::Tool {
                    title: Some(format!("Tool: {tool}")),
                    tool,
                    call_id: (!id.is_empty()).then_some(id),
                    time_created: Some(time),
                    state: Box::new(ToolState {
                        status: "running".into(),
                        input: Some(
                            item.get("arguments")
                                .filter(|v| !v.is_null())
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
    parts
}

pub fn parse(path: &Path, pricing: &Pricing) -> Result<Option<SessionDetail>> {
    let file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut header = None;
    struct Entry {
        id: Option<String>,
        parent: Option<String>,
        offset: u64,
    }
    let mut entries = Vec::<Entry>::new();
    let mut offset = 0;
    let mut lines = super::jsonl::JsonLines::new(file);
    while let Some(line) = lines.next_line()? {
        let start = offset;
        offset += line.len() as u64;
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if !record.is_object() {
            continue;
        }
        if record["type"] == "session" {
            if header.is_none() {
                header = Some(record);
            }
        } else {
            entries.push(Entry {
                id: record["id"].as_str().map(str::to_owned),
                parent: record["parentId"].as_str().map(str::to_owned),
                offset: start,
            });
        }
    }
    let Some(header) = header else {
        return Err(InvalidSession("missing Pi session header").into());
    };
    let by_id: HashMap<&str, usize> = entries
        .iter()
        .enumerate()
        .filter_map(|(i, e)| e.id.as_deref().filter(|s| !s.is_empty()).map(|s| (s, i)))
        .collect();
    let mut current = entries.iter().rposition(|e| e.id.is_some());
    let mut seen = HashSet::new();
    let mut branch = Vec::new();
    while let Some(index) = current {
        let entry = &entries[index];
        let id = entry.id.as_deref().unwrap_or("");
        if id.is_empty() || !seen.insert(id) {
            break;
        }
        branch.push(index);
        current = entry
            .parent
            .as_deref()
            .and_then(|id| by_id.get(id))
            .copied();
    }
    if branch.is_empty() {
        return Err(InvalidSession("empty Pi session tree").into());
    }
    branch.reverse();
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let id = stem
        .split_once('_')
        .map(|(_, id)| id)
        .filter(|id| !id.is_empty())
        .unwrap_or(&stem)
        .to_owned();
    let cwd = text(&header["cwd"]).trim().to_owned();
    let cwd = if cwd.is_empty() {
        stem.to_string()
    } else {
        cwd
    };
    let created = match time(&header) {
        0.0 => mtime(path)?,
        n => n,
    };
    let mut updated = created;
    let mut explicit_title = None;
    let mut prompt_title = None;
    let mut messages = Vec::<Message>::new();
    let mut models = BTreeMap::<String, f64>::new();
    let mut tools = HashMap::<String, (usize, usize)>::new();
    let mut reader = BufReader::with_capacity(64 * 1024, File::open(path)?);
    let mut line = String::new();
    let mut position = 0;
    for index in branch {
        if position != entries[index].offset {
            reader.seek(SeekFrom::Start(entries[index].offset))?;
            position = entries[index].offset;
        }
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        } else {
            line.clear();
        }
        position += reader.read_line(&mut line)? as u64;
        let entry: Value = serde_json::from_str(&line)?;
        if entry["id"].as_str() != entries[index].id.as_deref()
            || entry["parentId"].as_str() != entries[index].parent.as_deref()
        {
            return Err(InvalidSession("Pi source changed while reading").into());
        }
        let ts = time(&entry);
        updated = updated.max(ts);
        if entry["type"] == "session_info"
            && let Some(value) = title(&text(&entry["name"]))
        {
            explicit_title = Some(value);
        }
        if prompt_title.is_none()
            && entry["type"] == "message"
            && entry["message"]["role"] == "user"
        {
            prompt_title = title(&content(&entry["message"]["content"]));
        }
        let id = entry["id"].as_str().unwrap_or("").to_owned();
        let kind = entry["type"].as_str().unwrap_or("");
        let raw = &entry["message"];
        let mut msg = if kind == "message" {
            match raw["role"].as_str().unwrap_or("") {
                "user" => message(id, Role::User, ts, text_parts(&raw["content"], ts)),
                "custom" if raw["display"] == true => {
                    let mut m = message(id, Role::User, ts, text_parts(&raw["content"], ts));
                    m.automated = Some(true);
                    m
                }
                "assistant" => {
                    let parts = assistant_parts(&raw["content"], ts);
                    if parts.is_empty() {
                        continue;
                    }
                    let mut m = message(id, Role::Assistant, ts, parts);
                    m.agent = Some("pi".into());
                    m.model = raw["model"].as_str().map(|s| s.trim().into());
                    m.provider = raw["provider"].as_str().map(str::to_owned);
                    let u = &raw["usage"];
                    let number = |key: &str| u[key].as_f64().unwrap_or(0.0);
                    let (input, output, read, write) = (
                        number("input"),
                        number("output"),
                        number("cacheRead"),
                        number("cacheWrite"),
                    );
                    let tokens = MessageTokens {
                        input: Some(input + read + write),
                        output: Some(output),
                        reasoning: None,
                        cache_read: (read != 0.0).then_some(read),
                        cache_create: (write != 0.0).then_some(write),
                    };
                    let recorded =
                        coerced_number(&u["cost"]["total"]).filter(|v| v.is_finite() && *v != 0.0);
                    m.cost = recorded.or_else(|| {
                        pricing.estimate_tracked(
                            m.model.as_deref(),
                            &tokens,
                            0.0,
                            &mut m.cost_inputs,
                        )
                    });
                    m.cost_source =
                        (m.cost.unwrap_or(0.0) > 0.0).then_some(if recorded.is_some() {
                            CostSource::Recorded
                        } else {
                            CostSource::Estimated
                        });
                    m.tokens = Some(tokens);
                    let total = u["totalTokens"]
                        .as_f64()
                        .unwrap_or(input + output + read + write);
                    if total > 0.0
                        && let Some(model) = m.model.as_ref().filter(|s| !s.is_empty())
                    {
                        *models.entry(model.clone()).or_default() += total;
                    }
                    m
                }
                "toolResult" => {
                    let call_id = text(&raw["toolCallId"]).trim().to_owned();
                    if let Some((i, p)) = tools.remove(&call_id)
                        && let MessagePart::Tool { state, .. } = &mut messages[i].parts[p]
                    {
                        state.output = Some(serde_json::to_value(text_parts(&raw["content"], ts))?);
                        state.status = if raw["isError"] == true {
                            "error"
                        } else {
                            "completed"
                        }
                        .into();
                        state.metadata = raw.get("details").cloned();
                    }
                    continue;
                }
                "bashExecution" => {
                    let output = text(&raw["output"]);
                    let is_error = coerced_number(&raw["exitCode"]).unwrap_or(f64::NAN) != 0.0
                        || raw["cancelled"] == true;
                    let metadata: serde_json::Map<String, Value> =
                        ["exitCode", "cancelled", "truncated", "fullOutputPath"]
                            .into_iter()
                            .filter_map(|k| raw.get(k).map(|v| (k.into(), v.clone())))
                            .collect();
                    message(
                        id,
                        Role::Tool,
                        ts,
                        vec![MessagePart::Tool {
                            tool: "bash".into(),
                            title: Some("Tool: bash".into()),
                            call_id: None,
                            time_created: Some(ts),
                            state: Box::new(ToolState {
                                status: if is_error { "error" } else { "completed" }.into(),
                                input: Some(json!({"command": text(&raw["command"])})),
                                output: Some(if output.is_empty() {
                                    json!([])
                                } else {
                                    json!([{ "type":"text", "text":output, "time_created":ts }])
                                }),
                                error: None,
                                metadata: Some(Value::Object(metadata)),
                            }),
                        }],
                    )
                }
                "branchSummary" | "compactionSummary" => {
                    let mut m = message(
                        id,
                        Role::Assistant,
                        ts,
                        text_part(text(&raw["summary"]).trim(), ts)
                            .into_iter()
                            .collect(),
                    );
                    m.agent = Some("pi".into());
                    m
                }
                _ => continue,
            }
        } else if matches!(kind, "compaction" | "branch_summary" | "custom_message") {
            if kind == "custom_message" && entry["display"] != true {
                continue;
            }
            let custom = kind == "custom_message";
            let value = if custom {
                content(&entry["content"])
            } else {
                text(&entry["summary"])
            };
            let mut m = message(
                id,
                if custom { Role::User } else { Role::Assistant },
                ts,
                text_part(&value, ts).into_iter().collect(),
            );
            m.agent = (!custom).then_some("pi".into());
            m.automated = custom.then_some(true);
            m
        } else {
            continue;
        };
        if msg.parts.is_empty() {
            continue;
        }
        for (p, part) in msg.parts.iter().enumerate() {
            if let MessagePart::Tool {
                call_id: Some(id), ..
            } = part
            {
                tools.insert(id.clone(), (messages.len(), p));
            }
        }
        msg.time_completed = None;
        if msg.cost == Some(0.0) {
            msg.cost = None;
        }
        messages.push(msg);
    }
    finish_messages(&mut messages);
    if messages.is_empty() {
        return Ok(None);
    }
    let title = explicit_title
        .or(prompt_title)
        .or_else(|| {
            title(
                &Path::new(&cwd)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
            )
        })
        .unwrap_or_else(|| "Untitled Session".into());
    Ok(Some(detail(
        SessionReference {
            agent_name: "pi".into(),
            session_id: id,
        },
        cwd,
        title,
        created,
        updated,
        messages,
        models,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incremental_update_only_reads_changed_transcript_and_reports_deletion() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("session.jsonl");
        let records = [
            json!({"type":"session","cwd":"/tmp/project","timestamp":1000}),
            json!({"type":"message","id":"u","parentId":null,"message":{"role":"user","content":"Before"}}),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let pricing = Pricing::bundled();
        let previous = scan(root.path(), &pricing).unwrap();
        let mut records = records.to_vec();
        records.push(json!({"type":"custom_message","id":"notice","parentId":"u","display":true,"content":"After"}));
        std::fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        std::fs::create_dir(root.path().join("unrelated.jsonl")).unwrap();
        let changed = scan_changed(
            root.path(),
            &pricing,
            std::slice::from_ref(&path),
            &previous
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(changed.upserts.len(), 1);
        assert_eq!(changed.upserts[0].detail.messages.len(), 2);
        assert!(changed.removed.is_empty());
        std::fs::write(&path, "broken").unwrap();
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
    #[test]
    fn cyclic_branch_terminates_and_first_header_wins() {
        let root = tempfile::tempdir().unwrap();
        let records = [
            json!({"type":"session","timestamp":"1776679200000","cwd":"/tmp/first"}),
            json!({"type":"session","timestamp":1,"cwd":"/tmp/ignored"}),
            json!({"type":"message","id":"a","parentId":"b","timestamp":"1776679201000","message":{"role":"user","content":"Hello"}}),
            json!({"type":"message","id":"b","parentId":"a","timestamp":"1776679202000","message":{"role":"custom","display":true,"content":"Notice"}}),
        ];
        std::fs::write(
            root.path().join("session.jsonl"),
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        assert_eq!(sessions[0].head.directory, "/tmp/first");
        assert_eq!(sessions[0].head.time_created, 1776679200000.0);
        assert_eq!(sessions[0].head.time_updated, 1776679202000.0);
        assert_eq!(sessions[0].detail.messages.len(), 2);
        assert_eq!(sessions[0].detail.messages[1].automated, Some(true));
    }
    #[test]
    fn fractional_timestamps_and_cached_cursor_match_node() {
        let root = tempfile::tempdir().unwrap();
        let records: Vec<Value> =
            serde_json::from_str(include_str!("pi/fixtures/fractional-records.json")).unwrap();
        let path = root.path().join("fractional.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let mut sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let expected = include_str!("pi/fixtures/fractional-expected.json");
        assert_reference(&sessions[0].head, &sessions[0].detail, expected);
        let expected: Value = serde_json::from_str(expected).unwrap();
        let mut cache = crate::storage::Cache::open(None).unwrap();
        cache.publish(&mut sessions).unwrap();
        let detail = cache.detail(sessions[0].head.clone()).unwrap().unwrap();
        assert_eq!(
            detail.message_cursor.as_deref(),
            expected["cursor"].as_str()
        );
        assert_eq!(detail.messages[1].time_created, 1776679200000.875);
        assert_eq!(detail.head.time_updated, 1776679200000.875);
    }
    #[test]
    fn matches_frozen_node_adapter_fixture() {
        let root = tempfile::tempdir().unwrap();
        let records: Vec<Value> =
            serde_json::from_str(include_str!("pi/fixtures/records.json")).unwrap();
        std::fs::write(
            root.path().join("2026-04-20_session.jsonl"),
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
        assert_reference(
            &sessions[0].head,
            &sessions[0].detail,
            include_str!("pi/fixtures/expected.json"),
        );
    }
    #[test]
    fn active_branch_automated_messages_and_tool_usage() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("2026-04-20_branch.jsonl");
        let records = [
            json!({"type":"session","id":"ignored-header-id","cwd":"/tmp/project","timestamp":"2026-04-20T10:00:00Z"}),
            json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"Human prompt"}}),
            json!({"type":"message","id":"abandoned","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"Abandoned"}]}}),
            json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","model":"claude-sonnet-4-5","usage":{"input":100,"output":20,"cacheRead":10,"cacheWrite":5,"cost":{"total":0.25}},"content":[{"type":"toolCall","id":"call","name":"read","arguments":{"path":"a"}}]}}),
            json!({"type":"message","id":"c","parentId":"b","message":{"role":"toolResult","toolCallId":"call","content":"Result","isError":false}}),
            json!({"type":"custom_message","id":"d","parentId":"c","display":true,"content":"Extension notice"}),
            json!({"type":"session_info","id":"e","parentId":"d","name":"Named session"}),
        ];
        std::fs::write(
            &path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let detail = parse(&path, &Pricing::bundled()).unwrap().unwrap();
        assert_eq!(detail.head.reference.session_id, "branch");
        assert_eq!(detail.head.title, "Named session");
        assert_eq!(detail.messages.len(), 3);
        assert_eq!(detail.messages[2].automated, Some(true));
        assert_eq!(detail.head.stats.total_input_tokens, 115.0);
        assert_eq!(detail.head.stats.total_cost, 0.25);
        let MessagePart::Tool { state, .. } = &detail.messages[1].parts[0] else {
            panic!()
        };
        assert_eq!(state.status, "completed");
        assert_eq!(state.output.as_ref().unwrap()[0]["text"], "Result");
    }
}
