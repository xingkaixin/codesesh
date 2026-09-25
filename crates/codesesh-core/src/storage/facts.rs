use crate::contract::{Message, MessagePart, SessionHead, SessionReference};
use anyhow::Result;
use rusqlite::{Connection, params};
use serde_json::{Map, Value, json};

pub fn content_hash(head: &SessionHead) -> Result<String> {
    let mut facts = Map::new();
    for (key, value) in [
        ("title", json!(head.title)),
        ("directory", json!(head.directory)),
        ("timeCreated", json!(head.time_created)),
        ("timeUpdated", json!(head.time_updated)),
        ("messageCount", json!(head.stats.message_count)),
        ("totalInputTokens", json!(head.stats.total_input_tokens)),
        ("totalOutputTokens", json!(head.stats.total_output_tokens)),
        (
            "totalCacheReadTokens",
            json!(head.stats.total_cache_read_tokens.unwrap_or_default()),
        ),
        (
            "totalCacheCreateTokens",
            json!(head.stats.total_cache_create_tokens.unwrap_or_default()),
        ),
        ("totalCost", json!(head.stats.total_cost)),
        (
            "costSource",
            json!(
                head.stats
                    .cost_source
                    .as_ref()
                    .map(|s| s.as_str())
                    .unwrap_or("")
            ),
        ),
        (
            "totalTokens",
            json!(head.stats.total_tokens.unwrap_or_default()),
        ),
        ("projectIdentityKind", json!(head.project_identity.kind)),
        ("projectIdentityKey", json!(head.project_identity.key)),
        (
            "projectDisplayName",
            json!(head.project_identity.display_name),
        ),
        (
            "projectIdentityResolverRevision",
            json!(
                head.project_identity_resolver_revision
                    .as_deref()
                    .unwrap_or("")
            ),
        ),
        (
            "projectIdentityInputSignature",
            json!(
                head.project_identity_input_signature
                    .as_deref()
                    .unwrap_or("")
            ),
        ),
    ] {
        facts.insert(key.into(), value);
    }
    Ok(super::json::stringify(&Value::Object(facts))?)
}

pub fn write(
    connection: &Connection,
    reference: &SessionReference,
    messages: &[Message],
) -> Result<()> {
    connection.execute("INSERT INTO session_model_cost(agent_name,session_id,model,cost,cost_recorded) SELECT agent_name,session_id,model,SUM(COALESCE(cost,0)),SUM(CASE WHEN cost_source='recorded' THEN COALESCE(cost,0) ELSE 0 END) FROM messages WHERE agent_name=? AND session_id=? AND model IS NOT NULL AND model<>'' GROUP BY agent_name,session_id,model",params![reference.agent_name,reference.session_id])?;
    connection.execute(
        include_str!("cost-summary.sql"),
        params![reference.agent_name, reference.session_id],
    )?;
    for (index, message) in messages.iter().enumerate() {
        let mut metadata = Vec::new();
        for part in &message.parts {
            if let MessagePart::Tool { tool, .. } = part {
                let name = tool.trim().to_lowercase();
                if !name.is_empty() {
                    connection.execute(
                        "INSERT OR IGNORE INTO message_tools VALUES(?,?,?,?)",
                        params![
                            reference.agent_name,
                            reference.session_id,
                            index as i64,
                            name
                        ],
                    )?;
                }
                let mut value = serde_json::to_value(part)?;
                let object = value.as_object_mut().expect("tool is an object");
                object.remove("time_created");
                if let Some(state) = object.get_mut("state").and_then(Value::as_object_mut) {
                    state.remove("input");
                    state.remove("output");
                }
                metadata.push(value);
            }
        }
        if !metadata.is_empty() {
            connection.execute("UPDATE messages SET tool_metadata_json=? WHERE agent_name=? AND session_id=? AND message_index=?",params![super::json::stringify(&metadata)?,reference.agent_name,reference.session_id,index as i64])?;
        }
    }
    Ok(())
}
