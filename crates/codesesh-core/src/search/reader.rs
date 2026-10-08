use super::*;
use crate::contract::{CostSource, ProjectIdentity, SessionStats};
use rusqlite::{OptionalExtension, Row, params};

// Search sorts many rows; `s.*` would carry `meta_json` (pricing state) into the sorter.
pub(super) const HEAD_COLUMNS: &str = "s.source_node_id,s.agent_name,s.session_id,s.title,s.directory,s.project_identity_kind,s.project_identity_key,s.project_display_name,s.time_created,s.time_updated,s.message_count,s.total_input_tokens,s.total_output_tokens,s.total_cost,s.total_cache_read_tokens,s.total_cache_create_tokens,s.total_tokens,s.cost_source,s.model_usage_json,s.smart_tags_json,s.smart_tags_source_updated_at";

pub(super) fn head(row: &Row<'_>) -> rusqlite::Result<SessionHead> {
    let source: Option<String> = row.get("cost_source")?;
    let usage: Option<String> = row.get("model_usage_json")?;
    let tags: Option<String> = row.get("smart_tags_json")?;
    Ok(SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            source_node_id: row.get("source_node_id")?,
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
            cost_inputs: Vec::new(),
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
    let (statement, any_message) = if query.is_empty() {
        (
            format!(
                "SELECT {HEAD_COLUMNS} FROM sessions s WHERE s.publication_id IS NULL {} ORDER BY s.activity_time DESC LIMIT ?",
                filters.where_sql()
            ),
            String::new(),
        )
    } else {
        match cjk::statement(connection, query, &mut filters)? {
            Some(statement) => (statement.sql, statement.any_message),
            None => return Ok(Vec::new()),
        }
    };
    filters
        .params
        .push((options.limit.unwrap_or(50) as i64).into());
    let mut statement = connection.prepare(&statement)?;
    let rows = statement
        .query_map(params_from_iter(filters.params), head)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let terms = snippet::Terms::parse(query);
    let mut message_matches = message_matches(connection, &rows, &any_message, &terms)?;
    let mut result = Vec::with_capacity(rows.len());
    for session in rows {
        let (text, ranges, kind, message_index) = if terms.values.is_empty() {
            (
                format!("Recent session · {}", session.directory),
                Vec::new(),
                "recent",
                None,
            )
        } else if terms.matches(&session.title) {
            let (text, ranges) = snippet::build(&session.title, &terms);
            (text, ranges, "title", None)
        } else {
            message_matches
                .remove(&session.reference)
                .unwrap_or_else(|| {
                    let ranges = snippet::highlights(&session.title, &terms);
                    (session.title.clone(), ranges, "assistant_reply", None)
                })
        };
        result.push(SearchResult {
            reference: session.reference.clone(),
            session,
            snippet: text,
            snippet_highlights: ranges,
            match_type: kind.into(),
            message_index,
        });
    }
    Ok(result)
}

type MessageMatch = (String, Vec<HighlightRange>, &'static str, Option<usize>);

const MESSAGE_MATCH_SCAN_LIMIT: usize = 200;

fn message_matches(
    connection: &Connection,
    rows: &[SessionHead],
    any_message: &str,
    terms: &snippet::Terms,
) -> Result<HashMap<SessionReference, MessageMatch>> {
    let candidates: Vec<_> = rows
        .iter()
        .filter(|head| !terms.matches(&head.title))
        .map(|head| &head.reference)
        .collect();
    let mut matches = HashMap::new();
    if candidates.is_empty() || terms.values.is_empty() {
        return Ok(matches);
    }
    let values = vec!["(?, ?, ?)"; candidates.len()].join(",");
    let mut params: Vec<Value> = vec![any_message.to_owned().into()];
    params.extend(candidates.iter().flat_map(|r| {
        [
            r.source_node_id.clone().into(),
            r.agent_name.clone().into(),
            r.session_id.clone().into(),
        ]
    }));
    let mut hits: HashMap<SessionReference, Vec<i64>> = HashMap::new();
    let mut query = connection.prepare(&format!("SELECT m.rowid,m.source_node_id,m.agent_name,m.session_id FROM message_fts JOIN messages m ON m.rowid=message_fts.rowid WHERE message_fts MATCH ? AND (m.source_node_id,m.agent_name,m.session_id) IN (VALUES {values}) ORDER BY m.source_node_id,m.agent_name,m.session_id,m.message_index"))?;
    let mut rows = query.query(params_from_iter(params))?;
    while let Some(row) = rows.next()? {
        hits.entry(SessionReference {
            source_node_id: row.get(1)?,
            agent_name: row.get(2)?,
            session_id: row.get(3)?,
        })
        .or_default()
        .push(row.get(0)?);
    }
    let mut message = connection.prepare_cached(
        "SELECT message_index,role,mode,tool_metadata_json,content_text FROM messages WHERE rowid=?",
    )?;
    for reference in candidates {
        let mut covered = HashSet::new();
        let mut covering = Vec::new();
        for rowid in hits
            .get(reference)
            .into_iter()
            .flatten()
            .take(MESSAGE_MATCH_SCAN_LIMIT)
        {
            let (index, role, mode, tools, text) = message.query_row([rowid], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?;
            if terms.matches(&text) {
                let kind = if role == "user" {
                    "user_message"
                } else if role == "tool"
                    || mode.as_deref() == Some("tool")
                    || tools.is_some_and(|s| !s.is_empty())
                {
                    "tool_output"
                } else {
                    "assistant_reply"
                };
                let (text, ranges) = snippet::build(&text, terms);
                matches.insert(
                    reference.clone(),
                    (text, ranges, kind, Some(index as usize)),
                );
                break;
            }
            let lower = text.to_lowercase();
            let before = covered.len();
            covered.extend(
                terms
                    .values
                    .iter()
                    .filter(|term| lower.contains(term.as_str())),
            );
            if covered.len() > before {
                covering.push(text);
            }
        }
        if matches.contains_key(reference) {
            continue;
        }
        let text = if covering.is_empty() {
            connection
                .query_row(
                    "SELECT content_text FROM messages WHERE source_node_id=? AND agent_name=? AND session_id=? AND content_text<>'' ORDER BY message_index LIMIT 1",
                    params![reference.source_node_id, reference.agent_name, reference.session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
        } else {
            Some(covering.join("\n"))
        };
        if let Some(text) = text {
            let (text, ranges) = snippet::build(&text, terms);
            matches.insert(reference.clone(), (text, ranges, "assistant_reply", None));
        }
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
        "SELECT {HEAD_COLUMNS},fa.path,fa.kind,fa.count FROM (SELECT fa.rowid AS activity_rowid,ROW_NUMBER() OVER (PARTITION BY fa.source_node_id,fa.agent_name,fa.session_id ORDER BY fa.latest_time DESC,fa.count DESC,fa.path) AS session_rank FROM session_file_activity fa JOIN sessions s ON s.source_node_id=fa.source_node_id AND s.agent_name=fa.agent_name AND s.session_id=fa.session_id AND s.publication_id IS NULL WHERE 1=1 {}) ranked JOIN session_file_activity fa ON fa.rowid=ranked.activity_rowid JOIN sessions s ON s.source_node_id=fa.source_node_id AND s.agent_name=fa.agent_name AND s.session_id=fa.session_id WHERE ranked.session_rank=1 ORDER BY fa.latest_time DESC,fa.count DESC,fa.path LIMIT ?",
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
            message_index: None,
        })
    })
    .collect()
}
