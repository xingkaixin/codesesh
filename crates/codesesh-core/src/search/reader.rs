use super::*;
use crate::contract::{CostSource, ProjectIdentity, SessionStats};
use rusqlite::Row;

pub(super) fn head(row: &Row<'_>) -> rusqlite::Result<SessionHead> {
    let source: Option<String> = row.get("cost_source")?;
    let usage: Option<String> = row.get("model_usage_json")?;
    let tags: Option<String> = row.get("smart_tags_json")?;
    Ok(SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: row.get("agent_name")?,
            session_id: row.get("session_id")?,
        },
        title: row.get("title")?,
        directory: row.get("directory")?,
        display_title: None,
        parent_reference: None,
        project_identity: ProjectIdentity {
            kind: row.get("project_identity_kind")?,
            key: row.get("project_identity_key")?,
            display_name: row.get("project_display_name")?,
        },
        project_identity_resolver_revision: None,
        project_identity_input_signature: None,
        time_created: row.get("time_created")?,
        time_updated: row
            .get::<_, Option<f64>>("time_updated")?
            .unwrap_or_default(),
        stats: SessionStats {
            message_count: row.get::<_, i64>("message_count")? as usize,
            total_input_tokens: row.get("total_input_tokens")?,
            total_output_tokens: row.get("total_output_tokens")?,
            total_cost: row.get("total_cost")?,
            total_cache_read_tokens: row.get("total_cache_read_tokens")?,
            total_cache_create_tokens: row.get("total_cache_create_tokens")?,
            total_tokens: row.get("total_tokens")?,
            cost_source: match source.as_deref() {
                Some("recorded") => Some(CostSource::Recorded),
                Some("estimated") => Some(CostSource::Estimated),
                _ => None,
            },
        },
        model_usage: usage.and_then(|s| serde_json::from_str(&s).ok()),
        smart_tags: tags
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        smart_tags_source_updated_at: row.get("smart_tags_source_updated_at")?,
        smart_tags_classifier_revision: None,
    })
}

