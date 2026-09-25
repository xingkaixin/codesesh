use anyhow::{Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use std::{collections::HashSet, path::Path};

fn exists(db: &Connection, name: &str) -> Result<bool> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
fn columns(db: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut query = db.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    Ok(query
        .query_map([], |row| row.get(1))?
        .collect::<rusqlite::Result<_>>()?)
}
fn migrate(db: &Connection, version: i64) -> Result<()> {
    let tables = [
        "cache_meta",
        "agent_cache",
        "cache_initialization",
        "pending_reindex",
        "sessions",
        "messages",
        "session_model_cost",
        "session_cost_summary",
        "message_tools",
        "session_file_activity",
        "session_documents",
    ];
    ensure!(
        exists(db, "sessions")? || exists(db, "cached_sessions")?,
        "Unrecognized cache schema {version}"
    );
    db.execute_batch("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;")?;
    let result = (|| -> Result<()> {
        let mut query=db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('view','trigger','index') AND sql IS NOT NULL")?;
        let objects = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        for (kind, name) in objects {
            db.execute_batch(&format!("DROP {} \"{}\"", kind, name.replace('"', "\"\"")))?;
        }
        let mut query=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'")?;
        let virtuals = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        for name in virtuals {
            db.execute_batch(&format!("DROP TABLE \"{}\"", name.replace('"', "\"\"")))?;
        }
        let mut saved = Vec::new();
        for table in tables {
            if exists(db, table)? {
                db.execute_batch(&format!("ALTER TABLE {table} RENAME TO migration_{table}"))?;
                saved.push(table);
            }
        }
        db.execute_batch(include_str!("schema.sql"))?;
        if !saved.contains(&"sessions") && exists(db, "cached_sessions")? {
            restore_legacy_heads(db)?;
        }
        for table in &saved {
            let old = columns(db, &format!("migration_{table}"))?;
            let new = columns(db, table)?;
            let mut common: Vec<_> = old.intersection(&new).cloned().collect();
            common.sort();
            let mut expressions = common
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>();
            if *table == "session_documents" && !old.contains("indexed_message_count") {
                common.push("indexed_message_count".into());
                expressions.push("0".into());
            }
            let names = common
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>()
                .join(",");
            db.execute_batch(&format!(
                "INSERT INTO {table}({names}) SELECT {} FROM migration_{table}",
                expressions.join(",")
            ))?;
        }
        for table in saved.iter().rev() {
            db.execute_batch(&format!("DROP TABLE migration_{table}"))?;
        }
        db.execute_batch("DROP TABLE IF EXISTS cached_sessions; DROP TABLE IF EXISTS project_sessions; DROP TABLE IF EXISTS search_index_publication_entries;")?;
        if version < 22 {
            db.execute_batch("INSERT OR IGNORE INTO pending_reindex SELECT agent_name,session_id FROM sessions; UPDATE session_documents SET content_hash='';")?;
        }
        if version < 14 {
            db.execute_batch("UPDATE session_documents SET indexed_message_count=(SELECT COUNT(*) FROM messages WHERE messages.agent_name=session_documents.agent_name AND messages.session_id=session_documents.session_id)")?;
        }
        db.execute_batch("DELETE FROM session_model_cost; DELETE FROM session_cost_summary; INSERT INTO session_model_cost SELECT agent_name,session_id,model,SUM(COALESCE(cost,0)),SUM(CASE WHEN cost_source='recorded' THEN COALESCE(cost,0) ELSE 0 END) FROM messages WHERE model IS NOT NULL AND model<>'' GROUP BY agent_name,session_id,model;")?;
        let mut query = db.prepare("SELECT agent_name,session_id FROM sessions")?;
        let references = query
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(query);
        for (agent, id) in references {
            db.execute(include_str!("cost-summary.sql"), params![agent, id])?;
        }
        if version < 12 {
            backfill_legacy_projections(db, version)?;
        }
        let violations: i64 =
            db.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })?;
        ensure!(
            violations == 0,
            "Migrated cache has {violations} foreign-key violations"
        );
        db.pragma_update(None, "user_version", super::CACHE_SCHEMA_VERSION)?;
        db.execute(
            "INSERT OR REPLACE INTO cache_meta VALUES('version','34')",
            [],
        )?;
        db.execute_batch("COMMIT")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK");
    }
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    result
}

