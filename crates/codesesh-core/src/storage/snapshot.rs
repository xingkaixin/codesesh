use crate::model::*;
use anyhow::Result;
use rusqlite::{Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const HEAD_COLUMNS: &str = "source_node_id,agent_name,session_id,title,directory,parent_agent_name,parent_session_id,project_identity_kind,project_identity_key,project_display_name,project_identity_resolver_revision,project_identity_input_signature,time_created,time_updated,message_count,total_input_tokens,total_output_tokens,total_cost,total_cache_read_tokens,total_cache_create_tokens,total_tokens,cost_source,model_usage_json,smart_tags_json,smart_tags_source_updated_at,smart_tags_classifier_revision,head_meta_json";
pub(super) const HEAD_COLUMN_COUNT: usize = 27;

#[derive(Default, Deserialize, Serialize)]
pub(crate) struct HeadMetadata {
    #[serde(rename = "rustHeadVersion", skip_serializing_if = "Option::is_none")]
    version: Option<Value>,
    #[serde(
        rename = "rustHeadSummaryFiles",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_summary"
    )]
    summary_files: Option<Value>,
    #[serde(
        rename = "recordedGitRemotes",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    recorded_git_remotes: Vec<String>,
}

impl HeadMetadata {
    pub(crate) fn encode(head: &SessionHead) -> Result<String> {
        let value = Self {
            version: head.version.clone().map(Value::String),
            summary_files: head.summary_files.clone(),
            recorded_git_remotes: head.recorded_git_remotes.clone(),
        };
        Ok(super::json::stringify(&value)?)
    }
}

fn present_summary<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Value>, D::Error> {
    // An explicit JSON null is distinct from an absent summary.
    Value::deserialize(deserializer).map(Some)
}

fn optional_json<T: serde::de::DeserializeOwned>(
    row: &Row<'_>,
    column: usize,
) -> rusqlite::Result<Option<T>> {
    let text: Option<String> = row.get(column)?;
    text.map(|text| {
        serde_json::from_str(&text).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}

pub fn load(connection: &Connection) -> Result<Vec<SessionHead>> {
    let mut query=connection.prepare(&format!("SELECT {HEAD_COLUMNS} FROM sessions WHERE publication_id IS NULL ORDER BY activity_time DESC,agent_name,session_id"))?;
    Ok(query
        .query_map([], head)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub fn head(row: &Row<'_>) -> rusqlite::Result<SessionHead> {
    // All callers select HEAD_COLUMNS; positions avoid a name scan for every field.
    let source_node_id: String = row.get(0)?;
    let metadata = optional_json::<Option<HeadMetadata>>(row, 26)?.flatten();
    let parent_agent: Option<String> = row.get(5)?;
    let parent_id: Option<String> = row.get(6)?;
    let cost_source: Option<String> = row.get(21)?;
    Ok(SessionHead {
        version: metadata
            .as_ref()
            .and_then(|meta| meta.version.as_ref())
            .and_then(Value::as_str)
            .map(str::to_owned),
        summary_files: metadata
            .as_ref()
            .and_then(|meta| meta.summary_files.clone()),
        reference: SessionReference {
            source_node_id: row.get(0)?,
            agent_name: row.get(1)?,
            session_id: row.get(2)?,
        },
        title: row.get(3)?,
        directory: row.get(4)?,
        display_title: None,
        parent_reference: parent_agent.zip(parent_id).map(|(agent_name, session_id)| {
            SessionReference {
                source_node_id: source_node_id.clone(),
                agent_name,
                session_id,
            }
        }),
        project_identity: ProjectIdentity {
            kind: row.get(7)?,
            key: row.get(8)?,
            display_name: row.get(9)?,
        },
        recorded_git_remotes: metadata
            .map(|meta| meta.recorded_git_remotes)
            .unwrap_or_default(),
        project_identity_resolver_revision: row.get(10)?,
        project_identity_input_signature: row.get(11)?,
        time_created: row.get(12)?,
        time_updated: row.get::<_, Option<f64>>(13)?.unwrap_or(row.get(12)?),
        stats: SessionStats {
            cost_inputs: Vec::new(),
            message_count: row.get::<_, i64>(14)? as usize,
            total_input_tokens: row.get(15)?,
            total_output_tokens: row.get(16)?,
            total_cost: row.get(17)?,
            total_cache_read_tokens: row.get(18)?,
            total_cache_create_tokens: row.get(19)?,
            total_tokens: row.get(20)?,
            cost_source: match cost_source.as_deref() {
                Some("recorded") => Some(CostSource::Recorded),
                Some("estimated") => Some(CostSource::Estimated),
                _ => None,
            },
        },
        model_usage: optional_json(row, 22)?,
        smart_tags: optional_json(row, 23)?.unwrap_or_default(),
        smart_tags_source_updated_at: row.get(24)?,
        smart_tags_classifier_revision: row.get(25)?,
    })
}
