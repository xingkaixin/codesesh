mod cursor;
mod json_index;
pub use json_index::JsonBaseline;
mod facts;
mod json;
mod legacy_parts;
mod read;
mod schema;
mod snapshot;
use crate::{
    agents::codex::ParsedSession,
    contract::{
        CostSource, Message, MessagePart, Role, SessionDetail, SessionHead, SessionReference,
    },
};
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub const CACHE_SCHEMA_VERSION: i64 = 34;

pub use read::{detail as detail_from_connection, detail_with_cursor, visit_detail_messages};
pub use snapshot::load as snapshot_from_connection;
pub fn head_from_connection(
    connection: &Connection,
    reference: &SessionReference,
) -> Result<Option<SessionHead>> {
    Ok(connection
        .query_row(
            "SELECT * FROM sessions WHERE agent_name=? AND session_id=? AND publication_id IS NULL",
            params![reference.agent_name, reference.session_id],
            snapshot::head,
        )
        .optional()?)
}

pub struct Cache {
    connection: Connection,
    snapshot_data_version: std::cell::Cell<Option<i64>>,
}

impl Cache {
    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn snapshot(&self) -> Result<Vec<SessionHead>> {
        let transaction = self.connection.unchecked_transaction()?;
        let heads = snapshot::load(&transaction)?;
        let version = transaction.pragma_query_value(None, "data_version", |row| row.get(0))?;
        transaction.commit()?;
        self.snapshot_data_version.set(Some(version));
        Ok(heads)
    }

