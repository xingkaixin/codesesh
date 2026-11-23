use crate::model::*;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

const HEAD_BATCH_SIZE: usize = 250;

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
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Null => Ok(None),
        rusqlite::types::ValueRef::Text(bytes) => {
            serde_json::from_slice(bytes).map(Some).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    column,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        }
        other => Err(rusqlite::Error::InvalidColumnType(
            column,
            String::new(),
            other.data_type(),
        )),
    }
}

fn head_metadata_json(row: &Row<'_>, column: usize) -> rusqlite::Result<Option<HeadMetadata>> {
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Null => Ok(None),
        rusqlite::types::ValueRef::Text(b"{}") | rusqlite::types::ValueRef::Text(b"null") => {
            Ok(None)
        }
        rusqlite::types::ValueRef::Text(bytes) => {
            serde_json::from_slice::<Option<HeadMetadata>>(bytes).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    column,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })
        }
        other => Err(rusqlite::Error::InvalidColumnType(
            column,
            String::new(),
            other.data_type(),
        )),
    }
}

fn smart_tags_json(row: &Row<'_>, column: usize) -> rusqlite::Result<Vec<String>> {
    match row.get_ref(column)? {
        rusqlite::types::ValueRef::Null
        | rusqlite::types::ValueRef::Text(b"[]")
        | rusqlite::types::ValueRef::Text(b"null") => Ok(Vec::new()),
        rusqlite::types::ValueRef::Text(bytes) => serde_json::from_slice(bytes).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        }),
        other => Err(rusqlite::Error::InvalidColumnType(
            column,
            String::new(),
            other.data_type(),
        )),
    }
}

pub fn load(connection: &Connection) -> Result<Vec<SessionHead>> {
    let mut query=connection.prepare(&format!("SELECT {HEAD_COLUMNS} FROM sessions WHERE publication_id IS NULL ORDER BY activity_time DESC,agent_name,session_id"))?;
    Ok(query
        .query_map([], head)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

pub(super) fn load_many(
    connection: &Connection,
    references: &[&SessionReference],
) -> Result<HashMap<SessionReference, Arc<SessionHead>>> {
    if references.is_empty() {
        return Ok(HashMap::new());
    }
    let mut loaded = HashMap::with_capacity(references.len());
    if references.len() == 1 {
        let reference = references[0];
        let mut query = connection.prepare_cached(&format!(
            "SELECT {HEAD_COLUMNS} FROM sessions WHERE source_node_id=? AND agent_name=? AND session_id=? AND publication_id IS NULL"
        ))?;
        if let Some(item) = query
            .query_row(
                params![
                    reference.source_node_id,
                    reference.agent_name,
                    reference.session_id
                ],
                head,
            )
            .optional()?
        {
            loaded.insert(item.reference.clone(), Arc::new(item));
        }
        return Ok(loaded);
    }
    for chunk in references.chunks(HEAD_BATCH_SIZE) {
        let mut placeholders = String::with_capacity(chunk.len() * 8);
        for index in 0..chunk.len() {
            if index > 0 {
                placeholders.push(',');
            }
            placeholders.push_str("(?,?,?)");
        }
        let sql = format!(
            "SELECT {HEAD_COLUMNS} FROM sessions WHERE publication_id IS NULL AND (source_node_id,agent_name,session_id) IN (VALUES {placeholders})"
        );
        let mut query = connection.prepare(&sql)?;
        let values = chunk.iter().flat_map(|reference| {
            [
                reference.source_node_id.as_str(),
                reference.agent_name.as_str(),
                reference.session_id.as_str(),
            ]
        });
        for row in query.query_map(params_from_iter(values), head)? {
            let item = row?;
            loaded.insert(item.reference.clone(), Arc::new(item));
        }
    }
    Ok(loaded)
}

pub fn head(row: &Row<'_>) -> rusqlite::Result<SessionHead> {
    // All callers select HEAD_COLUMNS; positions avoid a name scan for every field.
    let source_node_id: String = row.get(0)?;
    let metadata = head_metadata_json(row, 26)?;
    let parent_agent: Option<String> = row.get(5)?;
    let parent_id: Option<String> = row.get(6)?;
    let cost_source = match row.get_ref(21)? {
        rusqlite::types::ValueRef::Text(b"recorded") => Some(CostSource::Recorded),
        rusqlite::types::ValueRef::Text(b"estimated") => Some(CostSource::Estimated),
        _ => None,
    };
    let time_created: f64 = row.get(12)?;
    let time_updated = row.get::<_, Option<f64>>(13)?.unwrap_or(time_created);
    let parent_reference =
        parent_agent
            .zip(parent_id)
            .map(|(agent_name, session_id)| SessionReference {
                source_node_id: source_node_id.clone(),
                agent_name,
                session_id,
            });
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
            source_node_id,
            agent_name: row.get(1)?,
            session_id: row.get(2)?,
        },
        title: row.get(3)?,
        directory: row.get(4)?,
        display_title: None,
        parent_reference,
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
        time_created,
        time_updated,
        stats: SessionStats {
            cost_inputs: Vec::new(),
            message_count: row.get::<_, i64>(14)? as usize,
            total_input_tokens: row.get(15)?,
            total_output_tokens: row.get(16)?,
            total_cost: row.get(17)?,
            total_cache_read_tokens: row.get(18)?,
            total_cache_create_tokens: row.get(19)?,
            total_tokens: row.get(20)?,
            cost_source,
        },
        model_usage: optional_json(row, 22)?,
        smart_tags: smart_tags_json(row, 23)?,
        smart_tags_source_updated_at: row.get(24)?,
        smart_tags_classifier_revision: row.get(25)?,
    })
}