pub(super) fn search_prepared(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let mut filters = sql::build(options);
    let query = query.trim();
    let statement = if query.is_empty() {
        format!(
            "SELECT s.*, '' AS snippet FROM sessions s WHERE s.publication_id IS NULL {} ORDER BY s.activity_time DESC LIMIT ?",
            filters.where_sql()
        )
    } else {
        let fts = to_fts_query(query);
        if fts.is_empty() {
            return Ok(Vec::new());
        }
        filters.params.insert(0, fts.into());
        format!(
            "SELECT s.*, COALESCE(NULLIF(snippet(session_documents_fts,1,'','',' … ',18),''),highlight(session_documents_fts,0,'','')) AS snippet FROM session_documents_fts JOIN session_documents d ON d.id = session_documents_fts.rowid JOIN sessions s ON s.agent_name = d.agent_name AND s.session_id = d.session_id WHERE session_documents_fts MATCH ? AND s.publication_id IS NULL {} ORDER BY bm25(session_documents_fts,8.0,1.0),s.activity_time DESC LIMIT ?",
            filters.where_sql()
        )
    };
    filters
        .params
        .push((options.limit.unwrap_or(50) as i64).into());
    let mut statement = connection.prepare(&statement)?;
    let rows = statement
        .query_map(params_from_iter(filters.params), |row| {
            Ok((head(row)?, row.get::<_, String>("snippet")?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let terms = snippet::Terms::parse(query);
    let mut result = Vec::with_capacity(rows.len());
    let mut message_matches = first_message_matches(connection, &rows, &terms)?;
    for (session, fallback) in rows {
        let (text, ranges, kind) = if terms.values.is_empty() {
            (
                format!("Recent session · {}", session.directory),
                Vec::new(),
                "recent",
            )
        } else if terms.matches(&session.title) {
            let (text, ranges) = snippet::build(&session.title, &terms);
            (text, ranges, "title")
        } else {
            message_matches
                .remove(&session.reference)
                .unwrap_or_else(|| {
                    let ranges = snippet::highlights(&fallback, &terms.values);
                    (fallback, ranges, "assistant_reply")
                })
        };
        result.push(SearchResult {
            reference: session.reference.clone(),
            session,
            snippet: text,
            snippet_highlights: ranges,
            match_type: kind.into(),
        });
    }
    Ok(result)
}

type MessageMatch = (String, Vec<HighlightRange>, &'static str);

fn first_message_matches(
    connection: &Connection,
    rows: &[(SessionHead, String)],
    terms: &snippet::Terms,
) -> Result<HashMap<SessionReference, MessageMatch>> {
    let candidates: Vec<_> = rows
        .iter()
        .filter(|(head, _)| !terms.matches(&head.title))
        .map(|(head, _)| &head.reference)
        .collect();
    let mut matches = HashMap::new();
    if candidates.is_empty() {
        return Ok(matches);
    }
    let owned_terms = terms.clone();
    connection.create_scalar_function(
        "codesesh_message_matches_terms",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        move |ctx| {
            let text: Option<String> = ctx.get(0)?;
            Ok(owned_terms.matches(text.as_deref().unwrap_or_default()))
        },
    )?;
    let values = vec!["(?, ?)"; candidates.len()].join(",");
    let params: Vec<Value> = candidates
        .iter()
        .flat_map(|r| [r.agent_name.clone().into(), r.session_id.clone().into()])
        .collect();
    let mut query=connection.prepare(&format!("WITH candidate_sessions(agent_name,session_id) AS (VALUES {values}), first_message_matches AS MATERIALIZED (SELECT c.agent_name,c.session_id,(SELECT m.rowid FROM messages m INDEXED BY idx_messages_session WHERE m.agent_name=c.agent_name AND m.session_id=c.session_id AND codesesh_message_matches_terms(m.content_text) ORDER BY m.message_index LIMIT 1) AS message_rowid FROM candidate_sessions c) SELECT m.agent_name,m.session_id,m.role,m.mode,m.tool_metadata_json,m.content_text FROM first_message_matches f JOIN messages m ON m.rowid=f.message_rowid"))?;
    let mut rows = query.query(params_from_iter(params))?;
    while let Some(row) = rows.next()? {
        let reference = SessionReference {
            agent_name: row.get("agent_name")?,
            session_id: row.get("session_id")?,
        };
        let text: String = row.get("content_text")?;
        let role: String = row.get("role")?;
        let mode: Option<String> = row.get("mode")?;
        let tools: Option<String> = row.get("tool_metadata_json")?;
        let kind = if role == "user" {
            "user_message"
        } else if role == "tool"
            || mode.as_deref() == Some("tool")
            || tools.as_ref().is_some_and(|s| !s.is_empty())
        {
            "tool_output"
        } else {
            "assistant_reply"
        };
        let (text, ranges) = snippet::build(&text, terms);
        matches.insert(reference, (text, ranges, kind));
    }
    Ok(matches)
}

pub(super) fn search_files(
    connection: &Connection,
    query: &str,
    options: &SearchOptions,
) -> Result<Vec<SearchResult>> {
    let path = sql::normalize_file(query);
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let mut filters = sql::build(options);
    sql::file_filter(&mut filters, path);
    if let Some(kind) = &options.file_kind {
        filters.text("fa.kind = ?", kind);
    }
    let statement = format!(
        "SELECT s.*,fa.path,fa.kind,fa.count FROM (SELECT fa.rowid AS activity_rowid,ROW_NUMBER() OVER (PARTITION BY fa.agent_name,fa.session_id ORDER BY fa.latest_time DESC,fa.count DESC,fa.path) AS session_rank FROM session_file_activity fa JOIN sessions s ON s.agent_name=fa.agent_name AND s.session_id=fa.session_id AND s.publication_id IS NULL WHERE 1=1 {}) ranked JOIN session_file_activity fa ON fa.rowid=ranked.activity_rowid JOIN sessions s ON s.agent_name=fa.agent_name AND s.session_id=fa.session_id WHERE ranked.session_rank=1 ORDER BY fa.latest_time DESC,fa.count DESC,fa.path LIMIT ?",
        filters.where_sql()
    );
    filters
        .params
        .push((options.limit.unwrap_or(50) as i64).into());
    let mut statement = connection.prepare(&statement)?;
    let rows = statement.query_map(params_from_iter(filters.params), |row| {
        Ok((
            head(row)?,
            row.get::<_, String>("path")?,
            row.get::<_, String>("kind")?,
            row.get::<_, i64>("count")?,
        ))
    })?;
    rows.map(|row| {
        let (session, file, kind, count) = row?;
        let prefix = format!("{kind} ");
        let lower = file.to_lowercase();
        let highlights = lower
            .find(&path.to_lowercase())
            .map(|i| {
                let start = prefix.encode_utf16().count() + lower[..i].encode_utf16().count();
                vec![HighlightRange {
                    start,
                    end: start + path.encode_utf16().count(),
                }]
            })
            .unwrap_or_default();
        Ok(SearchResult {
            reference: session.reference.clone(),
            session,
            snippet: format!("{prefix}{file} · {count} events"),
            snippet_highlights: highlights,
            match_type: "file_path".into(),
        })
    })
    .collect()
}
