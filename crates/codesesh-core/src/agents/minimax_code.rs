use super::{codex::ParsedSession, deepchat::common::*};
use crate::{contract::*, pricing::Pricing};
use anyhow::{Result, bail};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::Path,
};

type TurnUsage = (
    Option<String>,
    MessageTokens,
    f64,
    Option<CostSource>,
    Vec<crate::pricing::CostInput>,
);

fn convert(row: &Value, agent: &str) -> Result<Message> {
    let data = strict_parse(&row["data_json"])?;
    let id = s(&row["msg_id"])
        .filter(|id| !id.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Invalid MiniMax display message"))?;
    if !data.is_object() || data["msg_id"].as_str() != Some(&id) {
        bail!("Invalid MiniMax display message");
    }
    let role = match row["role"]
        .as_str()
        .or(data["role"].as_str())
        .unwrap_or("assistant")
    {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        other => bail!("Invalid MiniMax role: {other}"),
    };
    let time = row["created_at_ms"]
        .as_f64()
        .or(data["timestamp"].as_f64())
        .unwrap_or(0.0);
    let mut parts = Vec::new();
    let kind = s(&data["kind"]);
    if let Some(kind) = kind.as_ref().filter(|kind| !kind.is_empty()) {
        let label = match kind.as_str() {
            "compaction_start" => "Context compaction started",
            "compaction" => "Context compacted",
            "compaction_failed" => "Context compaction failed",
            "review_start" => "Review started",
            "review_result" => "Review result",
            "review_failed" => "Review failed",
            "review_aborted" => "Review aborted",
            "review_interrupted" => "Review interrupted",
            _ => "",
        };
        parts.push(text(
            if label.is_empty() {
                format!("Event: {kind}")
            } else {
                label.into()
            },
            None,
        ));
    }
    if let Some(value) = s(&data["thinking_content"]).filter(|s| !s.is_empty()) {
        parts.push(MessagePart::Reasoning {
            text: value,
            time_created: None,
        });
    }
    if let Some(value) = s(&data["msg_content"]).filter(|s| !s.is_empty()) {
        parts.push(text(value, None));
    }
    for attachment in data["attachments"].as_array().into_iter().flatten() {
        let name = ["file_path", "desktop_path", "file_name", "asset_id", "url"]
            .into_iter()
            .find_map(|key| s(&attachment[key]));
        if let Some(name) = name.filter(|s| !s.is_empty()) {
            let mime = s(&attachment["mime_type"])
                .filter(|s| !s.is_empty())
                .map(|mime| format!(" ({mime})"))
                .unwrap_or_default();
            parts.push(text(format!("Attachment: {name}{mime}"), None));
        }
    }
    let mut children = BTreeSet::new();
    for call in data["tool_calls"].as_array().into_iter().flatten() {
        let Some(tool) = s(&call["tool_name"]).filter(|s| !s.is_empty()) else {
            continue;
        };
        let output = parse(&call["tool_call_result_data"]);
        let failed = call["tool_call_status"] == 3
            || output["isError"] == true
            || !output["error"].is_null();
        let mut metadata = output["details"].as_object().cloned().unwrap_or_default();
        if let Some(status) = call.get("tool_call_status") {
            metadata.insert("minimax_status".into(), status.clone());
        }
        if (tool == "task" || tool.starts_with("task_"))
            && let Some(child) = metadata
                .get("sub_session_id")
                .and_then(Value::as_str)
                .or_else(|| metadata.get("session_id").and_then(Value::as_str))
        {
            children.insert(child.to_owned());
        }
        parts.push(MessagePart::Tool {
            tool,
            call_id: s(&call["tool_call_id"]),
            title: None,
            time_created: None,
            state: Box::new(ToolState {
                status: if failed {
                    "error"
                } else if call["tool_call_status"] == 2 {
                    "completed"
                } else {
                    "running"
                }
                .into(),
                input: call.get("tool_call_args").map(parse),
                output: call.get("tool_call_result_data").map(parse),
                error: failed.then(|| {
                    output
                        .get("error")
                        .filter(|v| !v.is_null())
                        .or_else(|| output.get("text").filter(|v| !v.is_null()))
                        .unwrap_or(&output)
                        .clone()
                }),
                metadata: Some(Value::Object(metadata)),
            }),
        });
    }
    if let Some(error) = s(&data["error"]).filter(|s| !s.is_empty()) {
        parts.push(text(error, None));
    }
    let automated = role == Role::User
        && (kind.as_ref().is_some_and(|s| !s.is_empty())
            || ["cron", "thread-goal", "team", "background-task", "system"]
                .contains(&row["source"].as_str().unwrap_or("")));
    let mut message = message(id, role, time, parts);
    if message.role == Role::Assistant {
        message.agent = Some(agent.into());
    }
    if data
        .get("finish_reason")
        .is_some_and(|v| !v.is_null() && v != false && v != "" && v != 0)
    {
        message.time_completed = Some(time);
    }
    message.mode = kind;
    message.automated = automated.then_some(true);
    message.subagent_id = (children.len() == 1).then(|| children.into_iter().next().unwrap());
    Ok(message)
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
    let path = root.join("v2/sqlite/runtime-state.sqlite");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    scan_connection(root, &path, &db, pricing, selected)
}
fn scan_connection(
    _root: &Path,
    path: &Path,
    db: &Connection,
    pricing: &Pricing,
    selected: Option<&std::collections::HashSet<String>>,
) -> Result<Vec<ParsedSession>> {
    let read = |sql: &str| rows(db, &selected_query(sql, "s.session_id", selected));
    let filter = "(s.visibility <> 'hidden' OR s.parent_session_id IS NOT NULL) AND s.session_kind NOT IN ('peek', 'cron', 'channel')";
    let headers = rows(
        db,
        &format!("SELECT s.* FROM local_runtime_sessions s WHERE {filter} ORDER BY s.session_id"),
    )?;
    let mut all_messages: HashMap<String, Vec<Value>> = HashMap::new();
    for row in read(&format!(
        "SELECT m.* FROM local_runtime_message_rows m JOIN local_runtime_sessions s ON s.session_id=m.session_id WHERE {filter} ORDER BY m.session_id,m.id"
    ))? {
        all_messages
            .entry(s(&row["session_id"]).unwrap_or_default())
            .or_default()
            .push(row);
    }
    let mut all_usage: HashMap<String, Vec<Value>> = HashMap::new();
    for row in read(&format!(
        "SELECT u.* FROM local_runtime_token_usage u JOIN local_runtime_sessions s ON s.session_id=u.session_id WHERE {filter} ORDER BY u.session_id,u.id"
    ))? {
        all_usage
            .entry(s(&row["session_id"]).unwrap_or_default())
            .or_default()
            .push(row);
    }
    let mut result = Vec::new();
    let reachable = reachable_sessions(headers.iter().map(|h| {
        let id = h["session_id"].as_str().unwrap_or("");
        (
            id,
            h["parent_session_id"]
                .as_str()
                .filter(|p| !p.is_empty() && *p != id),
        )
    }));
    for header in headers {
        if selected.is_some_and(|ids| !ids.contains(header["session_id"].as_str().unwrap_or(""))) {
            continue;
        }
        if header["columnar_version"] != 3 {
            bail!("Unsupported MiniMax session columnar version");
        }
        let id = s(&header["session_id"]).unwrap_or_default();
        let agent = s(&header["agent_name"]).unwrap_or_else(|| "MiniMax Code".into());
        let mut updated = n(&header["updated_at_ms"]);
        let mut messages = Vec::new();
        let mut last_by_turn = HashMap::new();
        let mut first_user = None;
        for row in all_messages.remove(&id).unwrap_or_default() {
            let message = convert(&row, &agent)?;
            updated = updated.max(message.time_created);
            if message.role == Role::User && message.automated != Some(true) && first_user.is_none()
            {
                first_user = message.parts.iter().find_map(|p| {
                    if let MessagePart::Text { text, .. } = p {
                        Some(text.clone())
                    } else {
                        None
                    }
                });
            }
            if message.role == Role::Assistant
                && message.mode.as_ref().is_none_or(|mode| mode.is_empty())
                && let Some(turn) = s(&row["turn_id"])
            {
                last_by_turn.insert(turn, messages.len());
            }
            messages.push(message);
        }
        let mut stats = SessionStats {
            message_count: messages.len(),
            ..Default::default()
        };
        let mut model_usage = BTreeMap::new();
        let mut usage_by_turn: HashMap<String, Vec<TurnUsage>> = HashMap::new();
        for row in all_usage.remove(&id).unwrap_or_default() {
            let model = s(&row["model"]).filter(|s| !s.is_empty());
            let tokens = MessageTokens {
                input: Some(nonnegative(&row["input_tokens"])),
                output: Some(nonnegative(&row["output_tokens"])),
                reasoning: Some(nonnegative(&row["reasoning_tokens"])),
                cache_read: Some(nonnegative(&row["cache_read_tokens"])),
                cache_create: Some(nonnegative(&row["cache_write_tokens"])),
            };
            let total = [
                tokens.input,
                tokens.output,
                tokens.reasoning,
                tokens.cache_read,
                tokens.cache_create,
            ]
            .into_iter()
            .flatten()
            .sum();
            let recorded = row["cost_usd"].as_f64().filter(|n| *n >= 0.0);
            let mut cost_inputs = Vec::new();
            let cost = recorded.or_else(|| {
                pricing.estimate_tracked(model.as_deref(), &tokens, 0.0, &mut cost_inputs)
            });
            stats.cost_inputs.extend(cost_inputs.iter().cloned());
            let source = if recorded.is_some() {
                Some(CostSource::Recorded)
            } else {
                cost.map(|_| CostSource::Estimated)
            };
            add_stats(
                &mut stats,
                &tokens,
                total,
                cost.unwrap_or(0.0),
                source.clone(),
            );
            if let Some(model) = &model {
                *model_usage.entry(model.clone()).or_insert(0.0) += total;
            }
            updated = updated.max(nonnegative(&row["ts"]));
            if let Some(turn) = s(&row["turn_id"]) {
                usage_by_turn.entry(turn).or_default().push((
                    model,
                    tokens,
                    cost.unwrap_or(0.0),
                    source,
                    cost_inputs,
                ));
            }
        }
        for (turn, usages) in usage_by_turn {
            let Some(index) = last_by_turn.get(&turn) else {
                continue;
            };
            let models: BTreeSet<_> = usages.iter().map(|u| u.0.clone()).collect();
            if models.len() != 1 {
                continue;
            }
            let message = &mut messages[*index];
            message.cost = Some(0.0);
            message.model = usages[0].0.clone();
            let mut tokens = empty_tokens();
            for (_, usage, cost, source, cost_inputs) in usages {
                message.cost_inputs.extend(cost_inputs);
                add_tokens(&mut tokens, &usage);
                message.cost = Some(message.cost.unwrap_or(0.0) + cost);
                if source == Some(CostSource::Estimated) || message.cost_source.is_none() {
                    message.cost_source = source;
                }
            }
            message.tokens = Some(tokens);
        }
        if messages.is_empty() || !reachable.contains(&id) {
            continue;
        }
        let parent =
            s(&header["parent_session_id"]).filter(|parent| !parent.is_empty() && parent != &id);
        result.push(finish(
            path,
            "minimax-code",
            id,
            title(&[header["title"].as_str(), first_user.as_deref()]),
            s(&header["workspace_dir"]).unwrap_or_default(),
            header["created_at_ms"]
                .as_f64()
                .unwrap_or(n(&header["updated_at_ms"])),
            updated,
            parent,
            stats,
            (!model_usage.is_empty()).then_some(model_usage),
            messages,
        ));
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
    let path = root.join("v2/sqlite/runtime-state.sqlite");
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
    let filter = "(s.visibility <> 'hidden' OR s.parent_session_id IS NOT NULL) AND s.session_kind NOT IN ('peek', 'cron', 'channel')";
    super::deepchat::common::selected_fingerprints(
        db,
        &[
            (
                &format!(
                    "SELECT s.* FROM local_runtime_sessions s WHERE {filter} ORDER BY s.session_id"
                ),
                "session_id",
            ),
            (
                &format!(
                    "SELECT m.* FROM local_runtime_message_rows m JOIN local_runtime_sessions s ON s.session_id=m.session_id WHERE {filter} ORDER BY m.session_id,m.id"
                ),
                "session_id",
            ),
            (
                &format!(
                    "SELECT u.* FROM local_runtime_token_usage u JOIN local_runtime_sessions s ON s.session_id=u.session_id WHERE {filter} ORDER BY u.session_id,u.id"
                ),
                "session_id",
            ),
        ],
        "s.session_id",
        selected,
    )
}

pub fn scan_page(
    root: &Path,
    pricing: &Pricing,
    selected: &std::collections::HashSet<String>,
) -> Result<(Vec<ParsedSession>, HashMap<String, String>)> {
    let path = root.join("v2/sqlite/runtime-state.sqlite");
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
    let path = root.join("v2/sqlite/runtime-state.sqlite");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let headers = rows(
        &db,
        "SELECT s.session_id,s.parent_session_id,s.columnar_version,COALESCE(m.message_count,0) AS message_count,MAX(COALESCE(s.updated_at_ms,0),COALESCE(m.activity,0),COALESCE(u.activity,0)) AS activity FROM local_runtime_sessions s LEFT JOIN (SELECT session_id,COUNT(*) AS message_count,MAX(created_at_ms) AS activity FROM local_runtime_message_rows GROUP BY session_id) m ON m.session_id=s.session_id LEFT JOIN (SELECT session_id,MAX(ts) AS activity FROM local_runtime_token_usage GROUP BY session_id) u ON u.session_id=s.session_id WHERE (s.visibility <> 'hidden' OR s.parent_session_id IS NOT NULL) AND s.session_kind NOT IN ('peek', 'cron', 'channel')",
    )?;
    if headers.iter().any(|h| h["columnar_version"] != 3) {
        bail!("Unsupported MiniMax session columnar version");
    }
    let selected = reachable_sessions(headers.iter().map(|h| {
        let id = h["session_id"].as_str().unwrap_or("");
        (
            id,
            h["parent_session_id"]
                .as_str()
                .filter(|p| !p.is_empty() && *p != id),
        )
    }));
    let mut keys: Vec<_> = headers
        .into_iter()
        .filter_map(|h| {
            let id = s(&h["session_id"])?;
            (n(&h["message_count"]) > 0.0 && selected.contains(&id))
                .then(|| (id, n(&h["activity"])))
        })
        .collect();
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
    fn display_events_and_tool_metadata() {
        let row = json!({"msg_id":"m","role":"user","source":"cron","created_at_ms":42,"data_json":json!({"msg_id":"m","msg_content":"hello","tool_calls":[{"tool_name":"task","tool_call_status":3,"tool_call_result_data":"{\"error\":\"failed\",\"details\":{\"sub_session_id\":\"child\"}}"}]}).to_string()});
        let m = convert(&row, "MiniMax Code").unwrap();
        assert_eq!(m.automated, Some(true));
        assert_eq!(m.subagent_id.as_deref(), Some("child"));
        assert!(matches!(&m.parts[1],MessagePart::Tool{state,..} if state.status=="error"));
    }
    #[test]
    fn mismatched_message_identity_is_rejected() {
        assert!(
            convert(
                &json!({"msg_id":"a","data_json":"{\"msg_id\":\"b\"}"}),
                "agent"
            )
            .is_err()
        );
    }
}
#[cfg(test)]
#[path = "minimax_code/scan_tests.rs"]
mod scan_tests;
