use crate::contract::*;
use anyhow::Result;
use rusqlite::{Connection, Row};

fn optional_json<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    column: &str,
) -> rusqlite::Result<Option<T>> {
    let text: Option<String> = row.get(column)?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                row.as_ref().column_index(column).unwrap_or_default(),
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}

pub fn load(connection: &Connection) -> Result<Vec<SessionHead>> {
    let mut query=connection.prepare("SELECT * FROM sessions WHERE publication_id IS NULL ORDER BY activity_time DESC,agent_name,session_id")?;
    Ok(query
        .query_map([], head)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn head(row: &Row<'_>) -> rusqlite::Result<SessionHead> {
    let metadata: Option<serde_json::Value> = optional_json(row, "meta_json")?;
    let parent_agent: Option<String> = row.get("parent_agent_name")?;
    let parent_id: Option<String> = row.get("parent_session_id")?;
    let cost_source: Option<String> = row.get("cost_source")?;
    Ok(SessionHead {
        version: metadata
            .as_ref()
            .and_then(|meta| meta["rustHeadVersion"].as_str())
            .map(str::to_owned),
        summary_files: metadata
            .as_ref()
            .and_then(|meta| meta.get("rustHeadSummaryFiles"))
            .cloned(),
        reference: SessionReference {
            agent_name: row.get("agent_name")?,
            session_id: row.get("session_id")?,
        },
        title: row.get("title")?,
        directory: row.get("directory")?,
        display_title: None,
        parent_reference: parent_agent.zip(parent_id).map(|(agent_name, session_id)| {
            SessionReference {
                agent_name,
                session_id,
            }
        }),
        project_identity: ProjectIdentity {
            kind: row.get("project_identity_kind")?,
            key: row.get("project_identity_key")?,
            display_name: row.get("project_display_name")?,
        },
        project_identity_resolver_revision: row.get("project_identity_resolver_revision")?,
        project_identity_input_signature: row.get("project_identity_input_signature")?,
        time_created: row.get("time_created")?,
        time_updated: row
            .get::<_, Option<f64>>("time_updated")?
            .unwrap_or(row.get("time_created")?),
        stats: SessionStats {
            cost_inputs: Vec::new(),
            message_count: row.get::<_, i64>("message_count")? as usize,
            total_input_tokens: row.get("total_input_tokens")?,
            total_output_tokens: row.get("total_output_tokens")?,
            total_cost: row.get("total_cost")?,
            total_cache_read_tokens: row.get("total_cache_read_tokens")?,
            total_cache_create_tokens: row.get("total_cache_create_tokens")?,
            total_tokens: row.get("total_tokens")?,
            cost_source: match cost_source.as_deref() {
                Some("recorded") => Some(CostSource::Recorded),
                Some("estimated") => Some(CostSource::Estimated),
                _ => None,
            },
        },
        model_usage: optional_json(row, "model_usage_json")?,
        smart_tags: optional_json(row, "smart_tags_json")?.unwrap_or_default(),
        smart_tags_source_updated_at: row.get("smart_tags_source_updated_at")?,
        smart_tags_classifier_revision: row.get("smart_tags_classifier_revision")?,
    })
}