    pub fn refresh_snapshot(
        &self,
        previous: &[SessionHead],
        changed: &[SessionReference],
    ) -> Result<Vec<SessionHead>> {
        let transaction = self.connection.unchecked_transaction()?;
        let references = {
            let mut query = transaction.prepare(
                "SELECT agent_name,session_id FROM sessions WHERE publication_id IS NULL ORDER BY activity_time DESC,agent_name,session_id",
            )?;
            query
                .query_map([], |row| {
                    Ok(SessionReference {
                        agent_name: row.get(0)?,
                        session_id: row.get(1)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let version = transaction.pragma_query_value(None, "data_version", |row| row.get(0))?;
        let heads = if self.snapshot_data_version.get() != Some(version) {
            // Another connection may have changed headers outside this publication.
            snapshot::load(&transaction)?
        } else {
            let previous: std::collections::HashMap<_, _> = previous
                .iter()
                .map(|head| (&head.reference, head))
                .collect();
            let changed: std::collections::HashSet<_> = changed.iter().collect();
            references
                .into_iter()
                .map(|reference| {
                    if !changed.contains(&reference)
                        && let Some(head) = previous.get(&reference)
                    {
                        return Ok((*head).clone());
                    }
                    self.head(&reference)?
                        .ok_or_else(|| anyhow::anyhow!("published session is missing"))
                })
                .collect::<Result<Vec<_>>>()?
        };
        transaction.commit()?;
        self.snapshot_data_version.set(Some(version));
        Ok(heads)
    }

    pub fn agent_snapshot(&self, agent: &str) -> Result<Vec<SessionHead>> {
        let mut query = self.connection.prepare("SELECT * FROM sessions WHERE publication_id IS NULL AND agent_name=? ORDER BY activity_time DESC,session_id")?;
        Ok(query
            .query_map([agent], snapshot::head)?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn head(&self, reference: &SessionReference) -> Result<Option<SessionHead>> {
        Ok(self.connection.query_row("SELECT * FROM sessions WHERE agent_name=? AND session_id=? AND publication_id IS NULL",params![reference.agent_name,reference.session_id],snapshot::head).optional()?)
    }

    pub fn open_read_only(path: &Path) -> Result<Self> {
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        anyhow::ensure!(
            version == CACHE_SCHEMA_VERSION,
            "Read-only cache requires schema {CACHE_SCHEMA_VERSION}, found {version}"
        );
        Ok(Self {
            connection,
            snapshot_data_version: std::cell::Cell::new(None),
        })
    }

    pub fn open_preview(path: &Path) -> Result<Self> {
        Self::open(Some(path))
    }

    pub fn detail(&self, head: SessionHead) -> Result<Option<SessionDetail>> {
        read::detail(&self.connection, head)
    }

    pub fn open(path: Option<&Path>) -> Result<Self> {
        let connection = match path {
            Some(path) => {
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                Connection::open(path)?
            }
            None => Connection::open_in_memory()?,
        };
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE;")?;
        schema::ensure(&connection, path)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA cache_size=-16384")?;
        Ok(Self {
            connection,
            snapshot_data_version: std::cell::Cell::new(None),
        })
    }

    pub fn publish(&mut self, sessions: &mut [ParsedSession]) -> Result<()> {
        self.apply(sessions, &[])
    }

    pub fn apply(
        &mut self,
        sessions: &mut [ParsedSession],
        removed: &[SessionReference],
    ) -> Result<()> {
        self.apply_with_recovery(sessions, removed, None, None)
    }

    pub fn apply_checkpoint(
        &mut self,
        sessions: &mut [ParsedSession],
        removed: &[SessionReference],
        agent: &str,
        checkpoint: &Option<serde_json::Value>,
        complete: bool,
    ) -> Result<()> {
        self.apply_with_recovery(sessions, removed, Some((agent, checkpoint, complete)), None)
    }

    fn apply_with_recovery(
        &mut self,
        sessions: &mut [ParsedSession],
        removed: &[SessionReference],
        checkpoint: Option<(&str, &Option<serde_json::Value>, bool)>,
        index: Option<&json_index::Publication<'_>>,
    ) -> Result<()> {
        let result = self.apply_inner(sessions, removed, checkpoint, index);
        let fts_corrupt=result.as_ref().err().and_then(|error|error.downcast_ref::<rusqlite::Error>()).is_some_and(|error|matches!(error,rusqlite::Error::SqliteFailure(code,_) if code.extended_code==rusqlite::ffi::SQLITE_CORRUPT_VTAB));
        if fts_corrupt {
            self.rebuild_search_indexes()?;
            self.apply_inner(sessions, removed, checkpoint, index)
        } else {
            result
        }
    }

    fn apply_inner(
        &mut self,
        sessions: &mut [ParsedSession],
        removed: &[SessionReference],
        checkpoint: Option<(&str, &Option<serde_json::Value>, bool)>,
        index: Option<&json_index::Publication<'_>>,
    ) -> Result<()> {
        let profile = std::env::var_os("CODESESH_PROFILE_SCAN").is_some();
        let mut message_time = std::time::Duration::ZERO;
        let mut document_time = std::time::Duration::ZERO;
        let mut facts_time = std::time::Duration::ZERO;
        let transaction = self.connection.transaction()?;
        if let Some(index) = index {
            index.validate(&transaction)?;
        }
        for reference in removed {
            for table in ["pending_reindex", "session_documents", "sessions"] {
                transaction.execute(
                    &format!("DELETE FROM {table} WHERE agent_name=? AND session_id=?"),
                    params![reference.agent_name, reference.session_id],
                )?;
            }
        }
        let mut cursors = Vec::with_capacity(sessions.len());
        for (order, session) in sessions.iter().enumerate() {
            let head = &session.head;
            let reference = &head.reference;
            let file_meta = std::fs::metadata(&session.source).ok();
            let modified = file_meta
                .as_ref()
                .and_then(|meta| meta.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs_f64() * 1000.0);
            let fingerprint = json::stringify(&serde_json::json!([
                crate::agents::PARSER_VERSION,
                modified,
                file_meta.as_ref().map(|meta| meta.len())
            ]))?;
            let mut metadata = serde_json::json!({"sourcePath":session.source.to_string_lossy(),"sourceFingerprint":fingerprint,"parserVersion":crate::agents::PARSER_VERSION});
            if let Some(version) = &head.version {
                metadata["rustHeadVersion"] = serde_json::Value::String(version.clone());
            }
            if let Some(files) = &head.summary_files {
                metadata["rustHeadSummaryFiles"] = files.clone();
            }
            let detail_version = json::stringify(&serde_json::json!([
                "session-detail-v1",
                fingerprint,
                [["parserVersion", crate::agents::PARSER_VERSION]]
            ]))?;
            transaction.execute(
                "DELETE FROM session_documents WHERE agent_name=? AND session_id=?",
                params![reference.agent_name, reference.session_id],
            )?;
            transaction.execute(
                "DELETE FROM sessions WHERE agent_name=? AND session_id=?",
                params![reference.agent_name, reference.session_id],
            )?;
            transaction.execute(
                "INSERT INTO sessions(agent_name,session_id,sort_index,title,source_path,directory,project_identity_kind,project_identity_key,project_display_name,project_identity_resolver_revision,project_identity_input_signature,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost,smart_tags_json,smart_tags_source_updated_at,smart_tags_classifier_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![reference.agent_name,reference.session_id,order as i64,head.title,session.source.to_string_lossy(),head.directory,head.project_identity.kind,head.project_identity.key,head.project_identity.display_name,head.project_identity_resolver_revision,head.project_identity_input_signature,head.time_created,head.time_updated,head.time_updated,head.stats.message_count as i64,head.stats.total_input_tokens,head.stats.total_output_tokens,head.stats.total_cost,serde_json::to_string(&head.smart_tags)?,head.smart_tags_source_updated_at,head.smart_tags_classifier_revision],
            )?;
            transaction.execute(
                "UPDATE sessions SET parent_agent_name=?, parent_session_id=?, total_cache_read_tokens=?, total_cache_create_tokens=?, cost_source=?, total_tokens=?, model_usage_json=? WHERE agent_name=? AND session_id=?",
                params![head.parent_reference.as_ref().map(|parent| &parent.agent_name),head.parent_reference.as_ref().map(|parent| &parent.session_id),head.stats.total_cache_read_tokens,head.stats.total_cache_create_tokens,head.stats.cost_source.as_ref().map(CostSource::as_str),head.stats.total_tokens,head.model_usage.as_ref().map(json::stringify).transpose()?,reference.agent_name,reference.session_id],
            )?;
            let message_started = std::time::Instant::now();
            let mut digest = cursor::initial(reference);
            let mut text = session.detail.head.title.trim().to_owned();
            for (index, message) in session.detail.messages.iter().enumerate() {
                let normalized;
                let message = if message.id.is_empty() {
                    let mut copy = message.clone();
                    copy.id = format!("{}:{index}", reference.session_id);
                    normalized = copy;
                    &normalized
                } else {
                    message
                };
                let parts = json::message_parts(head, &message.parts)?;
                let tokens = message
                    .tokens
                    .as_ref()
                    .map(|tokens| json::tokens(&reference.agent_name, tokens))
                    .transpose()?;
                digest = cursor::advance(&digest, message, &parts, tokens.as_deref(), 1)?;
                let content = message_text(message);
                text.push('\n');
                text.push_str(&content);
                transaction.prepare_cached("INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,time_completed,agent,mode,model,provider,tokens_json,cost,cost_source,parts_json,parts_format_version,content_chain_digest,subagent_id,nickname,automated,content_text,tool_metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)")?.execute(
                    params![reference.agent_name,reference.session_id,index as i64,message.id,role_name(&message.role),message.time_created,message.time_completed,message.agent,message.mode,message.model,message.provider,tokens,message.cost,message.cost_source.as_ref().map(CostSource::as_str),parts,digest,message.subagent_id,message.nickname,message.automated.unwrap_or(false),content,facts::tool_metadata(message)?])?;
            }
            message_time += message_started.elapsed();
            let document_started = std::time::Instant::now();
            transaction.execute("INSERT INTO session_documents(agent_name,session_id,title,content_text,content_hash,indexed_message_count,indexed_at,detail_version) VALUES(?,?,?,?,?,?,?,?)", params![reference.agent_name,reference.session_id,session.detail.head.title,text,facts::content_hash(head)?,session.detail.messages.len() as i64,chrono::Utc::now().timestamp_millis(),detail_version])?;
            document_time += document_started.elapsed();
            let facts_started = std::time::Instant::now();
            for activity in &session.detail.file_activity {
                transaction.execute("INSERT INTO session_file_activity(agent_name,session_id,project_identity_key,path,kind,count,latest_time) VALUES(?,?,?,?,?,?,?)",params![reference.agent_name,reference.session_id,activity.project_identity_key,activity.path,activity.kind,activity.count as i64,activity.latest_time])?;
            }
            transaction.execute(
                "UPDATE sessions SET meta_json=? WHERE agent_name=? AND session_id=?",
                params![
                    json::stringify(&metadata)?,
                    reference.agent_name,
                    reference.session_id
                ],
            )?;
            facts::write(&transaction, reference, &session.detail.messages)?;
            transaction.execute(
                "DELETE FROM pending_reindex WHERE agent_name=? AND session_id=?",
                params![reference.agent_name, reference.session_id],
            )?;
            facts_time += facts_started.elapsed();
            cursors.push(cursor::encode(session.detail.messages.len(), &digest)?);
        }
        if let Some((agent, checkpoint, complete)) = checkpoint {
            if let Some(state) = checkpoint
                .as_ref()
                .and_then(|value| value.get("sourceState"))
            {
                transaction.execute("INSERT INTO cache_meta VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                    params![format!("rust_source_state:{agent}"), json::stringify(state)?])?;
            }

            let key = format!("rust_sync_checkpoint:{agent}");
            if complete {
                transaction.execute("DELETE FROM cache_meta WHERE key=?", [key])?;
                let now = chrono::Utc::now().timestamp_millis();
                transaction.execute("INSERT INTO agent_cache VALUES(?,?) ON CONFLICT(agent_name) DO UPDATE SET timestamp=excluded.timestamp",params![agent,now])?;
                transaction.execute("INSERT INTO cache_initialization VALUES(?,?,'session-cache-v2',?) ON CONFLICT(agent_name) DO UPDATE SET index_version=excluded.index_version,last_sync_at=excluded.last_sync_at",params![agent,now,now])?;
            } else if let Some(checkpoint) = checkpoint {
                transaction.execute("INSERT INTO cache_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,json::stringify(checkpoint)?])?;
            }
        }
        if !sessions.is_empty() || !removed.is_empty() {
            transaction.execute("INSERT INTO cache_meta VALUES('analytics_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
        }
        if let Some(index) = index {
            index.publish(&transaction)?;
        }
        let commit_started = std::time::Instant::now();
        transaction.commit()?;
        if profile {
            eprintln!(
                "scan-profile storage messages_ms={:.3} document_ms={:.3} facts_ms={:.3} commit_ms={:.3}",
                message_time.as_secs_f64() * 1000.0,
                document_time.as_secs_f64() * 1000.0,
                facts_time.as_secs_f64() * 1000.0,
                commit_started.elapsed().as_secs_f64() * 1000.0
            );
        }
        for (session, cursor) in sessions.iter_mut().zip(cursors) {
            session.detail.message_cursor = Some(cursor);
            session.detail.message_update = Some("reset".into());
        }
        Ok(())
    }

    pub fn remove(&mut self, references: &[SessionReference]) -> Result<()> {
        self.apply(&mut [], references)
    }

    pub fn mark_initialized(&mut self, agent: &str) -> Result<()> {
        let now = chrono::Utc::now().timestamp_millis();
        let transaction = self.connection.transaction()?;
        transaction.execute("INSERT INTO agent_cache VALUES(?,?) ON CONFLICT(agent_name) DO UPDATE SET timestamp=excluded.timestamp",params![agent,now])?;
        transaction.execute("INSERT INTO cache_initialization VALUES(?,?,'session-cache-v2',?) ON CONFLICT(agent_name) DO UPDATE SET index_version=excluded.index_version,last_sync_at=excluded.last_sync_at",params![agent,now,now])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn rebuild_search_indexes(&mut self) -> Result<()> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO session_documents_fts(session_documents_fts) VALUES('rebuild')",
            [],
        )?;
        transaction.execute("INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts) VALUES('rebuild')",[])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn messages(&self, reference: &SessionReference) -> Result<i64> {
        Ok(self.connection.query_row(
            "SELECT count(*) FROM messages WHERE agent_name=? AND session_id=?",
            params![reference.agent_name, reference.session_id],
            |row| row.get(0),
        )?)
    }
}

pub fn role_name(role: &Role) -> &'static str {
    match role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn message_text(message: &Message) -> String {
    fn append(value: &serde_json::Value, fields: &mut Vec<String>) {
        match value {
            serde_json::Value::Null => (),
            serde_json::Value::String(value) => {
                let value = value.trim();
                if !value.is_empty() {
                    fields.push(value.to_owned());
                }
            }
            serde_json::Value::Array(values) => {
                values.iter().for_each(|value| append(value, fields))
            }
            serde_json::Value::Object(values) => {
                values.values().for_each(|value| append(value, fields))
            }
            value => fields.push(value.to_string()),
        }
    }
    let mut fields = vec![role_name(&message.role).to_owned()];
    for value in [&message.agent, &message.model].into_iter().flatten() {
        append(&serde_json::Value::String(value.clone()), &mut fields);
    }
    for part in &message.parts {
        let value = serde_json::to_value(part).expect("message part serializes");
        append(&value["type"], &mut fields);
        if matches!(part, MessagePart::Tool { .. }) {
            for key in ["title", "tool", "state"] {
                append(&value[key], &mut fields);
            }
        } else {
            append(&value["text"], &mut fields);
        }
    }
    fields.join("\n")
}

#[cfg(test)]
mod tests;
