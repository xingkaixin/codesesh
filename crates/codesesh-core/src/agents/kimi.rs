pub(crate) mod helpers;
use super::codex::ParsedSession;
use crate::{contract::*, pricing::Pricing};
use helpers::*;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

pub fn scan(root: &Path, pricing: &Pricing) -> anyhow::Result<Vec<ParsedSession>> {
    let sessions = if root.join("sessions").is_dir() {
        root.join("sessions")
    } else {
        root.to_owned()
    };
    let data = sessions.parent().unwrap_or(root);
    scan_with_data_root(&sessions, data, pricing)
}

pub fn scan_with_data_root(
    sessions: &Path,
    data: &Path,
    pricing: &Pricing,
) -> anyhow::Result<Vec<ParsedSession>> {
    scan_directories(directories(sessions)?, data, pricing)
}

pub fn scan_paths_with_data_root(
    sessions: &Path,
    data: &Path,
    pricing: &Pricing,
    changed_paths: &[PathBuf],
) -> anyhow::Result<Vec<ParsedSession>> {
    match affected_session_dirs(sessions, data, changed_paths)? {
        Some(paths) => scan_directories(paths, data, pricing),
        None => scan_with_data_root(sessions, data, pricing),
    }
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
    scan_paths_with_data_root(
        &sessions,
        sessions.parent().unwrap_or(root),
        pricing,
        changed_paths,
    )
}

