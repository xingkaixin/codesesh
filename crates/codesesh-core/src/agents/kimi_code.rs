use super::{codex::ParsedSession, kimi::helpers::*};
use crate::{contract::*, pricing::Pricing};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
};

pub fn scan(root: &Path, pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
    let sessions = if root.join("sessions").is_dir() {
        root.join("sessions")
    } else {
        root.to_owned()
    };
    scan_directories(&sessions, directories(&sessions)?, pricing)
}

pub fn scan_paths(
    root: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
) -> anyhow::Result<Vec<ParsedSession>> {
    let sessions = if root.join("sessions").is_dir() {
        root.join("sessions")
    } else {
        root.to_owned()
    };
    match affected_session_dirs(&sessions, changed_paths)? {
        Some(paths) => scan_directories(&sessions, paths, pricing),
        None => scan(root, pricing),
    }
}

fn scan_directories(
    sessions: &Path,
    paths: Vec<PathBuf>,
    pricing: &Pricing,
) -> anyhow::Result<Vec<ParsedSession>> {
    let mut workdirs = HashMap::new();
    for record in records(
        &sessions
            .parent()
            .unwrap_or(sessions)
            .join("session_index.jsonl"),
    )? {
        let record = record?;
        if let (Some(path), Some(cwd)) = (record["sessionDir"].as_str(), record["workDir"].as_str())
        {
            let path = std::path::absolute(path)?;
            workdirs.insert(path, cwd.to_owned());
        }
    }
    let mut result = vec![];
    for path in paths {
        let state_path = path.join("state.json");
        let wire_path = path.join("agents/main/wire.jsonl");
        if !state_path.exists() || !wire_path.exists() {
            continue;
        }
        let content = std::fs::read(&state_path)?;
        let Ok(state) = serde_json::from_slice::<Value>(&content) else {
            continue;
        };
        if !state.is_object() {
            continue;
        }
        let created = timestamp(&state["createdAt"])
            .or_else(|| timestamp(&state["created_at"]))
            .unwrap_or(mtime(&state_path)?);
        let updated = timestamp(&state["updatedAt"])
            .or_else(|| timestamp(&state["updated_at"]))
            .unwrap_or(created)
            .max(mtime(&wire_path)?);
        let directory = string(&state["workDir"])
            .or_else(|| string(&state["custom"]["cwd"]))
            .or_else(|| workdirs.get(&std::path::absolute(&path).ok()?).cloned())
            .unwrap_or_default();
        let mut builder = Builder::default();
        let mut ignored = HashSet::new();
        let mut model = None::<String>;
        let mut provider = None::<String>;
        let mut first = None;
        let mut stats = SessionStats::default();
        let mut model_usage = BTreeMap::new();
        let mut read = 0.;
        let mut create = 0.;
        for (seq, r) in records(&wire_path)?.enumerate() {
            let r = r?;
            let ts = timestamp(&r["time"]).unwrap_or(0.);
            let id = format!("wire-{}", seq + 1);
            match r["type"].as_str().unwrap_or("") {
                "llm.request" => {
                    model = string(&r["model"]).or(model);
                    provider = string(&r["provider"]).or(provider);
                }
                "config.update" => model = string(&r["modelAlias"]).or(model),
                "usage.record" => {
                    if !r["usage"].is_object() {
                        continue;
                    }
                    let u = &r["usage"];
                    let cache_read = number(&u["inputCacheRead"]);
                    let cache_create = number(&u["inputCacheCreation"]);
                    let input = number(&u["inputOther"]) + cache_read + cache_create;
                    let output = number(&u["output"]);
                    let m = string(&r["model"]).or_else(|| model.clone());
                    let tokens = MessageTokens {
                        input: Some(input),
                        output: Some(output),
                        cache_read: Some(cache_read),
                        cache_create: Some(cache_create),
                        reasoning: None,
                    };
                    let cost =
                        pricing.estimate_tracked(m.as_deref(), &tokens, 0., &mut stats.cost_inputs);
                    stats.total_input_tokens += input;
                    stats.total_output_tokens += output;
                    stats.total_cost += cost.unwrap_or(0.);
                    read += cache_read;
                    create += cache_create;
                    if let Some(m) = &m {
                        *model_usage.entry(m.clone()).or_insert(0.) += input + output;
                    }
                    builder.usage(
                        tokens,
                        m.as_deref(),
                        cost,
                        stats.cost_inputs.last().unwrap().clone(),
                    );
                }
                "context.append_message" => {
                    let m = &r["message"];
                    let role = m["role"].as_str().unwrap_or("");
                    if role == "user" && first.is_none() {
                        first = title(&content_text(&m["content"], false));
                    }
                    if role == "tool" {
                        let call = m["toolCallId"].as_str().unwrap_or("").trim();
                        if ignored.contains(call) {
                            continue;
                        }
                        let parts = output_parts(&m["content"], ts);
                        if !call.is_empty()
                            && builder.resolve(call, parts.clone(), "completed", None)
                        {
                            continue;
                        }
                        if !parts.is_empty() {
                            builder.append(id, Role::Tool, ts, parts, None, None, None);
                        }
                        continue;
                    }
                    if role != "user" && role != "assistant" {
                        continue;
                    }
                    let mut parts = content_parts(&m["content"], ts);
                    if role == "assistant"
                        && let Some(calls) = m["toolCalls"].as_array()
                    {
                        for call in calls {
                            let f = call
                                .get("function")
                                .filter(|v| v.is_object())
                                .unwrap_or(call);
                            let name = f["name"].as_str().unwrap_or("").trim();
                            let call_id = call["id"].as_str().unwrap_or("").trim();
                            if name.is_empty() || call_id.is_empty() {
                                continue;
                            }
                            if name == "SetTodoList" {
                                ignored.insert(call_id.to_owned());
                                continue;
                            }
                            parts.push(tool(
                                name,
                                call_id,
                                args(
                                    f.get("arguments")
                                        .filter(|v| !v.is_null())
                                        .or_else(|| call.get("arguments")),
                                ),
                                ts,
                                true,
                            ));
                        }
                    }
                    if !parts.is_empty() {
                        let assistant = role == "assistant";
                        builder.append(
                            id,
                            if assistant {
                                Role::Assistant
                            } else {
                                Role::User
                            },
                            ts,
                            parts,
                            assistant.then_some("kimi-code"),
                            if assistant { model.as_deref() } else { None },
                            if assistant { provider.as_deref() } else { None },
                        );
                    }
                }
                "context.append_loop_event" => {
                    let e = &r["event"];
                    match e["type"].as_str().unwrap_or("") {
                        "step.begin" => builder.current = None,
                        "content.part" => {
                            for part in content_parts(&e["part"], ts) {
                                if matches!(part, MessagePart::Image { .. })
                                    && let Some(current) = builder.current
                                {
                                    builder.messages[current].parts.push(part);
                                    continue;
                                }
                                builder.part(
                                    id.clone(),
                                    ts,
                                    part,
                                    "kimi-code",
                                    model.as_deref(),
                                    provider.as_deref(),
                                );
                            }
                        }
                        "tool.call" => {
                            let name = e["name"].as_str().unwrap_or("").trim();
                            let call = e["toolCallId"].as_str().unwrap_or("").trim();
                            if name.is_empty() || call.is_empty() {
                                continue;
                            }
                            if name == "SetTodoList" {
                                ignored.insert(call.to_owned());
                                continue;
                            }
                            builder.part(
                                id,
                                ts,
                                tool(name, call, e.get("args").cloned(), ts, true),
                                "kimi-code",
                                model.as_deref(),
                                provider.as_deref(),
                            );
                        }
                        "tool.result" => {
                            let call = e["toolCallId"].as_str().unwrap_or("").trim();
                            if call.is_empty() || ignored.contains(call) {
                                continue;
                            }
                            let result = &e["result"];
                            let parts = output_parts(&result["output"], ts);
                            if builder.resolve(
                                call,
                                parts.clone(),
                                if result["isError"] == true {
                                    "error"
                                } else {
                                    "completed"
                                },
                                string(&result["note"]).filter(|s| !s.is_empty()),
                            ) {
                                continue;
                            }
                            if !parts.is_empty() {
                                builder.append(id, Role::Tool, ts, parts, None, None, None);
                            }
                        }
                        _ => {}
                    }
                }
                "context.apply_compaction" => {
                    let parts = text(r["summary"].as_str().unwrap_or(""), ts);
                    if !parts.is_empty() {
                        builder.append(id, Role::User, ts, parts, None, None, None);
                    }
                }
                _ => {}
            }
        }
        if builder.messages.is_empty() {
            continue;
        }
        stats.total_tokens = Some(stats.total_input_tokens + stats.total_output_tokens);
        stats.total_cache_read_tokens = (read > 0.).then_some(read);
        stats.total_cache_create_tokens = (create > 0.).then_some(create);
        let title = title(
            &string(&state["title"])
                .or_else(|| string(&state["customTitle"]))
                .unwrap_or_default(),
        )
        .or(first)
        .unwrap_or_else(|| "Untitled Session".into());
        let id = path.file_name().unwrap().to_string_lossy().into_owned();
        let mut detail = finish(
            "kimi-code",
            id,
            directory,
            title,
            created,
            updated,
            stats,
            builder.messages,
            (!model_usage.is_empty()).then_some(model_usage),
        );
        let head = detail.head.clone();
        detail.head.model_usage = None;
        result.push(ParsedSession {
            head,
            source: path,
            detail,
        });
    }
    Ok(result)
}
fn content_parts(content: &Value, ts: f64) -> Vec<MessagePart> {
    let values = content
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(std::slice::from_ref(content));
    let mut parts = vec![];
    for value in values {
        if let Some(s) = value.as_str() {
            parts.extend(text(s, ts));
            continue;
        }
        match value["type"].as_str().unwrap_or("") {
            "text" => parts.extend(text(value["text"].as_str().unwrap_or(""), ts)),
            "think" => {
                let s = clean(value["think"].as_str().unwrap_or(""));
                if !s.is_empty() {
                    parts.push(MessagePart::Reasoning {
                        text: s,
                        time_created: Some(ts),
                    });
                }
            }
            "plan" => {
                let s = clean(value["text"].as_str().unwrap_or(""));
                if !s.is_empty() {
                    parts.push(MessagePart::Plan {
                        text: s,
                        time_created: Some(ts),
                        approval_status: if value["approved"] == false {
                            "fail"
                        } else {
                            "success"
                        }
                        .into(),
                    });
                }
            }
            "image" => {
                let source = &value["source"];
                let url = string(&value["url"])
                    .or_else(|| string(&value["imageUrl"]["url"]))
                    .or_else(|| {
                        (source["kind"] == "url")
                            .then(|| string(&source["url"]))
                            .flatten()
                    });
                let data = string(&value["data"]).or_else(|| {
                    (source["kind"] == "base64")
                        .then(|| string(&source["data"]))
                        .flatten()
                });
                let mime = string(&value["mime_type"])
                    .or_else(|| string(&value["media_type"]))
                    .or_else(|| {
                        (source["kind"] == "base64")
                            .then(|| string(&source["media_type"]))
                            .flatten()
                    })
                    .unwrap_or_else(|| "application/octet-stream".into());
                if url.as_ref().is_some_and(|s| !s.is_empty()) {
                    parts.push(MessagePart::Image {
                        url,
                        data: None,
                        mime_type: Some(mime),
                        time_created: Some(ts),
                    });
                } else if data.as_ref().is_some_and(|s| !s.is_empty()) {
                    parts.push(MessagePart::Image {
                        url: None,
                        data,
                        mime_type: Some(mime),
                        time_created: Some(ts),
                    });
                }
            }
            "image_url" => {
                let url = string(&value["imageUrl"]["url"]).or_else(|| string(&value["url"]));
                if url.as_ref().is_some_and(|s| !s.is_empty()) {
                    parts.push(MessagePart::Image {
                        url,
                        data: None,
                        mime_type: None,
                        time_created: Some(ts),
                    });
                }
            }
            _ => {}
        }
    }
    parts
}
fn output_parts(v: &Value, ts: f64) -> Vec<MessagePart> {
    if v.is_array() || v.is_string() || v["type"] == "text" {
        content_parts(v, ts)
    } else if v.is_null() {
        vec![]
    } else {
        text(&serde_json::to_string_pretty(v).unwrap(), ts)
    }
}

