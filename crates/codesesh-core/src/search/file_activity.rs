use super::{ProjectScope, QueryScope, SearchOptions, prepare, reader, sql};
use crate::contract::{SessionFileActivity, SessionHead};
use anyhow::Result;
use rusqlite::{Connection, params_from_iter};
use serde::Serialize;

#[derive(Clone, Debug, Default)]
pub struct FileActivityOptions {
    pub agent: Option<String>,
    pub session_id: Option<String>,
    pub project_kind: Option<String>,
    pub project_key: Option<String>,
    pub project: Option<String>,
    pub project_scope: Option<ProjectScope>,
    pub query_scope: Option<QueryScope>,
    pub path: Option<String>,
    pub kind: Option<String>,
    pub from: Option<f64>,
    pub to: Option<f64>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileActivityResult {
    #[serde(flatten)]
    pub activity: SessionFileActivity,
    pub session: SessionHead,
}

pub fn list_file_activity(
    connection: &Connection,
    options: &FileActivityOptions,
) -> Result<Vec<FileActivityResult>> {
    let (_, search) = prepare(
        connection,
        "",
        &SearchOptions {
            agent: options.agent.clone(),
            project_scope: options.project_scope.clone(),
            query_scope: options.query_scope.clone(),
            ..Default::default()
        },
    )?;
    let mut filters = sql::build(&search);
    match (&options.project_kind, &options.project_key) {
        (Some(kind), Some(key)) => {
            filters.text("s.project_identity_kind = ?", kind);
            filters.text("fa.project_identity_key = ?", key);
        }
        (None, None) => (),
        _ => filters.clauses.push("0".into()),
    }
    if let Some(project) = &options.project {
        filters.clauses.push("(LOWER(fa.project_identity_key) LIKE ? ESCAPE '\\' OR LOWER(s.project_display_name) LIKE ? ESCAPE '\\' OR LOWER(s.directory) LIKE ? ESCAPE '\\')".into());
        filters.params.extend(std::iter::repeat_n(
            rusqlite::types::Value::Text(sql::like_pattern(project)),
            3,
        ));
    }
    if let Some(session_id) = &options.session_id {
        filters.text("fa.session_id = ?", session_id);
    }
    if let Some(path) = &options.path
        && !sql::normalize_file(path).is_empty()
    {
        sql::file_filter(&mut filters, path);
    }
    if let Some(kind) = &options.kind {
        filters.text("fa.kind = ?", kind);
    }
    for (clause, value) in [
        ("fa.latest_time >= ?", options.from),
        ("fa.latest_time <= ?", options.to),
    ] {
        if let Some(value) = value {
            filters.clauses.push(clause.into());
            filters.params.push(value.into());
        }
    }
    let query = format!(
        "SELECT s.*,fa.project_identity_key AS file_project_identity_key,fa.path,fa.kind,fa.count,fa.latest_time FROM session_file_activity fa JOIN sessions s ON s.agent_name=fa.agent_name AND s.session_id=fa.session_id AND s.publication_id IS NULL WHERE 1=1 {} ORDER BY fa.latest_time DESC,fa.count DESC,fa.path LIMIT ?",
        filters.where_sql()
    );
    filters
        .params
        .push((options.limit.unwrap_or(50) as i64).into());
    let mut statement = connection.prepare(&query)?;
    statement
        .query_map(params_from_iter(filters.params), |row| {
            let mut session = reader::head(row)?;
            session.project_identity.key = row.get("file_project_identity_key")?;
            Ok(FileActivityResult {
                activity: SessionFileActivity {
                    reference: session.reference.clone(),
                    project_identity_key: row.get("file_project_identity_key")?,
                    path: row.get("path")?,
                    kind: row.get("kind")?,
                    count: row.get::<_, i64>("count")? as usize,
                    latest_time: row.get("latest_time")?,
                },
                session,
            })
        })?
        .map(|row| row.map_err(Into::into))
        .collect()
}
