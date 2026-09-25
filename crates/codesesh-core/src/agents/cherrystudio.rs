use super::{codex::ParsedSession, deepchat::common::*};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

fn live(db: &Connection, table: &str, alias: &str) -> Result<String> {
    Ok(
        if rows(db, &format!("PRAGMA table_info({table})"))?
            .iter()
            .any(|r| r["name"] == "deleted_at")
        {
            format!("{alias}.deleted_at IS NULL")
        } else {
            "1 = 1".into()
        },
    )
}
fn branch(rows: Vec<Value>, active: Option<String>) -> Result<Vec<Value>> {
    let by_id: HashMap<_, _> = rows
        .into_iter()
        .map(|r| (s(&r["id"]).unwrap_or_default(), r))
        .collect();
    let mut selected = Vec::new();
    let mut visited = HashSet::new();
    let mut current = active;
    while let Some(id) = current {
        if !visited.insert(id.clone()) {
            bail!("Cherry Studio message branch contains a cycle");
        }
        let Some(row) = by_id.get(&id) else { break };
        selected.push(row.clone());
        current = s(&row["parent_id"]);
    }
    selected.reverse();
    Ok(selected)
}
fn part(value: &Value) -> Option<MessagePart> {
    let kind = value["type"].as_str()?;
    if matches!(kind, "text" | "reasoning") {
        let content = s(&value["text"]).filter(|s| !s.is_empty())?;
        return Some(if kind == "text" {
            MessagePart::Text {
                text: content,
                time_created: None,
            }
        } else {
            MessagePart::Reasoning {
                text: content,
                time_created: None,
            }
        });
    }
    if kind == "dynamic-tool" || kind.starts_with("tool-") {
        let state = value["state"].as_str().unwrap_or("");
        let failed = matches!(state, "output-error" | "output-denied");
        return Some(MessagePart::Tool {
            tool: s(&value["toolName"]).unwrap_or_else(|| {
                if kind == "dynamic-tool" {
                    "unknown".into()
                } else {
                    kind[5..].into()
                }
            }),
            call_id: s(&value["toolCallId"]),
            title: s(&value["title"]),
            time_created: None,
            state: Box::new(ToolState {
                status: if failed {
                    "error"
                } else if state == "output-available" {
                    "completed"
                } else {
                    "running"
                }
                .into(),
                input: value.get("input").cloned(),
                output: value.get("output").cloned(),
                error: failed.then(|| {
                    value
                        .get("errorText")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or_else(|| Value::String("Tool execution failed".into()))
                }),
                metadata: value.get("providerMetadata").cloned(),
            }),
        });
    }
    if kind == "file" {
        let url = s(&value["url"]);
        let mime = s(&value["mediaType"]);
        if url.as_ref().is_some_and(|s| !s.is_empty())
            && mime.as_ref().is_some_and(|m| m.starts_with("image/"))
        {
            return Some(MessagePart::Image {
                url,
                data: None,
                mime_type: mime,
                time_created: None,
            });
        }
        return s(&value["filename"])
            .or(url)
            .filter(|s| !s.is_empty())
            .map(|label| text(format!("Attachment: {label}"), None));
    }
    let key = match kind {
        "data-error" => "message",
        "data-compact" | "data-code" | "data-translation" => "content",
        _ => return None,
    };
    s(&value["data"][key])
        .filter(|s| !s.is_empty())
        .map(|v| text(v, None))
}
fn transcript(
    rows: Vec<Value>,
    pricing: &Pricing,
) -> Result<(Vec<Message>, SessionStats, BTreeMap<String, f64>)> {
    let mut messages = Vec::new();
    let mut stats = SessionStats::default();
    let mut usage = BTreeMap::new();
    stats.total_tokens = Some(0.0);
    for row in rows {
        let role = match row["role"].as_str() {
            Some("user") => Role::User,
            Some("assistant") => Role::Assistant,
            _ => continue,
        };
        let data = strict_parse(&row["data"])?;
        let snapshot = strict_parse(&row["message_snapshot"])?;
        let unique = row["model_id"].as_str().unwrap_or("");
        let pair = unique.split_once("::");
        let model = s(&snapshot["model"]["id"])
            .or_else(|| pair.map(|p| p.1.to_owned()).or_else(|| s(&row["model_id"])));
        let provider = s(&snapshot["model"]["provider"]).or_else(|| pair.map(|p| p.0.to_owned()));
        let raw_stats = if role == Role::Assistant {
            strict_parse(&row["stats"])?
        } else {
            Value::Null
        };
        let tokens = raw_stats.is_object().then(|| {
            let input = &raw_stats["inputTokenDetails"];
            let output = &raw_stats["outputTokenDetails"];
            MessageTokens {
                input: Some(raw_stats["inputTokens"].as_f64().unwrap_or(
                    nonnegative(&input["noCacheTokens"])
                        + nonnegative(&input["cacheReadTokens"])
                        + nonnegative(&input["cacheWriteTokens"]),
                )),
                output: Some(raw_stats["outputTokens"].as_f64().unwrap_or(
                    nonnegative(&output["textTokens"]) + nonnegative(&output["reasoningTokens"]),
                )),
                cache_read: Some(nonnegative(&input["cacheReadTokens"])),
                cache_create: Some(nonnegative(&input["cacheWriteTokens"])),
                reasoning: Some(nonnegative(&output["reasoningTokens"])),
            }
        });
        let total = raw_stats["totalTokens"]
            .as_f64()
            .unwrap_or_else(|| {
                tokens
                    .as_ref()
                    .map(|t| t.input.unwrap_or(0.0) + t.output.unwrap_or(0.0))
                    .unwrap_or(0.0)
            })
            .max(0.0);
        let costs: Vec<_> = raw_stats["costs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|v| v.is_object())
            .collect();
        let (cost, source) = if !costs.is_empty() && costs.iter().all(|c| c["currency"] == "USD") {
            (
                Some(costs.iter().map(|c| nonnegative(&c["amount"])).sum()),
                Some(
                    if costs
                        .iter()
                        .any(|c| nonnegative(&c["computedRequestCount"]) > 0.0)
                    {
                        CostSource::Estimated
                    } else {
                        CostSource::Recorded
                    },
                ),
            )
        } else {
            let cost = tokens.as_ref().and_then(|t| {
                pricing.estimate(
                    model.as_deref(),
                    &MessageTokens {
                        reasoning: Some(0.0),
                        ..t.clone()
                    },
                    0.0,
                )
            });
            (cost, cost.map(|_| CostSource::Estimated))
        };
        let mut message = message(
            s(&row["id"]).unwrap_or_default(),
            role,
            n(&row["created_at"]),
            data["parts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(part)
                .collect(),
        );
        message.agent = s(&snapshot["name"]);
        message.model = model.clone();
        message.provider = provider;
        message.tokens = tokens.clone();
        message.cost = Some(cost.unwrap_or(0.0));
        message.cost_source = source.clone();
        if row["status"] != "pending" {
            message.time_completed = Some(n(&row["updated_at"]));
        }
        if let Some(model) = model.filter(|_| total > 0.0) {
            *usage.entry(model).or_insert(0.0) += total;
        }
        stats.total_tokens = Some(stats.total_tokens.unwrap_or(0.0) + total);
        message.parts = message.parts.into_iter().filter_map(clean_part).collect();
        if message.parts.is_empty()
            && cost.unwrap_or(0.0) <= 0.0
            && !tokens.as_ref().is_some_and(|t| {
                [t.input, t.output, t.reasoning, t.cache_read, t.cache_create]
                    .into_iter()
                    .flatten()
                    .any(|n| n > 0.0)
            })
        {
            continue;
        }
        stats.message_count += 1;
        stats.total_input_tokens += tokens.as_ref().and_then(|t| t.input).unwrap_or(0.0);
        stats.total_output_tokens += tokens.as_ref().and_then(|t| t.output).unwrap_or(0.0);
        stats.total_cost += cost.unwrap_or(0.0);
        if let Some(tokens) = tokens {
            stats.total_cache_read_tokens = Some(
                stats.total_cache_read_tokens.unwrap_or(0.0) + tokens.cache_read.unwrap_or(0.0),
            );
            stats.total_cache_create_tokens = Some(
                stats.total_cache_create_tokens.unwrap_or(0.0) + tokens.cache_create.unwrap_or(0.0),
            );
        }
        if source == Some(CostSource::Estimated) || stats.cost_source.is_none() {
            stats.cost_source = source;
        }
        messages.push(message);
    }
    if stats.total_cache_read_tokens == Some(0.0) {
        stats.total_cache_read_tokens = None;
    }
    if stats.total_cache_create_tokens == Some(0.0) {
        stats.total_cache_create_tokens = None;
    }
    if stats.total_cost <= 0.0 {
        stats.cost_source = None;
    }
    Ok((messages, stats, usage))
}
pub fn scan(root: &Path, pricing: &Pricing) -> Result<Vec<ParsedSession>> {
    scan_impl(root, pricing, None)
}
pub fn scan_selected(
    root: &Path,
    pricing: &Pricing,
    selected: &std::collections::HashSet<String>,
) -> Result<Vec<ParsedSession>> {
    scan_impl(root, pricing, Some(selected))
}
fn scan_impl(
    root: &Path,
    pricing: &Pricing,
    selected: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<ParsedSession>> {
    let path = root.join("Data/cherrystudio.sqlite");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    scan_connection(root, &path, &db, pricing, selected)
}
fn scan_connection(
    root: &Path,
    path: &Path,
    db: &Connection,
    pricing: &Pricing,
    selected: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<ParsedSession>> {
    let mut result = Vec::new();
    for kind in ["agent", "topic"] {
        let ids: Option<std::collections::HashSet<String>> = selected.map(|ids| {
            ids.iter()
                .filter_map(|id| id.strip_prefix(&format!("{kind}:")))
                .map(str::to_owned)
                .collect()
        });
        let read = |sql: &str| rows(db, &selected_query(sql, "s.id", ids.as_ref()));
        let (table, message_table, key) = if kind == "agent" {
            ("agent_session", "agent_session_message", "session_id")
        } else {
            ("topic", "message", "topic_id")
        };
        let filter = live(db, table, "s")?;
        let extra = if kind == "agent" {
            "w.path AS directory, NULL AS active_node_id"
        } else {
            "NULL AS directory, s.active_node_id"
        };
        let join = if kind == "agent" {
            "LEFT JOIN agent_workspace w ON w.id=s.workspace_id"
        } else {
            ""
        };
        let headers = read(&format!(
            "SELECT s.id,s.name,s.created_at,s.updated_at,s.last_activity_at,{extra} FROM {table} s {join} WHERE {filter}"
        ))?;
        let mut by_conversation: HashMap<String, Vec<Value>> = HashMap::new();
        for row in read(&format!(
            "SELECT m.* FROM {message_table} m JOIN {table} s ON s.id=m.{key} WHERE {filter} AND {} ORDER BY m.{key},m.created_at,m.id",
            live(db, message_table, "m")?
        ))? {
            by_conversation
                .entry(s(&row[key]).unwrap_or_default())
                .or_default()
                .push(row);
        }
        for header in headers {
            let id = s(&header["id"]).unwrap_or_default();
            let rows = by_conversation.remove(&id).unwrap_or_default();
            let selected = if kind == "topic" {
                branch(rows, s(&header["active_node_id"]))?
            } else {
                rows
            };
            let (messages, stats, usage) = transcript(selected, pricing)?;
            if stats.message_count == 0 {
                continue;
            }
            let first_user = messages
                .iter()
                .filter(|m| m.role == Role::User)
                .flat_map(|m| &m.parts)
                .find_map(|p| {
                    if let MessagePart::Text { text, .. } = p {
                        Some(text.as_str())
                    } else {
                        None
                    }
                });
            result.push(finish(
                path,
                "cherrystudio",
                format!("{kind}:{id}"),
                title(&[header["name"].as_str(), first_user, Some("Cherry Studio")]),
                s(&header["directory"])
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| root.to_string_lossy().into()),
                n(&header["created_at"]),
                n(&header["last_activity_at"]),
                None,
                stats,
                Some(usage),
                messages,
            ));
        }
    }
    result.sort_by(|a, b| {
        b.detail
            .head
            .time_updated
            .total_cmp(&a.detail.head.time_updated)
            .then(crate::locale::compare(
                &a.detail.head.reference.session_id,
                &b.detail.head.reference.session_id,
            ))
    });
    Ok(result)
}
pub fn fingerprints(root: &Path) -> Result<HashMap<String, String>> {
    let path = root.join("Data/cherrystudio.sqlite");
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    fingerprint_connection(&db, None)
}
fn fingerprint_connection(
    db: &Connection,
    selected: Option<&std::collections::HashSet<String>>,
) -> Result<HashMap<String, String>> {
    let mut result = HashMap::new();
    for kind in ["agent", "topic"] {
        let (table, message_table, key) = if kind == "agent" {
            ("agent_session", "agent_session_message", "session_id")
        } else {
            ("topic", "message", "topic_id")
        };
        let filter = live(db, table, "s")?;
        let ids: Option<std::collections::HashSet<String>> = selected.map(|ids| {
            ids.iter()
                .filter_map(|id| id.strip_prefix(&format!("{kind}:")))
                .map(str::to_owned)
                .collect()
        });
        let header = if kind == "agent" {
            format!(
                "SELECT s.*,w.path AS directory FROM {table} s LEFT JOIN agent_workspace w ON w.id=s.workspace_id WHERE {filter} ORDER BY s.id"
            )
        } else {
            format!("SELECT s.* FROM {table} s WHERE {filter} ORDER BY s.id")
        };
        let messages = format!(
            "SELECT m.* FROM {message_table} m JOIN {table} s ON s.id=m.{key} WHERE {filter} AND {} ORDER BY m.{key},m.created_at,m.id",
            live(db, message_table, "m")?
        );
        for (id, fingerprint) in super::deepchat::common::selected_fingerprints(
            db,
            &[(&header, "id"), (&messages, key)],
            "s.id",
            ids.as_ref(),
        )? {
            result.insert(format!("{kind}:{id}"), fingerprint);
        }
    }
    Ok(result)
}

pub fn scan_page(
    root: &Path,
    pricing: &Pricing,
    selected: &std::collections::HashSet<String>,
) -> Result<(Vec<ParsedSession>, HashMap<String, String>)> {
    let path = root.join("Data/cherrystudio.sqlite");
    if !path.exists() {
        return Ok((Vec::new(), HashMap::new()));
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let fingerprints = fingerprint_connection(&db, Some(selected))?;
    let sessions = scan_connection(root, &path, &db, pricing, Some(selected))?;
    Ok((sessions, fingerprints))
}

pub fn enumerate_session_keys(root: &Path) -> Result<Vec<(String, f64)>> {
    let path = root.join("Data/cherrystudio.sqlite");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let mut keys = Vec::new();
    for (kind, table, message_table, key) in [
        (
            "agent",
            "agent_session",
            "agent_session_message",
            "session_id",
        ),
        ("topic", "topic", "message", "topic_id"),
    ] {
        let query = format!(
            "SELECT s.id,s.last_activity_at FROM {table} s WHERE {} AND EXISTS (SELECT 1 FROM {message_table} m WHERE m.{key}=s.id AND {})",
            live(&db, table, "s")?,
            live(&db, message_table, "m")?
        );
        for row in rows(&db, &query)? {
            if let Some(id) = s(&row["id"]) {
                keys.push((format!("{kind}:{id}"), n(&row["last_activity_at"])));
            }
        }
    }
    keys.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| crate::locale::compare(&a.0, &b.0))
    });
    Ok(keys)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selects_active_branch_and_rejects_cycle() {
        let rows = vec![
            json!({"id":"a","parent_id":null}),
            json!({"id":"b","parent_id":"a"}),
            json!({"id":"c","parent_id":"a"}),
        ];
        assert_eq!(
            branch(rows, Some("b".into()))
                .unwrap()
                .iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(branch(vec![json!({"id":"a","parent_id":"a"})], Some("a".into())).is_err());
    }
    #[test]
    fn does_not_double_price_reasoning() {
        let rows = vec![
            json!({"id":"m","role":"assistant","created_at":1,"updated_at":2,"data":"{\"parts\":[{\"type\":\"text\",\"text\":\"done\"}]}","model_id":"openai::gpt-4o","stats":json!({"inputTokens":100,"outputTokens":20,"outputTokenDetails":{"reasoningTokens":10}}).to_string()}),
        ];
        let (messages, stats, _) = transcript(rows, &Pricing::bundled()).unwrap();
        assert_eq!(stats.total_tokens, Some(120.0));
        assert_eq!(messages[0].tokens.as_ref().unwrap().reasoning, Some(10.0));
    }
}
#[cfg(test)]
#[path = "cherrystudio/scan_tests.rs"]
mod scan_tests;
