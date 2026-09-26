pub(super) mod common;
mod incremental;
mod transcript;
use super::codex::{ParsedSession, timestamp};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Context, Result};
use common::*;
pub use incremental::scan_changed;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    path::{Path, PathBuf},
};
use transcript::Transcript;
use walkdir::WalkDir;

struct Child {
    id: String,
    parent: Option<String>,
    title: Option<String>,
    tool_id: Option<String>,
    project: PathBuf,
}

fn child(path: &Path) -> Option<Child> {
    let subagents = path.parent()?;
    if subagents.file_name()? != "subagents" {
        return None;
    }
    let parent = subagents.parent()?;
    let project = parent.parent()?.to_owned();
    let stem = path.file_stem()?.to_string_lossy();
    let metadata: Value = fs::read(subagents.join(format!("{stem}.meta.json")))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let field = |key: &str| {
        metadata[key]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let id =
        field("agentId").unwrap_or_else(|| stem.strip_prefix("agent-").unwrap_or(&stem).into());
    if id.is_empty() {
        return None;
    }
    Some(Child {
        id,
        parent: field("parentAgentId")
            .or_else(|| parent.file_name().map(|s| s.to_string_lossy().into_owned())),
        title: field("name").or_else(|| field("description")),
        tool_id: field("toolUseId"),
        project,
    })
}

pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    let nested = root.join("projects");
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
    let mut paths = Vec::new();
    let mut children = HashMap::new();
    let mut tool_children = HashMap::new();
    for entry in WalkDir::new(root).follow_links(false) {
        let entry = entry.context("enumerating Claude sources")?;
        if !entry.file_type().is_file() || entry.path().extension().is_none_or(|e| e != "jsonl") {
            continue;
        }
        let child = child(entry.path());
        if child.is_none() && entry.depth() != 2 {
            continue;
        }
        if let Some(child) = child {
            if let Some(tool) = &child.tool_id {
                tool_children.insert(tool.clone(), child.id.clone());
            }
            children.insert(entry.path().to_owned(), child);
        }
        paths.push(entry.into_path());
    }
    paths.sort();
    let mut indexes = HashMap::<PathBuf, Value>::new();
    let mut sessions = Vec::new();
    for path in paths {
        let context = children.get(&path);
        let project = context
            .map(|c| c.project.as_path())
            .unwrap_or_else(|| path.parent().unwrap());
        let index = indexes.entry(project.to_owned()).or_insert_with(|| {
            fs::read(project.join("sessions-index.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(Value::Null)
        });
        let result = match parse(&path, context, project, index, &tool_children, pricing) {
            Err(error) if error.is::<InvalidSession>() => continue,
            result => result?,
        };
        if let Some((head, detail)) = result {
            sessions.push(ParsedSession {
                source: path,
                head,
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

fn internal(record: &Value) -> bool {
    record["isMeta"] == true
        || matches!(
            record["type"]
                .as_str()
                .unwrap_or("")
                .trim()
                .to_lowercase()
                .replace(['_', '-'], " ")
                .as_str(),
            "progress" | "file history snapshot" | "queue operation" | "last prompt"
        )
}

fn user_parts(value: &Value, ts: f64) -> Vec<MessagePart> {
    match value {
        Value::String(s) => text_part(s, ts).into_iter().collect(),
        Value::Array(a) => a
            .iter()
            .filter(|v| v["type"] != "tool_result")
            .filter_map(|v| {
                if v.is_string() {
                    text_part(&text(v), ts)
                } else {
                    text_part(&text(&v["text"]), ts)
                }
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn output_parts(value: &Value, ts: f64) -> Vec<MessagePart> {
    match value {
        Value::Null => Vec::new(),
        Value::Array(a) => a
            .iter()
            .filter_map(|v| {
                if v["type"] == "image" && !v["source"].is_null() {
                    let data = v["source"]["data"].as_str().unwrap_or("");
                    let mime = v["source"]["media_type"].as_str().unwrap_or("");
                    return (!data.is_empty() && mime.starts_with("image/")).then_some(
                        MessagePart::Image {
                            url: None,
                            data: Some(data.into()),
                            mime_type: Some(mime.into()),
                            time_created: Some(ts),
                        },
                    );
                }
                if v.is_object() {
                    text_part(
                        &text(
                            v.get("text")
                                .filter(|v| !v.is_null())
                                .unwrap_or(&v["content"]),
                        ),
                        ts,
                    )
                } else if v.is_string() {
                    text_part(&text(v), ts)
                } else {
                    None
                }
            })
            .collect(),
        _ => text_part(&text(value), ts).into_iter().collect(),
    }
}

fn parse(
    path: &Path,
    child: Option<&Child>,
    project: &Path,
    index: &Value,
    children: &HashMap<String, String>,
    pricing: &Pricing,
) -> Result<Option<(SessionHead, SessionDetail)>> {
    let id = child.map(|c| c.id.clone()).unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let explicit = child
        .and_then(|c| c.title.as_deref())
        .map(str::to_owned)
        .or_else(|| {
            index["entries"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|e| e["sessionId"] == id)
                .and_then(|e| e.get("summary"))
                .filter(|v| !v.is_null() && **v != false && **v != "")
                .map(text)
        });
    let file = File::open(path).with_context(|| format!("reading {}", path.display()))?;
    let mut transcript = Transcript::new();
    let mut created = 0.0_f64;
    let mut updated = 0.0_f64;
    let mut cwd = None;
    let mut prompt_title = None;
    let mut visible_count = 0;
    let mut models = BTreeMap::<String, f64>::new();
    let mut usage_by_request = HashMap::<String, (Option<String>, MessageTokens)>::new();
    let mut usage_order = Vec::<String>::new();
    let mut line_index = 0;
    let mut lines = super::jsonl::JsonLines::new(file);
    while let Some(line) = lines.next_line()? {
        if line.trim().is_empty() {
            continue;
        }
        let record_index = line_index;
        line_index += 1;
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            if record_index == 0 {
                return Err(InvalidSession("malformed first Claude record").into());
            }
            continue;
        };
        if record_index == 0 {
            created = match timestamp(&record) {
                0.0 => mtime(path)?,
                t => t,
            };
            updated = created;
        }
        if internal(&record) {
            continue;
        }
        updated = updated.max(timestamp(&record));
        if cwd.is_none() {
            cwd = record["cwd"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);
        }
        let raw = &record["message"];
        let user_title = if raw["role"] == "user" {
            let value = &raw["content"];
            if let Some(items) = value.as_array() {
                title(
                    &items
                        .iter()
                        .filter(|v| v.is_object() && v.get("text").is_some())
                        .map(|v| text(&v["text"]))
                        .collect::<Vec<_>>()
                        .join(" "),
                )
            } else if value.is_string() {
                title(&text(value))
            } else {
                None
            }
        } else {
            None
        };
        if raw["role"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && (s != "user" || user_title.is_some()))
        {
            visible_count += 1;
        }
        if prompt_title.is_none() && record_index < 20 {
            prompt_title = user_title;
        }
        if raw["role"] == "assistant" && raw["usage"].is_object() {
            let key = record["requestId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    record["uuid"]
                        .as_str()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                });
            if let Some(key) = key {
                let u = &raw["usage"];
                let n = |k: &str| u[k].as_f64().unwrap_or(0.0);
                let read = n("cache_read_input_tokens");
                let create = n("cache_creation_input_tokens");
                if !usage_by_request.contains_key(key) {
                    usage_order.push(key.into());
                }
                usage_by_request.insert(
                    key.into(),
                    (
                        raw["model"]
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned),
                        MessageTokens {
                            input: Some(n("input_tokens") + read + create),
                            output: Some(n("output_tokens")),
                            cache_read: Some(read),
                            cache_create: Some(create),
                            reasoning: None,
                        },
                    ),
                );
            }
        }
        transcript.convert(&record, children, pricing);
    }
    if line_index == 0 {
        return Err(InvalidSession("empty Claude session").into());
    }
    if visible_count == 0 {
        return Ok(None);
    }
    let directory = cwd.unwrap_or_else(|| project.to_string_lossy().into_owned());
    let title = explicit
        .as_deref()
        .and_then(title)
        .or(prompt_title)
        .or_else(|| {
            title(
                &Path::new(&directory)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy(),
            )
        })
        .or_else(|| title(&project.file_name().unwrap_or_default().to_string_lossy()))
        .unwrap_or_else(|| "Untitled Session".into());
    let mut head_stats = SessionStats {
        message_count: visible_count,
        total_cache_read_tokens: Some(0.0),
        total_cache_create_tokens: Some(0.0),
        ..Default::default()
    };
    for key in usage_order {
        let (model, tokens) = &usage_by_request[&key];
        head_stats.total_input_tokens += tokens.input.unwrap_or(0.0);
        head_stats.total_output_tokens += tokens.output.unwrap_or(0.0);
        *head_stats.total_cache_read_tokens.as_mut().unwrap() += tokens.cache_read.unwrap_or(0.0);
        *head_stats.total_cache_create_tokens.as_mut().unwrap() +=
            tokens.cache_create.unwrap_or(0.0);
        head_stats.total_cost += pricing
            .estimate_tracked(model.as_deref(), tokens, 0.0, &mut head_stats.cost_inputs)
            .unwrap_or(0.0);
        if let Some(model) = model {
            *models.entry(model.clone()).or_default() +=
                tokens.input.unwrap_or(0.0) + tokens.output.unwrap_or(0.0);
        }
    }
    finish_messages(&mut transcript.messages);
    let mut detail = detail(
        SessionReference {
            agent_name: "claudecode".into(),
            session_id: id,
        },
        directory,
        title,
        created,
        updated,
        transcript.messages,
        models,
    );
    detail.head.parent_reference =
        child
            .and_then(|c| c.parent.as_ref())
            .map(|id| SessionReference {
                agent_name: "claudecode".into(),
                session_id: id.clone(),
            });
    head_stats.cost_source = (head_stats.total_cost > 0.0).then_some(CostSource::Estimated);
    let mut head = detail.head.clone();
    head.stats = head_stats;
    Ok(Some((head, detail)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn write(path: &Path, records: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            path,
            records
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .unwrap();
    }
    #[test]
    fn incremental_metadata_rename_relinks_parent_and_removes_previous_identity() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("project/parent.jsonl");
        let child = root
            .path()
            .join("project/parent/subagents/agent-worker.jsonl");
        let meta = child.with_extension("meta.json");
        write(
            &parent,
            &[
                json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"Agent","input":{}}]}}),
            ],
        );
        write(
            &child,
            &[json!({"type":"user","message":{"role":"user","content":"Work"}})],
        );
        fs::write(
            &meta,
            json!({"agentId":"old-worker","toolUseId":"call"}).to_string(),
        )
        .unwrap();
        let pricing = Pricing::bundled();
        let previous = scan(root.path(), &pricing).unwrap();
        fs::write(
            &meta,
            json!({"agentId":"new-worker","toolUseId":"call","name":"Renamed"}).to_string(),
        )
        .unwrap();
        fs::create_dir_all(root.path().join("unrelated/session.jsonl")).unwrap();
        let delta = scan_changed(
            root.path(),
            &pricing,
            &[meta],
            &previous
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert!(!delta.complete);
        assert_eq!(delta.upserts.len(), 2);
        assert_eq!(delta.removed.len(), 1);
        assert_eq!(delta.removed[0].session_id, "old-worker");
        let parent = delta
            .upserts
            .iter()
            .find(|s| s.head.reference.session_id == "parent")
            .unwrap();
        assert_eq!(
            parent.detail.messages[0].subagent_id.as_deref(),
            Some("new-worker")
        );
        fs::remove_file(&child).unwrap();
        let delta = scan_changed(
            root.path(),
            &pricing,
            &[child],
            &delta
                .upserts
                .iter()
                .map(crate::agents::SessionRecord::from)
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(delta.removed[0].session_id, "new-worker");
        assert_eq!(delta.upserts[0].detail.messages[0].subagent_id, None);
    }
    #[test]
    fn rejects_malformed_opening_record_but_skips_later_corruption() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("project/session.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let user = json!({"type":"user","timestamp":"2026-04-20T10:00:00+08:00","message":{"role":"user","content":"Visible"}}).to_string();
        fs::write(&path, format!("invalid\n{user}")).unwrap();
        assert!(scan(root.path(), &Pricing::bundled()).unwrap().is_empty());
        fs::write(&path, format!("{user}\ninvalid")).unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].head.time_created, 1776650400000.0);
        assert_eq!(sessions[0].detail.messages.len(), 1);
    }
    #[test]
    fn filters_internal_only_records_and_limits_fallback_title_to_first_twenty() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("project/session.jsonl");
        write(
            &path,
            &[
                json!({"type":"user","message":{"role":"user","content":"<local-command-stdout>hidden</local-command-stdout>"}}),
            ],
        );
        assert!(scan(root.path(), &Pricing::bundled()).unwrap().is_empty());
        let mut records = vec![json!({"type":"progress","timestamp":"2026-04-20T10:00:00Z"}); 20];
        records.push(json!({"type":"user","cwd":"/tmp/fallback","message":{"role":"user","content":"Too late for title"}}));
        write(&path, &records);
        assert_eq!(
            scan(root.path(), &Pricing::bundled()).unwrap()[0]
                .head
                .title,
            "fallback"
        );
    }
    #[test]
    fn missing_source_timestamp_preserves_fractional_file_mtime() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("project/mtime.jsonl");
        write(
            &path,
            &[json!({"type":"user","message":{"role":"user","content":"Fallback timestamp"}})],
        );
        let modified = std::time::UNIX_EPOCH + std::time::Duration::new(1776679200, 125_000);
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        assert_eq!(sessions[0].head.time_created, 1776679200000.125);
        assert_eq!(sessions[0].head.time_updated, 1776679200000.125);
    }
    #[test]
    fn fractional_timestamps_and_cached_cursor_match_node() {
        let root = tempfile::tempdir().unwrap();
        let records: Vec<Value> =
            serde_json::from_str(include_str!("claudecode/fixtures/fractional-records.json"))
                .unwrap();
        let path = root.path().join("project/fractional.jsonl");
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
        let expected = include_str!("claudecode/fixtures/fractional-expected.json");
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
            serde_json::from_str(include_str!("claudecode/fixtures/records.json")).unwrap();
        write(&root.path().join("project/session.jsonl"), &records);
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        crate::pricing::assert_cached_repricing(|pricing| scan(root.path(), pricing).unwrap());
        assert_reference(
            &sessions[0].head,
            &sessions[0].detail,
            include_str!("claudecode/fixtures/expected.json"),
        );
    }
    #[test]
    fn deduplicates_request_usage_and_backfills_tool_results() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("project/session.jsonl");
        write(
            &path,
            &[
                json!({"type":"user","uuid":"u","cwd":"/tmp/project","timestamp":"2026-04-20T10:00:00Z","message":{"role":"user","content":"Inspect files"}}),
                json!({"type":"assistant","uuid":"a","requestId":"r","message":{"role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":2},"content":[{"type":"text","text":"Checking"},{"type":"tool_use","id":"call","name":"Read","input":{"file_path":"a.rs"}}]}}),
                json!({"type":"assistant","uuid":"b","requestId":"r","message":{"role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":100,"output_tokens":10},"content":[]}}),
                json!({"type":"user","uuid":"c","sourceToolAssistantUUID":"a","toolUseResult":{"success":false,"commandName":"read"},"message":{"role":"user","content":[{"type":"tool_result","content":"Failed"}]}}),
            ],
        );
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let d = &sessions[0].detail;
        assert_eq!(d.messages.len(), 2);
        assert_eq!(d.head.stats.total_input_tokens, 100.0);
        assert_eq!(d.head.stats.total_output_tokens, 10.0);
        let MessagePart::Tool { state, .. } = &d.messages[1].parts[1] else {
            panic!()
        };
        assert_eq!(state.status, "error");
        assert_eq!(state.output.as_ref().unwrap()[0]["text"], "Failed");
    }
    #[test]
    fn child_metadata_links_parent_call_and_nested_session() {
        let root = tempfile::tempdir().unwrap();
        write(
            &root.path().join("project/parent.jsonl"),
            &[
                json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"Agent","input":{}}]}}),
            ],
        );
        let child = root
            .path()
            .join("project/parent/subagents/agent-worker.jsonl");
        write(
            &child,
            &[json!({"type":"user","message":{"role":"user","content":"Work"}})],
        );
        fs::write(child.with_extension("meta.json"), json!({"agentId":"worker","parentAgentId":"nested","name":"Worker title","toolUseId":"call"}).to_string()).unwrap();
        let sessions = scan(root.path(), &Pricing::bundled()).unwrap();
        let parent = sessions
            .iter()
            .find(|s| s.detail.head.reference.session_id == "parent")
            .unwrap();
        let child = sessions
            .iter()
            .find(|s| s.detail.head.reference.session_id == "worker")
            .unwrap();
        assert_eq!(
            parent.detail.messages[0].subagent_id.as_deref(),
            Some("worker")
        );
        assert_eq!(
            child
                .detail
                .head
                .parent_reference
                .as_ref()
                .unwrap()
                .session_id,
            "nested"
        );
        assert_eq!(child.detail.head.title, "Worker title");
    }
}
