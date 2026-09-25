pub(super) mod common;
use super::codex::ParsedSession;
use crate::{contract::*, pricing::Pricing};
use anyhow::Result;
use common::*;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::Path,
};

fn tokens(row: &Value) -> Option<MessageTokens> {
    if !row["inputTokens"].is_number() && !row["outputTokens"].is_number() {
        return None;
    }
    let input = nonnegative(&row["inputTokens"]);
    let read = nonnegative(&row["cachedInputTokens"]);
    let create = nonnegative(&row["cacheWriteInputTokens"]);
    Some(MessageTokens {
        input: Some(input),
        output: Some(nonnegative(&row["outputTokens"])),
        cache_read: Some(read.min(input)),
        cache_create: Some(create.min((n(&row["inputTokens"]) - read).max(0.0))),
        reasoning: None,
    })
}
fn assistant_part(block: &Value) -> Option<MessagePart> {
    let time = block["timestamp"].as_f64();
    let content = s(&block["content"]);
    let kind = block["type"].as_str().unwrap_or("");
    if kind == "tool_call" {
        let tool = &block["tool_call"];
        if !tool.is_object() {
            return None;
        }
        let status = match block["status"].as_str() {
            Some("pending" | "loading") => "running",
            Some("error" | "denied") => "error",
            _ => "completed",
        };
        let output = tool.get("response").map(parse);
        return Some(MessagePart::Tool {
            tool: s(&tool["name"]).unwrap_or_else(|| "unknown".into()),
            call_id: s(&tool["id"]),
            title: None,
            time_created: time,
            state: Box::new(ToolState {
                status: status.into(),
                input: tool.get("params").map(parse),
                output: output.clone(),
                error: if status == "error" {
                    output
                        .filter(|v| !v.is_null())
                        .or_else(|| content.clone().map(Value::String))
                } else {
                    None
                },
                metadata: block.get("extra").filter(|v| v.is_object()).cloned(),
            }),
        });
    }
    if kind == "image" {
        let data = s(&block["image_data"]["data"]).filter(|s| !s.is_empty());
        let mime = s(&block["image_data"]["mimeType"]).filter(|s| !s.is_empty());
        if data.is_some() && mime.is_some() {
            return Some(MessagePart::Image {
                url: None,
                data,
                mime_type: mime,
                time_created: time,
            });
        }
    }
    let content = content.filter(|s| !s.is_empty())?;
    Some(if kind == "reasoning_content" {
        MessagePart::Reasoning {
            text: content,
            time_created: time,
        }
    } else {
        text(content, time)
    })
}
fn user_parts(value: &Value) -> Vec<MessagePart> {
    let mut parts = Vec::new();
    if let Some(value) = s(&value["text"]).filter(|s| !s.is_empty()) {
        parts.push(text(value, None));
    }
    for file in value["files"].as_array().into_iter().flatten() {
        let path = s(&file["path"]);
        let name = s(&file["name"]);
        if path.as_ref().is_some_and(|s| !s.is_empty())
            || name.as_ref().is_some_and(|s| !s.is_empty())
        {
            let label = path.or(name).unwrap_or_default();
            parts.push(text(format!("Attachment: {label}"), None));
        }
    }
    for link in value["links"].as_array().into_iter().flatten() {
        if let Some(link) = link.as_str() {
            parts.push(text(link, None));
        }
    }
    parts
}
fn raw_parts(role: &str, value: &Value) -> Vec<MessagePart> {
    let value = parse(value);
    if role == "user" && value.is_object() {
        return user_parts(&value);
    }
    if let Some(values) = value.as_array() {
        return values.iter().filter_map(assistant_part).collect();
    }
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| vec![text(s, None)])
        .unwrap_or_default()
}
struct Usage {
    model: Option<String>,
    provider: Option<String>,
    tokens: MessageTokens,
    cost: f64,
}
struct Projection {
    header: Value,
    stats: SessionStats,
    models: BTreeMap<String, f64>,
    usage: HashMap<String, Usage>,
    updated: f64,
}
fn accumulate(projection: &mut Projection, row: &Value, pricing: &Pricing) {
    let tokens = tokens(row);
    if tokens.is_none() && !row["totalTokens"].is_number() {
        return;
    }
    let model = s(&row["model"]).or_else(|| s(&projection.header["model_id"]));
    let provider = s(&row["provider"]).or_else(|| s(&projection.header["provider_id"]));
    let input = tokens.as_ref().and_then(|t| t.input).unwrap_or(0.0);
    let output = tokens.as_ref().and_then(|t| t.output).unwrap_or(0.0);
    let total = row["totalTokens"]
        .as_f64()
        .unwrap_or(input + output)
        .max(0.0);
    let cost = tokens
        .as_ref()
        .and_then(|t| pricing.estimate(model.as_deref(), t, 0.0))
        .unwrap_or(0.0);
    let tokens = tokens.unwrap_or(MessageTokens {
        input: Some(0.0),
        output: Some(0.0),
        reasoning: None,
        cache_read: Some(0.0),
        cache_create: Some(0.0),
    });
    add_stats(
        &mut projection.stats,
        &tokens,
        total,
        cost,
        (cost > 0.0).then_some(CostSource::Estimated),
    );
    if let Some(model) = model.as_ref().filter(|_| total > 0.0) {
        *projection.models.entry(model.clone()).or_insert(0.0) += total;
    }
    if let Some(id) = s(&row["message_id"]).filter(|s| !s.is_empty()) {
        let entry = projection.usage.entry(id).or_insert(Usage {
            model: None,
            provider: None,
            tokens: empty_tokens(),
            cost: 0.0,
        });
        entry.model = model;
        entry.provider = provider;
        entry.cost += cost;
        add_tokens(&mut entry.tokens, &tokens);
    }
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
    let path = root.join("app_db/agent.db");
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
    let read = |sql: &str| {
        rows(
            db,
            &selected_query(
                sql,
                if sql.contains("new_sessions") {
                    "s.id"
                } else {
                    "m.session_id"
                },
                selected,
            ),
        )
    };
    let mut projections: BTreeMap<String, Projection> = BTreeMap::new();
    for header in rows(
        db,
        "SELECT s.*,d.model_id,d.provider_id FROM new_sessions s LEFT JOIN deepchat_sessions d ON d.id=s.id WHERE s.is_draft=0 ORDER BY s.id",
    )? {
        let updated = n(&header["updated_at"]);
        projections.insert(
            s(&header["id"]).unwrap_or_default(),
            Projection {
                header,
                updated,
                stats: SessionStats::default(),
                models: BTreeMap::new(),
                usage: HashMap::new(),
            },
        );
    }
    for row in read(
        "SELECT u.session_id,u.message_id,u.model_id AS model,u.provider_id AS provider,u.input_tokens AS inputTokens,u.output_tokens AS outputTokens,u.total_tokens AS totalTokens,u.cached_input_tokens AS cachedInputTokens,u.cache_write_input_tokens AS cacheWriteInputTokens,u.created_at FROM deepchat_usage_stats u JOIN new_sessions s ON s.id=u.session_id WHERE s.is_draft=0 ORDER BY u.session_id,u.usage_id",
    )? {
        if let Some(p) = projections.get_mut(row["session_id"].as_str().unwrap_or("")) {
            accumulate(p, &row, pricing);
            p.updated = p.updated.max(n(&row["created_at"]));
        }
    }
    let mut message_rows: HashMap<String, Vec<Value>> = HashMap::new();
    for row in read(
        "SELECT m.* FROM deepchat_messages m JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,m.order_seq,m.id",
    )? {
        let session = s(&row["session_id"]).unwrap_or_default();
        if let Some(p) = projections.get_mut(&session) {
            p.stats.message_count += 1;
            p.updated = p.updated.max(n(&row["updated_at"]));
            if row["role"] == "assistant" && !p.usage.contains_key(row["id"].as_str().unwrap_or(""))
            {
                let mut metadata = parse(&row["metadata"]);
                if let Some(obj) = metadata.as_object_mut() {
                    obj.insert("message_id".into(), row["id"].clone());
                    accumulate(p, &metadata, pricing);
                }
            }
            message_rows.entry(session).or_default().push(row);
        }
    }
    let mut parts: HashMap<String, Vec<MessagePart>> = HashMap::new();
    for row in read(
        "SELECT b.*,m.session_id FROM deepchat_assistant_blocks b JOIN deepchat_messages m ON m.id=b.message_id JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY b.message_id,b.block_index",
    )? {
        if let Some(p) = projections.get_mut(row["session_id"].as_str().unwrap_or("")) {
            p.updated = p.updated.max(n(&row["updated_at"]));
        }
        let extra = parse(&row["extra_json"]);
        let block = json!({"type":row["block_type"],"content":row["text_content"],"status":row["status"],"timestamp":extra.get("timestamp").filter(|v|!v.is_null()).unwrap_or(&row["updated_at"]),"extra":extra["extra"],"tool_call":{"id":row["tool_call_id"],"name":row["tool_name"],"params":row["tool_params"],"response":row["tool_response"]},"image_data":{"data":extra["imageData"],"mimeType":row["image_mime_type"]}});
        let entry = parts
            .entry(s(&row["message_id"]).unwrap_or_default())
            .or_default();
        if let Some(part) = assistant_part(&block) {
            entry.push(part);
        }
    }
    for row in read(
        "SELECT u.message_id,u.text FROM deepchat_user_messages u JOIN deepchat_messages m ON m.id=u.message_id",
    )? {
        parts.insert(s(&row["message_id"]).unwrap_or_default(), user_parts(&row));
    }
    for row in read(
        "SELECT f.message_id,f.path,f.name FROM deepchat_user_message_files f JOIN deepchat_messages m ON m.id=f.message_id ORDER BY f.message_id,f.ordinal",
    )? {
        if let Some(parts) = parts.get_mut(row["message_id"].as_str().unwrap_or("")) {
            parts.extend(user_parts(&json!({"files":[row]})));
        }
    }
    for row in read(
        "SELECT l.message_id,l.url FROM deepchat_user_message_links l JOIN deepchat_messages m ON m.id=l.message_id ORDER BY l.message_id,l.ordinal",
    )? {
        if let Some(parts) = parts.get_mut(row["message_id"].as_str().unwrap_or("")) {
            parts.extend(user_parts(&json!({"links":[row["url"]]})));
        }
    }
    let mut result = Vec::new();
    let selected = reachable_sessions(projections.iter().map(|(id, p)| {
        (
            id.as_str(),
            p.header["parent_session_id"]
                .as_str()
                .filter(|p| !p.is_empty()),
        )
    }));
    for (id, projection) in projections {
        if projection.stats.message_count == 0 || !selected.contains(&id) {
            continue;
        }
        let mut messages = Vec::new();
        for row in message_rows.remove(&id).unwrap_or_default() {
            let role = match row["role"].as_str() {
                Some("user") => Role::User,
                Some("assistant") => Role::Assistant,
                _ => continue,
            };
            let mid = s(&row["id"]).unwrap_or_default();
            let usage = projection.usage.get(&mid);
            let metadata = parse(&row["metadata"]);
            let mut m = message(
                mid.clone(),
                role,
                n(&row["created_at"]),
                parts.remove(&mid).unwrap_or_else(|| {
                    raw_parts(row["role"].as_str().unwrap_or(""), &row["content"])
                }),
            );
            if m.role == Role::Assistant {
                m.agent = s(&projection.header["agent_id"]);
            }
            if row["status"] != "pending" {
                m.time_completed = Some(n(&row["updated_at"]));
            }
            m.model = usage
                .and_then(|u| u.model.clone())
                .or_else(|| s(&metadata["model"]))
                .or_else(|| s(&projection.header["model_id"]));
            m.provider = usage
                .and_then(|u| u.provider.clone())
                .or_else(|| s(&metadata["provider"]))
                .or_else(|| s(&projection.header["provider_id"]));
            m.tokens = usage.map(|u| u.tokens.clone());
            m.cost = usage.map(|u| u.cost);
            m.cost_source = usage
                .filter(|u| u.cost > 0.0)
                .map(|_| CostSource::Estimated);
            messages.push(m);
        }
        result.push(finish(
            path,
            "deepchat",
            id,
            title(&[projection.header["title"].as_str()]),
            s(&projection.header["project_dir"]).unwrap_or_default(),
            n(&projection.header["created_at"]),
            projection.updated,
            s(&projection.header["parent_session_id"]).filter(|s| !s.is_empty()),
            projection.stats,
            (!projection.models.is_empty()).then_some(projection.models),
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
    let path = root.join("app_db/agent.db");
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
    common::selected_fingerprints(
        db,
        &[
            (
                "SELECT s.*,d.model_id,d.provider_id FROM new_sessions s LEFT JOIN deepchat_sessions d ON d.id=s.id WHERE s.is_draft=0 ORDER BY s.id",
                "id",
            ),
            (
                "SELECT u.* FROM deepchat_usage_stats u JOIN new_sessions s ON s.id=u.session_id WHERE s.is_draft=0 ORDER BY u.session_id,u.usage_id",
                "session_id",
            ),
            (
                "SELECT m.* FROM deepchat_messages m JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,m.order_seq,m.id",
                "session_id",
            ),
            (
                "SELECT b.*,m.session_id FROM deepchat_assistant_blocks b JOIN deepchat_messages m ON m.id=b.message_id JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,b.message_id,b.block_index",
                "session_id",
            ),
            (
                "SELECT u.*,m.session_id FROM deepchat_user_messages u JOIN deepchat_messages m ON m.id=u.message_id JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,u.message_id",
                "session_id",
            ),
            (
                "SELECT f.*,m.session_id FROM deepchat_user_message_files f JOIN deepchat_messages m ON m.id=f.message_id JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,f.message_id,f.ordinal",
                "session_id",
            ),
            (
                "SELECT l.*,m.session_id FROM deepchat_user_message_links l JOIN deepchat_messages m ON m.id=l.message_id JOIN new_sessions s ON s.id=m.session_id WHERE s.is_draft=0 ORDER BY m.session_id,l.message_id,l.ordinal",
                "session_id",
            ),
        ],
        "s.id",
        selected,
    )
}

pub fn scan_page(
    root: &Path,
    pricing: &Pricing,
    selected: &std::collections::HashSet<String>,
) -> Result<(Vec<ParsedSession>, HashMap<String, String>)> {
    let path = root.join("app_db/agent.db");
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
    let path = root.join("app_db/agent.db");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.execute_batch("BEGIN")?;
    let headers = rows(
        &db,
        "SELECT s.id,s.parent_session_id,COALESCE(m.message_count,0) AS message_count,MAX(COALESCE(s.updated_at,0),COALESCE(m.activity,0),COALESCE(u.activity,0),COALESCE(b.activity,0)) AS activity FROM new_sessions s LEFT JOIN (SELECT session_id,COUNT(*) AS message_count,MAX(updated_at) AS activity FROM deepchat_messages GROUP BY session_id) m ON m.session_id=s.id LEFT JOIN (SELECT session_id,MAX(created_at) AS activity FROM deepchat_usage_stats GROUP BY session_id) u ON u.session_id=s.id LEFT JOIN (SELECT m.session_id,MAX(b.updated_at) AS activity FROM deepchat_assistant_blocks b JOIN deepchat_messages m ON m.id=b.message_id GROUP BY m.session_id) b ON b.session_id=s.id WHERE s.is_draft=0",
    )?;
    let selected = reachable_sessions(headers.iter().map(|h| {
        (
            h["id"].as_str().unwrap_or(""),
            h["parent_session_id"].as_str().filter(|id| !id.is_empty()),
        )
    }));
    let mut keys: Vec<_> = headers
        .into_iter()
        .filter_map(|h| {
            let id = s(&h["id"])?;
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
    #[test]
    fn clamps_cache_tokens_to_available_input() {
        let t=tokens(&json!({"inputTokens":10,"outputTokens":-2,"cachedInputTokens":20,"cacheWriteInputTokens":4})).unwrap();
        assert_eq!(t.input, Some(10.0));
        assert_eq!(t.output, Some(0.0));
        assert_eq!(t.cache_read, Some(10.0));
        assert_eq!(t.cache_create, Some(0.0));
    }
    #[test]
    fn malformed_tool_json_retains_raw_payload() {
        let p=assistant_part(&json!({"type":"tool_call","status":"error","tool_call":{"name":"shell","params":"invalid","response":"failure"}})).unwrap();
        assert!(
            matches!(p,MessagePart::Tool{state,..}if state.input==Some(json!("invalid"))&&state.error==Some(json!("failure")))
        );
    }
}
#[cfg(test)]
#[path = "deepchat/scan_tests.rs"]
mod scan_tests;