fn scan_directories(
    paths: Vec<PathBuf>,
    data: &Path,
    pricing: &Pricing,
) -> anyhow::Result<Vec<ParsedSession>> {
    let config_path = data.join("config.toml");
    let config = if config_path.exists() {
        Some(std::fs::read_to_string(config_path)?)
    } else {
        None
    };
    let model = config.and_then(|s| {
        regex::Regex::new(r#"(?m)^default_model\s*=\s*"([^"]+)""#)
            .unwrap()
            .captures(&s)
            .map(|c| c[1].to_owned())
    });
    let mut projects = HashMap::new();
    if let Ok(content) = std::fs::read(data.join("kimi.json"))
        && let Ok(config) = serde_json::from_slice::<Value>(&content)
        && let Some(work_dirs) = config["work_dirs"].as_array()
    {
        for wd in work_dirs {
            if let Some(path) = wd["path"].as_str() {
                projects.insert(format!("{:x}", md5::compute(path)), path.to_owned());
            }
        }
    }
    let mut result = vec![];
    for path in paths {
        let state = path.join("state.json");
        let meta = if state.exists() {
            state.clone()
        } else {
            path.join("metadata.json")
        };
        if !meta.exists()
            || (!path.join("context.jsonl").exists() && !path.join("wire.jsonl").exists())
        {
            continue;
        }
        let content = std::fs::read(&meta)?;
        let Ok(meta_value) = serde_json::from_slice::<Value>(&content) else {
            continue;
        };
        let metadata = std::fs::metadata(&path)?;
        let fallback = source_created_ms(&metadata)?;
        let created = timestamp(&meta_value["createdAt"])
            .or_else(|| timestamp(&meta_value["created_at"]))
            .unwrap_or(fallback);
        let context_path = path.join("context.jsonl");
        let wire_path = path.join("wire.jsonl");
        let updated = [
            created,
            number(&meta_value["wire_mtime"]) * 1000.,
            if context_path.exists() {
                mtime(&context_path)?
            } else {
                0.
            },
            if wire_path.exists() {
                mtime(&wire_path)?
            } else {
                0.
            },
        ]
        .into_iter()
        .max_by(f64::total_cmp)
        .unwrap();
        let explicit = str_value(
            &meta_value[if meta == state {
                "custom_title"
            } else {
                "title"
            }],
        );
        let title = match title(&explicit) {
            Some(title) => title,
            None => first_user_title(&context_path, &wire_path)?
                .unwrap_or_else(|| "Untitled Session".into()),
        };
        let mut stats = SessionStats {
            total_tokens: Some(0.),
            ..SessionStats::default()
        };
        let mut builder = Builder::default();
        let mut ignored = HashSet::new();
        if context_path.exists() {
            for (seq, r) in records(&context_path)?.enumerate() {
                let r = r?;
                if r["role"] == "_usage" {
                    if let Some(n) = r["token_count"].as_f64() {
                        stats.total_tokens = Some(n);
                    }
                    continue;
                }
                let role = r["role"].as_str().unwrap_or("");
                let id = format!("context-{}", seq + 1);
                match role {
                    "user" => {
                        let parts = text(&content_text(&r["content"], true), created);
                        if !parts.is_empty() {
                            builder.append(id, Role::User, created, parts, None, None, None);
                        }
                    }
                    "assistant" => {
                        let mut parts = vec![];
                        if let Some(content) = r["content"].as_array() {
                            for p in content {
                                let s = clean(&str_value(
                                    &p[if p["type"] == "think" {
                                        "think"
                                    } else {
                                        "text"
                                    }],
                                ));
                                if s.is_empty() {
                                    continue;
                                }
                                match p["type"].as_str() {
                                    Some("think") => parts.push(MessagePart::Reasoning {
                                        text: s,
                                        time_created: Some(created),
                                    }),
                                    Some("text") => parts.push(MessagePart::Text {
                                        text: s,
                                        time_created: Some(created),
                                    }),
                                    _ => {}
                                }
                            }
                        }
                        if let Some(calls) = r["tool_calls"].as_array() {
                            for call in calls {
                                let f = &call["function"];
                                let name = str_value(&f["name"]);
                                let call_id = str_value(&call["id"]);
                                let (name, call_id) = (name.trim(), call_id.trim());
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
                                    args(f.get("arguments")),
                                    created,
                                    false,
                                ));
                            }
                        }
                        if !parts.is_empty() {
                            builder.append(
                                id,
                                Role::Assistant,
                                created,
                                parts,
                                Some("kimi"),
                                None,
                                None,
                            );
                        }
                    }
                    "tool" => {
                        let call = str_value(&r["tool_call_id"]);
                        if ignored.contains(call.trim()) {
                            continue;
                        }
                        let parts = context_output(&r["content"], created);
                        if !parts.is_empty()
                            && !builder.resolve(call.trim(), parts.clone(), "completed", None)
                        {
                            builder.append(id, Role::Tool, created, parts, None, None, None);
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut open = None::<String>;
        let mut buffers: HashMap<String, String> = HashMap::new();
        for (seq, r) in records(&wire_path)?.enumerate() {
            let r = r?;
            if !context_path.exists() && r["role"] == "_usage" && r["token_count"].is_number() {
                stats.total_tokens = r["token_count"].as_f64();
            }
            let msg = &r["message"];
            let p = &msg["payload"];
            let ts = (number(&r["timestamp"]) * 1000.).floor();
            if let Some(usage) = msg.get("usage").filter(|v| v.is_object()) {
                let input = number(&usage["input_tokens"]);
                let output = number(&usage["output_tokens"]);
                let tokens = MessageTokens {
                    input: Some(input),
                    output: Some(output),
                    reasoning: None,
                    cache_read: None,
                    cache_create: None,
                };
                let cost =
                    pricing.estimate_tracked(model.as_deref(), &tokens, 0., &mut stats.cost_inputs);
                stats.total_input_tokens += input;
                stats.total_output_tokens += output;
                stats.total_cost += cost.unwrap_or(0.);
                if !context_path.exists() && (input != 0. || output != 0.) {
                    builder.usage(
                        tokens,
                        model.as_deref(),
                        cost,
                        stats.cost_inputs.last().unwrap().clone(),
                    );
                }
            }
            if context_path.exists() {
                continue;
            }
            let id = format!("wire-{}", seq + 1);
            match msg["type"].as_str().unwrap_or("") {
                "TurnBegin" => {
                    if p["user_input"].as_array().is_some_and(|a| !a.is_empty()) {
                        let parts = text(&content_text(&p["user_input"], true), ts);
                        if !parts.is_empty() {
                            builder.append(id, Role::User, ts, parts, None, None, None);
                        }
                    }
                    builder.current = None;
                    open = None;
                }
                "ContentPart" => {
                    let s = clean(&str_value(
                        &p[if p["type"] == "think" {
                            "think"
                        } else {
                            "text"
                        }],
                    ));
                    if !s.is_empty() {
                        let part = match p["type"].as_str() {
                            Some("think") => Some(MessagePart::Reasoning {
                                text: s,
                                time_created: Some(ts),
                            }),
                            Some("text") => Some(MessagePart::Text {
                                text: s,
                                time_created: Some(ts),
                            }),
                            _ => None,
                        };
                        if let Some(part) = part {
                            builder.part(id, ts, part, "kimi", None, None);
                        }
                    }
                }
                "ToolCall" => {
                    let name = str_value(&p["function"]["name"]);
                    let call = str_value(&p["id"]);
                    let (name, call) = (name.trim(), call.trim());
                    if name.is_empty() || call.is_empty() {
                        continue;
                    }
                    open = Some(call.into());
                    if name == "SetTodoList" {
                        ignored.insert(call.into());
                        continue;
                    }
                    let raw = p["function"].get("arguments");
                    let normalized = args(raw);
                    if let Some(raw) = raw.and_then(Value::as_str)
                        && normalized.as_ref().is_some_and(|v| !v.is_string())
                    {
                        buffers.insert(call.into(), raw.into());
                    }
                    builder.part(
                        id,
                        ts,
                        tool(name, call, normalized, ts, false),
                        "kimi",
                        None,
                        None,
                    );
                }
                "ToolCallPart" => {
                    if let Some(call) = &open {
                        if ignored.contains(call) {
                            continue;
                        }
                        let combined = format!(
                            "{}{}",
                            buffers.get(call).map(String::as_str).unwrap_or(""),
                            str_value(&p["arguments_part"])
                        );
                        if let Ok(parsed) = serde_json::from_str(&combined) {
                            if let Some(state) = builder.state(call) {
                                state.input = Some(parsed);
                                buffers.remove(call);
                            }
                        } else {
                            buffers.insert(call.clone(), combined);
                        }
                    }
                }
                "ToolResult" => {
                    let call = str_value(&p["tool_call_id"]);
                    if ignored.contains(call.trim()) {
                        continue;
                    }
                    let parts = wire_output(&p["return_value"], ts);
                    if !parts.is_empty()
                        && !builder.resolve(call.trim(), parts.clone(), "completed", None)
                    {
                        builder.append(id, Role::Tool, ts, parts, None, None, None);
                    }
                }
                _ => {}
            }
        }
        let hash = path
            .parent()
            .and_then(Path::file_name)
            .unwrap_or_default()
            .to_string_lossy();
        let directory = projects.get(hash.as_ref()).cloned().unwrap_or_default();
        let id = path.file_name().unwrap().to_string_lossy().into_owned();
        let detail = finish(
            "kimi",
            id,
            directory,
            title,
            created,
            updated,
            stats,
            builder.messages,
            None,
        );
        let mut head = detail.head.clone();
        head.stats.message_count = 0;
        result.push(ParsedSession {
            head,
            source: path,
            detail,
        });
    }
    Ok(result)
}
fn source_created_ms(metadata: &std::fs::Metadata) -> anyhow::Result<f64> {
    if let Ok(created) = metadata.created() {
        let created = crate::time::system_time_ms(created);
        if created > 0. {
            return Ok(created);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(metadata.ctime() as f64 * 1000. + metadata.ctime_nsec() as f64 / 1_000_000.)
    }
    #[cfg(not(unix))]
    {
        Ok(crate::time::system_time_ms(metadata.modified()?))
    }
}

fn first_user_title(context: &Path, wire: &Path) -> anyhow::Result<Option<String>> {
    for r in records(context)? {
        let r = r?;
        if r["role"] == "user"
            && let Some(title) = title(&content_text(&r["content"], true))
        {
            return Ok(Some(title));
        }
    }
    for r in records(wire)? {
        let r = r?;
        if r["message"]["type"] == "TurnBegin"
            && r["message"]["payload"]["user_input"].is_array()
            && let Some(title) = title(&content_text(&r["message"]["payload"]["user_input"], true))
        {
            return Ok(Some(title));
        }
    }
    Ok(None)
}
fn context_output(v: &Value, ts: f64) -> Vec<MessagePart> {
    if let Some(a) = v.as_array() {
        a.iter()
            .flat_map(|v| {
                if v.is_string() {
                    text(&str_value(v), ts)
                } else if v.get("text").is_some() {
                    text(&str_value(&v["text"]), ts)
                } else {
                    vec![]
                }
            })
            .collect()
    } else {
        text(&str_value(v), ts)
    }
}
fn wire_output(v: &Value, ts: f64) -> Vec<MessagePart> {
    if v.is_object() || v.is_array() {
        text(&serde_json::to_string_pretty(v).unwrap(), ts)
    } else {
        text(&str_value(v), ts)
    }
}

pub fn affected_session_dirs(
    sessions: &Path,
    data: &Path,
    changed_paths: &[PathBuf],
) -> anyhow::Result<Option<Vec<PathBuf>>> {
    affected_directories(
        sessions,
        changed_paths,
        &[data.join("kimi.json"), data.join("config.toml")],
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
        let wire = path.join("wire.jsonl");
        std::fs::write(&wire,r#"{"timestamp":1.234567,"message":{"type":"TurnBegin","payload":{"user_input":[{"text":"hello"}]}}}"#).unwrap();
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
        assert_eq!(detail.messages[0].time_created, 1234.);
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
            serde_json::from_str(include_str!("kimi/fixtures/kimi-input.json")).unwrap();
        let wire = path.join("wire.jsonl");
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
            include_str!("kimi/fixtures/kimi-expected.json"),
        );
    }
    #[test]
    fn incremental_scan_ignores_unrelated_sources_and_detects_deletion() {
        let root = tempfile::tempdir().unwrap();
        for id in ["a", "b"] {
            let path = root.path().join("sessions/hash").join(id);
            std::fs::create_dir_all(path.join("agents/main")).unwrap();
            std::fs::write(path.join("state.json"), "{}").unwrap();
            std::fs::write(path.join("wire.jsonl"),r#"{"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":[{"text":"hello"}]}}}"#).unwrap();
        }
        let changed = root.path().join("sessions/hash/a/wire.jsonl");
        let unrelated = root.path().join("sessions/hash/b/wire.jsonl");
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
    fn context_precedence_tool_resolution_and_wire_usage() {
        let root = tempfile::tempdir().unwrap();
        let cwd = "/tmp/kimi-project";
        let hash = format!("{:x}", md5::compute(cwd));
        let path = root.path().join("sessions").join(hash).join("session");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(
            root.path().join("kimi.json"),
            json!({"work_dirs":[{"path":cwd}]}).to_string(),
        )
        .unwrap();
        std::fs::write(
            root.path().join("config.toml"),
            "default_model = \"claude-sonnet-4\"\n",
        )
        .unwrap();
        std::fs::write(
            path.join("state.json"),
            json!({"createdAt":"2026-01-01T00:00:00Z","custom_title":""}).to_string(),
        )
        .unwrap();
        let context = [
            json!({"role":"user","content":"Fix a bug"}),
            json!({"role":"assistant","content":[{"type":"think","think":"Inspect it"}],"tool_calls":[{"id":"c1","function":{"name":"ReadFile","arguments":"{\"path\":\"src/main.rs\"}"}}]}),
            json!({"role":"tool","tool_call_id":"c1","content":"source code"}),
            json!({"role":"_usage","token_count":99}),
        ];
        std::fs::write(
            path.join("context.jsonl"),
            context
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        std::fs::write(path.join("wire.jsonl"),json!({"message":{"type":"ContentPart","payload":{"type":"text","text":"Do not duplicate this"},"usage":{"input_tokens":20,"output_tokens":8}}}).to_string()).unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let detail = &sessions[0].detail;
        assert_eq!(detail.head.directory, cwd);
        assert_eq!(detail.head.title, "Fix a bug");
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.head.stats.total_tokens, Some(99.));
        assert_eq!(detail.head.stats.total_input_tokens, 20.);
        assert!(detail.messages[1].tokens.is_none());
        let MessagePart::Tool { state, .. } = &detail.messages[1].parts[1] else {
            panic!()
        };
        assert_eq!(state.status, "completed");
        assert_eq!(state.input.as_ref().unwrap()["path"], "src/main.rs");
        assert_eq!(detail.file_activity.len(), 1);
    }
    #[test]
    fn wire_streaming_arguments_ignored_tools_and_usage_merge() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("sessions/hash/id");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("metadata.json"), "{}").unwrap();
        let records = [
            json!({"timestamp":1,"message":{"type":"TurnBegin","payload":{"user_input":[{"text":"Hello"}]}}}),
            json!({"timestamp":2,"message":{"type":"ToolCall","payload":{"id":"read","function":{"name":"ReadFile","arguments":""}}}}),
            json!({"timestamp":3,"message":{"type":"ToolCallPart","payload":{"arguments_part":"{\"path\":\"a.rs\"}"}}}),
            json!({"timestamp":4,"message":{"type":"ToolResult","payload":{"tool_call_id":"read","return_value":{"ok":true}}}}),
            json!({"timestamp":5,"message":{"type":"StatusUpdate","usage":{"input_tokens":4,"output_tokens":2}}}),
            json!({"timestamp":6,"message":{"type":"StatusUpdate","usage":{"input_tokens":3,"output_tokens":1}}}),
        ];
        std::fs::write(
            path.join("wire.jsonl"),
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let detail = &sessions[0].detail;
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].tokens.as_ref().unwrap().input, Some(7.));
        let MessagePart::Tool { state, .. } = &detail.messages[1].parts[0] else {
            panic!()
        };
        assert_eq!(state.input.as_ref().unwrap()["path"], "a.rs");
        assert_eq!(state.status, "completed");
    }
}