pub fn affected_session_dirs(
    sessions: &Path,
    changed_paths: &[PathBuf],
) -> anyhow::Result<Option<Vec<PathBuf>>> {
    affected_directories(
        sessions,
        changed_paths,
        &[sessions
            .parent()
            .unwrap_or(sessions)
            .join("session_index.jsonl")],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn preserves_fractional_source_timestamps() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions/hash/session");
        std::fs::create_dir_all(path.join("agents/main")).unwrap();
        std::fs::write(path.join("state.json"), r#"{"createdAt":1000.125}"#).unwrap();
        let wire = path.join("agents/main/wire.jsonl");
        std::fs::write(&wire,r#"{"time":1234.567,"type":"context.append_message","message":{"role":"user","content":"hello"}}"#).unwrap();
        let modified = std::time::UNIX_EPOCH + std::time::Duration::new(1000, 123_456_000);
        std::fs::File::options()
            .write(true)
            .open(&wire)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let detail = &sessions[0].detail;
        assert_eq!(detail.head.time_created, 1000.125);
        assert_eq!(detail.head.time_updated, 1_000_123.456);
        assert_eq!(detail.messages[0].time_created, 1234.567);
    }
    #[test]
    fn matches_node_1_0_12_adapter_golden() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions/hash/session");
        std::fs::create_dir_all(path.join("agents/main")).unwrap();
        std::fs::write(
            path.join("state.json"),
            r#"{"createdAt":1000,"workDir":"/tmp/project"}"#,
        )
        .unwrap();
        let records: Vec<Value> =
            serde_json::from_str(include_str!("kimi/fixtures/kimi-code-input.json")).unwrap();
        let wire = path.join("agents/main/wire.jsonl");
        std::fs::write(
            &wire,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1000);
        std::fs::File::options()
            .write(true)
            .open(wire)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
        assert_node_golden(
            &sessions[0],
            include_str!("kimi/fixtures/kimi-code-expected.json"),
        );
    }
    #[test]
    fn incremental_scan_ignores_unrelated_sources_and_detects_deletion() {
        let root = tempfile::tempdir().unwrap();
        for id in ["a", "b"] {
            let path = root.path().join("sessions/hash").join(id);
            std::fs::create_dir_all(path.join("agents/main")).unwrap();
            std::fs::write(path.join("state.json"), "{}").unwrap();
            std::fs::write(
                path.join("agents/main/wire.jsonl"),
                r#"{"type":"context.append_message","message":{"role":"user","content":"hello"}}"#,
            )
            .unwrap();
        }
        let changed = root.path().join("sessions/hash/a/agents/main/wire.jsonl");
        let unrelated = root.path().join("sessions/hash/b/agents/main/wire.jsonl");
        std::fs::remove_file(&unrelated).unwrap();
        std::fs::create_dir(&unrelated).unwrap();
        let sessions = scan_paths(
            root.path(),
            &Pricing::bundled(),
            &[changed.clone(), changed.clone()],
        )
        .unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].head.reference.session_id, "a");
        std::fs::remove_dir_all(root.path().join("sessions/hash/a")).unwrap();
        assert!(
            scan_paths(root.path(), &Pricing::bundled(), &[changed])
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn loop_events_plan_images_tools_usage_and_compaction() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions/hash/session");
        std::fs::create_dir_all(path.join("agents/main")).unwrap();
        std::fs::write(
            path.join("state.json"),
            json!({"createdAt":1000,"custom":{"cwd":"/tmp/project"}}).to_string(),
        )
        .unwrap();
        let records = [
            json!({"type":"llm.request","model":"claude-sonnet-4","provider":"anthropic"}),
            json!({"type":"context.append_message","time":1000,"message":{"role":"user","content":"Implement feature"}}),
            json!({"type":"context.append_loop_event","time":2000,"event":{"type":"content.part","part":{"type":"plan","text":"Plan steps","approved":false}}}),
            json!({"type":"context.append_loop_event","time":2100,"event":{"type":"content.part","part":{"type":"image","source":{"kind":"base64","data":"abc","media_type":"image/png"}}}}),
            json!({"type":"context.append_loop_event","time":2200,"event":{"type":"tool.call","name":"Write","toolCallId":"call","args":{"path":"a.rs"}}}),
            json!({"type":"context.append_loop_event","time":2300,"event":{"type":"tool.result","toolCallId":"call","result":{"output":"failed","isError":true,"note":"try again"}}}),
            json!({"type":"usage.record","usage":{"inputOther":10,"inputCacheRead":2,"inputCacheCreation":3,"output":4}}),
            json!({"type":"context.apply_compaction","summary":"Previous summary"}),
        ];
        std::fs::write(
            path.join("agents/main/wire.jsonl"),
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let detail = &sessions[0].detail;
        assert_eq!(detail.messages.len(), 3);
        assert_eq!(detail.head.stats.total_tokens, Some(19.));
        assert_eq!(detail.messages[1].provider.as_deref(), Some("anthropic"));
        assert_eq!(detail.messages[1].parts.len(), 3);
        let MessagePart::Tool { state, .. } = &detail.messages[1].parts[2] else {
            panic!()
        };
        assert_eq!(state.status, "error");
        assert_eq!(state.metadata.as_ref().unwrap()["note"], "try again");
        assert_eq!(
            sessions[0].head.model_usage.as_ref().unwrap()["claude-sonnet-4"],
            19.
        );
    }
    #[test]
    fn malformed_state_and_empty_sessions_are_skipped() {
        let root = tempfile::tempdir().unwrap();
        for (id, state) in [("invalid", "not json"), ("empty", "{}")] {
            let path = root.path().join("sessions/hash").join(id);
            std::fs::create_dir_all(path.join("agents/main")).unwrap();
            std::fs::write(path.join("state.json"), state).unwrap();
            std::fs::write(
                path.join("agents/main/wire.jsonl"),
                "bad record\n{\"type\":\"llm.request\"}",
            )
            .unwrap();
        }
        assert!(scan(root.path(), &Pricing::bundled()).unwrap().is_empty());
    }
}