pub fn ensure(db: &Connection, path: Option<&Path>) -> Result<()> {
    let mut version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if version == 0 && exists(db, "cache_meta")? {
        version = db
            .query_row(
                "SELECT value FROM cache_meta WHERE key='version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|v| v.parse().ok())
            .unwrap_or_default();
    }
    if version > super::CACHE_SCHEMA_VERSION {
        bail!("Unsupported future cache schema {version}");
    }
    if version == 0 && !exists(db, "sessions")? && !exists(db, "cached_sessions")? {
        db.execute_batch("BEGIN IMMEDIATE")?;
        if let Err(error) = db.execute_batch(include_str!("schema.sql")) {
            let _ = db.execute_batch("ROLLBACK");
            return Err(error.into());
        }
        db.pragma_update(None, "user_version", super::CACHE_SCHEMA_VERSION)?;
        db.execute("INSERT INTO cache_meta VALUES('version','34')", [])?;
        db.execute_batch("COMMIT")?;
    } else if version < super::CACHE_SCHEMA_VERSION {
        if let Some(path) = path {
            let backup = path.with_extension(format!(
                "cache-migration-{version}-{}.db",
                chrono::Utc::now().timestamp_millis()
            ));
            db.execute("VACUUM INTO ?", [backup.to_string_lossy().as_ref()])?;
        }
        migrate(db, version)?;
    }
    let documents_missing = !exists(db, "session_documents_fts")?;
    let paths_missing = !exists(db, "session_file_activity_path_fts")?;
    if documents_missing || paths_missing {
        let schema = include_str!("schema.sql")
            .replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
            .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS ")
            .replace(
                "CREATE VIRTUAL TABLE ",
                "CREATE VIRTUAL TABLE IF NOT EXISTS ",
            )
            .replace("CREATE TRIGGER ", "CREATE TRIGGER IF NOT EXISTS ")
            .replace("CREATE VIEW ", "CREATE VIEW IF NOT EXISTS ");
        db.execute_batch("BEGIN IMMEDIATE")?;
        let repaired = (|| -> Result<()> {
            db.execute_batch(&schema)?;
            if documents_missing {
                db.execute(
                    "INSERT INTO session_documents_fts(session_documents_fts) VALUES('rebuild')",
                    [],
                )?;
            }
            if paths_missing {
                db.execute("INSERT INTO session_file_activity_path_fts(session_file_activity_path_fts) VALUES('rebuild')",[])?;
            }
            db.execute_batch("COMMIT")?;
            Ok(())
        })();
        if repaired.is_err() {
            let _ = db.execute_batch("ROLLBACK");
        }
        repaired?;
    }
    db.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> Result<()> {
        for (key, sql) in [
            (
                "pi_automated_messages_v1",
                "INSERT OR IGNORE INTO pending_reindex SELECT agent_name,session_id FROM sessions WHERE agent_name='pi'",
            ),
            (
                "codex_exec_decode_migrated_v3",
                "INSERT OR IGNORE INTO pending_reindex SELECT agent_name,session_id FROM sessions WHERE agent_name='codex'",
            ),
            (
                "opencode_subagent_fold_v1",
                "DELETE FROM agent_cache WHERE agent_name IN ('zcode','opencode')",
            ),
            (
                "subagent_tree_v1",
                "DELETE FROM agent_cache WHERE agent_name IN ('codex','zcode','opencode')",
            ),
        ] {
            let present = db
                .query_row("SELECT 1 FROM cache_meta WHERE key=?", [key], |_| Ok(()))
                .optional()?
                .is_some();
            if !present {
                db.execute_batch(sql)?;
                db.execute("INSERT INTO cache_meta VALUES(?,'1')", [key])?;
            }
        }
        db.execute("INSERT INTO cache_meta VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value",params![super::CACHE_SCHEMA_VERSION.to_string()])?;
        db.execute_batch("COMMIT")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = db.execute_batch("ROLLBACK");
    }
    result
}

fn restore_legacy_heads(db: &Connection) -> Result<()> {
    let mut query=db.prepare("SELECT agent_name,session_id,session_json,meta_json,rowid FROM cached_sessions ORDER BY rowid")?;
    let rows = query
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (agent, id, text, meta, order) in rows {
        let value: serde_json::Value = serde_json::from_str(&text)?;
        let directory = value["directory"].as_str().unwrap_or("");
        let identity = crate::projects::compute_identity(directory);
        let created = value["time_created"].as_f64().unwrap_or(0.0);
        let updated = value["time_updated"].as_f64().unwrap_or(created);
        let stats = &value["stats"];
        db.execute("INSERT INTO sessions(agent_name,session_id,sort_index,title,source_path,directory,project_identity_kind,project_identity_key,project_display_name,time_created,time_updated,activity_time,message_count,total_input_tokens,total_output_tokens,total_cost,meta_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",params![agent,id,order,value["title"].as_str().unwrap_or(""),meta.as_ref().and_then(|text|serde_json::from_str::<serde_json::Value>(text).ok()).and_then(|value|value["sourcePath"].as_str().map(str::to_owned)),directory,identity.kind,identity.key,identity.display_name,created,updated,updated,stats["message_count"].as_i64().unwrap_or(0),stats["total_input_tokens"].as_f64().unwrap_or(0.0),stats["total_output_tokens"].as_f64().unwrap_or(0.0),stats["total_cost"].as_f64().unwrap_or(0.0),meta])?;
        db.execute("UPDATE sessions SET parent_agent_name=?,parent_session_id=?,total_cache_read_tokens=?,total_cache_create_tokens=?,cost_source=?,total_tokens=?,model_usage_json=?,smart_tags_json=?,smart_tags_source_updated_at=?,smart_tags_classifier_revision=? WHERE agent_name=? AND session_id=?",params![value["parent_reference"]["agentName"].as_str(),value["parent_reference"]["sessionId"].as_str(),stats["total_cache_read_tokens"].as_f64(),stats["total_cache_create_tokens"].as_f64(),stats["cost_source"].as_str(),stats["total_tokens"].as_f64(),value.get("model_usage").filter(|v|!v.is_null()).map(super::json::stringify).transpose()?,value.get("smart_tags").filter(|v|!v.is_null()).map(super::json::stringify).transpose()?,value["smart_tags_source_updated_at"].as_f64(),value["smart_tags_classifier_revision"].as_str(),agent,id])?;
    }
    Ok(())
}

fn backfill_legacy_projections(db: &Connection, version: i64) -> Result<()> {
    for mut head in super::snapshot::load(db)? {
        let identity = crate::projects::compute_identity(&head.directory);
        head.project_identity = identity;
        let reference = &head.reference;
        db.execute("UPDATE sessions SET project_identity_kind=?,project_identity_key=?,project_display_name=? WHERE agent_name=? AND session_id=?",params![head.project_identity.kind,head.project_identity.key,head.project_identity.display_name,reference.agent_name,reference.session_id])?;
        db.execute("UPDATE session_file_activity SET project_identity_key=? WHERE agent_name=? AND session_id=?",params![head.project_identity.key,reference.agent_name,reference.session_id])?;
        if version >= 11 {
            continue;
        }
        let Some(detail) = super::read::detail(db, head.clone())? else {
            continue;
        };
        let mut query=db.prepare("SELECT message_index,tool_metadata_json FROM messages WHERE agent_name=? AND session_id=? AND tool_metadata_json IS NOT NULL")?;
        let rows = query
            .query_map(params![reference.agent_name, reference.session_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (index, text) in rows {
            if let Ok(serde_json::Value::Array(tools)) = serde_json::from_str(&text) {
                for tool in tools {
                    if let Some(tool) = tool["tool"]
                        .as_str()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                    {
                        db.execute(
                            "INSERT OR IGNORE INTO message_tools VALUES(?,?,?,?)",
                            params![
                                reference.agent_name,
                                reference.session_id,
                                index,
                                tool.to_lowercase()
                            ],
                        )?;
                    }
                }
            }
        }
        if version < 8 {
            let mut parsed = crate::agents::ParsedSession {
                head: head.clone(),
                detail,
                source: std::path::PathBuf::new(),
            };
            crate::agents::complete_projections(&mut parsed);
            db.execute(
                "DELETE FROM session_file_activity WHERE agent_name=? AND session_id=?",
                params![reference.agent_name, reference.session_id],
            )?;
            for activity in parsed.detail.file_activity {
                db.execute(
                    "INSERT INTO session_file_activity VALUES(?,?,?,?,?,?,?)",
                    params![
                        reference.agent_name,
                        reference.session_id,
                        head.project_identity.key,
                        activity.path,
                        activity.kind,
                        activity.count as i64,
                        activity.latest_time
                    ],
                )?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upgrades_schema33_and_queues_existing_content_once() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(include_str!("schema.sql")).unwrap();
        db.execute_batch("DROP INDEX idx_messages_user_activity; ALTER TABLE messages DROP COLUMN automated; PRAGMA user_version=33;").unwrap();
        ensure(&db, None).unwrap();
        assert!(columns(&db, "messages").unwrap().contains("automated"));
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            34
        );
        ensure(&db, None).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM cache_meta WHERE key='codex_exec_decode_migrated_v3'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
    #[test]
    fn migrates_legacy_json_heads_without_losing_metadata() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE cache_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO cache_meta VALUES('version','3'); CREATE TABLE cached_sessions(agent_name TEXT,session_id TEXT,session_json TEXT,meta_json TEXT);").unwrap();
        db.execute("INSERT INTO cached_sessions VALUES('codex','legacy',?,?)",params![r#"{"title":"历史记录","directory":"/project","time_created":12,"stats":{"message_count":5,"total_input_tokens":8,"total_output_tokens":3,"total_cost":0.2}}"#,r#"{"sourcePath":"/source.jsonl"}"#]).unwrap();
        ensure(&db, None).unwrap();
        let heads = super::super::snapshot::load(&db).unwrap();
        assert_eq!(heads[0].title, "历史记录");
        assert_eq!(heads[0].stats.message_count, 5);
        assert_eq!(
            db.query_row("SELECT source_path FROM sessions", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "/source.jsonl"
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM pending_reindex", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn rejects_future_schema_without_writing() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA user_version=35").unwrap();
        assert!(ensure(&db, None).is_err());
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn failed_legacy_migration_preserves_rows_and_creates_backup() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("cache.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=3; CREATE TABLE cache_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO cache_meta VALUES('version','3'); CREATE TABLE cached_sessions(agent_name TEXT,session_id TEXT,session_json TEXT,meta_json TEXT); INSERT INTO cached_sessions VALUES('codex','broken','not json',NULL)").unwrap();
        assert!(ensure(&db, Some(&path)).is_err());
        assert_eq!(
            db.query_row("SELECT session_json FROM cached_sessions", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "not json"
        );
        assert_eq!(
            db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert!(
            std::fs::read_dir(root.path())
                .unwrap()
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .contains("cache-migration-3-"))
        );
    }
}
