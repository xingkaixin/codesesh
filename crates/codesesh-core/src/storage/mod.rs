mod cursor;
mod json;
mod read;
use crate::{
    agents::codex::ParsedSession,
    contract::{
        CostSource, Message, MessagePart, Role, SessionDetail, SessionHead, SessionReference,
    },
};
use anyhow::{Result, bail};
use rusqlite::{Connection, params};
use std::path::Path;

pub const CACHE_SCHEMA_VERSION: i64 = 34;

pub struct Cache {
    connection: Connection,
}

impl Cache {
    pub fn open_preview(path: &Path) -> Result<Self> {
        if path.exists() {
            let connection =
                Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let preview = connection
                .query_row(
                    "SELECT value FROM cache_meta WHERE key='rust_preview_v1'",
                    [],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            if preview.as_deref() != Some("1") {
                bail!(
                    "Rust P1 cannot open an existing Node cache; use an isolated HOME for migration testing"
                );
            }
        }
        let cache = Self::open(Some(path))?;
        cache.connection.execute(
            "INSERT OR REPLACE INTO cache_meta(key,value) VALUES('rust_preview_v1','1')",
            [],
        )?;
        Ok(cache)
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
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA temp_store=FILE;",
        )?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version == 0 {
            let tables: i64 =
                connection.query_row("SELECT count(*) FROM sqlite_master", [], |row| row.get(0))?;
            if tables > 0 {
                bail!("Rust P1 cannot migrate an existing cache");
            }
            connection.execute_batch(include_str!("schema.sql"))?;
            connection.pragma_update(None, "user_version", CACHE_SCHEMA_VERSION)?;
            connection.execute(
                "INSERT INTO cache_meta(key,value) VALUES('version','34')",
                [],
            )?;
        } else if version != CACHE_SCHEMA_VERSION {
            bail!("Unsupported cache schema {version}; expected 34");
        }
        Ok(Self { connection })
    }

    pub fn publish(&mut self, sessions: &mut [ParsedSession]) -> Result<()> {
        let transaction = self.connection.transaction()?;
        let mut cursors = Vec::with_capacity(sessions.len());
        for (order, session) in sessions.iter().enumerate() {
            let head = &session.detail.head;
            let reference = &head.reference;
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
            let mut digest = cursor::initial(reference);
            let mut text = head.title.clone();
            for (index, message) in session.detail.messages.iter().enumerate() {
                let parts = json::stringify(&message.parts)?;
                digest = cursor::advance(&digest, message, &parts)?;
                let content = message_text(message);
                text.push('\n');
                text.push_str(&content);
                transaction.execute("INSERT INTO messages(agent_name,session_id,message_index,message_id,role,time_created,time_completed,agent,mode,model,provider,tokens_json,cost,cost_source,parts_json,parts_format_version,content_chain_digest,subagent_id,nickname,automated,content_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)",
                    params![reference.agent_name,reference.session_id,index as i64,message.id,role_name(&message.role),message.time_created,message.time_completed,message.agent,message.mode,message.model,message.provider,message.tokens.as_ref().map(json::stringify).transpose()?,message.cost,message.cost_source.as_ref().map(CostSource::as_str),parts,digest,message.subagent_id,message.nickname,message.automated.unwrap_or(false),content])?;
            }
            transaction.execute("INSERT INTO session_documents(agent_name,session_id,title,content_text,content_hash,indexed_message_count,indexed_at) VALUES(?,?,?,?,?,?,?)", params![reference.agent_name,reference.session_id,head.title,text,"",head.stats.message_count as i64,chrono::Utc::now().timestamp_millis()])?;
            cursors.push(cursor::encode(session.detail.messages.len(), &digest)?);
        }
        transaction.commit()?;
        for (session, cursor) in sessions.iter_mut().zip(cursors) {
            session.detail.message_cursor = Some(cursor);
            session.detail.message_update = Some("reset".into());
        }
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
    let mut fields = vec![role_name(&message.role).to_owned()];
    fields.extend(
        [&message.agent, &message.model, &message.provider]
            .into_iter()
            .flatten()
            .cloned(),
    );
    for part in &message.parts {
        match part {
            MessagePart::Text { text, .. } => fields.extend(["text".into(), text.clone()]),
            MessagePart::Reasoning { text, .. } => {
                fields.extend(["reasoning".into(), text.clone()])
            }
            MessagePart::Plan { text, .. } => fields.extend(["plan".into(), text.clone()]),
            MessagePart::Tool {
                tool, title, state, ..
            } => {
                fields.extend(["tool".into(), tool.clone()]);
                fields.extend(title.iter().cloned());
                if let Some(input) = &state.input {
                    fields.push(input.to_string());
                }
                if let Some(output) = &state.output {
                    fields.push(output.to_string());
                }
            }
            MessagePart::Image { .. } => fields.push("image".into()),
        }
    }
    fields.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn source(root: &Path, id: &str) -> ParsedSession {
        let path = root.join(format!("rollout-{id}.jsonl"));
        std::fs::write(&path, concat!(
            "{\"timestamp\":\"2026-09-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/fixture\"}}\n",
            "{\"timestamp\":\"2026-09-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Fixture 中文 🔎\"}]}}\n"
        )).unwrap();
        let detail = crate::agents::codex::parse(
            &path,
            &HashMap::new(),
            &crate::pricing::Pricing::bundled(),
        )
        .unwrap()
        .unwrap();
        ParsedSession {
            source: path,
            detail,
        }
    }

    #[test]
    fn publication_rolls_back_without_exposing_cursors() {
        let root = tempfile::tempdir().unwrap();
        let mut sessions = vec![source(root.path(), "first"), source(root.path(), "second")];
        let mut cache = Cache::open(None).unwrap();
        cache.connection.execute_batch("CREATE TRIGGER reject_second BEFORE INSERT ON messages WHEN NEW.session_id = 'rollout-second' BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;").unwrap();
        assert!(cache.publish(&mut sessions).is_err());
        assert_eq!(
            cache.messages(&sessions[0].detail.head.reference).unwrap(),
            0
        );
        assert!(
            sessions
                .iter()
                .all(|session| session.detail.message_cursor.is_none())
        );
        cache
            .connection
            .execute_batch("DROP TRIGGER reject_second")
            .unwrap();
        cache.publish(&mut sessions).unwrap();
        assert_eq!(
            cache.messages(&sessions[0].detail.head.reference).unwrap(),
            1
        );
        assert!(
            sessions
                .iter()
                .all(|session| session.detail.message_cursor.is_some())
        );
    }

    #[test]
    fn schema_and_materialized_messages_survive_reopen() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cache.db");
        let mut sessions = vec![source(root.path(), "persisted")];
        let mut cache = Cache::open(Some(&path)).unwrap();
        cache.publish(&mut sessions).unwrap();
        drop(cache);
        let cache = Cache::open(Some(&path)).unwrap();
        assert_eq!(
            cache.messages(&sessions[0].detail.head.reference).unwrap(),
            1
        );
        let count: i64 = cache.connection.query_row("SELECT count(*) FROM session_documents_fts WHERE session_documents_fts MATCH 'Fixture'", [], |row|row.get(0)).unwrap();
        assert_eq!(count, 1);
        assert_eq!(
            cache
                .connection
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            34
        );
        cache.connection.execute("INSERT INTO session_file_activity VALUES('codex','rollout-persisted','/fixture','/fixture/中文.txt','read',1,1)",[]).unwrap();
        let count: i64 = cache.connection.query_row("SELECT count(*) FROM session_file_activity_path_fts WHERE session_file_activity_path_fts MATCH 'fixture'",[],|row|row.get(0)).unwrap();
        assert_eq!(count, 1);
    }
}
