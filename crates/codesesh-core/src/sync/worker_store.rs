use super::{CapturedSession, Operation, PAYLOAD_VERSION};
use crate::{
    agents::{SessionRecord, dsh::AttachmentReferences},
    runtime::ScanBatch,
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, time::Duration};

const CHUNK_BYTES: usize = 256 * 1024;

pub struct WorkerStore {
    db: Connection,
}

pub struct PendingUpload {
    pub sequence: i64,
    pub payload_version: u32,
    pub operation: Operation,
    pub digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    pub batches: i64,
    pub bytes: i64,
    pub oldest_at: Option<i64>,
}

pub(crate) struct SourceBaseline {
    pub state: Option<Value>,
    pub complete: bool,
    pub sessions: Vec<SessionRecord>,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    crate::hash::hex(&Sha256::digest(bytes))
}

fn enqueue(tx: &Transaction<'_>, operation: &Operation) -> Result<()> {
    let payload = serde_json::to_vec(operation)?;
    tx.execute(
        "INSERT INTO worker_outbox(payload_version,payload,digest,created_at) VALUES(?,?,?,?)",
        params![
            PAYLOAD_VERSION,
            payload,
            digest(&payload),
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    ensure!(
        tx.last_insert_rowid() <= 9_007_199_254_740_991,
        "Upload sequence exhausted"
    );
    Ok(())
}

impl WorkerStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(false)
                .mode(0o600)
                .open(path)?;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        ensure!(
            (0..=1).contains(&version),
            "Unsupported Worker state schema {version}"
        );
        if version == 0 {
            let tx = db.unchecked_transaction()?;
            tx.execute_batch("CREATE TABLE worker_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                CREATE TABLE worker_sources(agent TEXT PRIMARY KEY,state TEXT,checkpoint TEXT,complete INTEGER NOT NULL);
                CREATE TABLE worker_sessions(agent TEXT NOT NULL,session_id TEXT NOT NULL,head TEXT NOT NULL,source TEXT NOT NULL,attachments TEXT NOT NULL,content_hash TEXT NOT NULL,metadata_hash TEXT NOT NULL,PRIMARY KEY(agent,session_id));
                CREATE TABLE worker_outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT,payload_version INTEGER NOT NULL,payload BLOB NOT NULL,digest TEXT NOT NULL,created_at INTEGER NOT NULL);
                PRAGMA user_version=1;")?;
            tx.execute(
                "INSERT INTO worker_meta VALUES('stream_id',?)",
                [uuid::Uuid::new_v4().to_string()],
            )?;
            tx.execute(
                "INSERT INTO worker_meta VALUES('confirmed_sequence','0')",
                [],
            )?;
            tx.commit()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for suffix in ["", "-wal", "-shm"] {
                let file = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
                if file.exists() {
                    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))?;
                }
            }
        }
        Ok(Self { db })
    }

    pub fn stream_id(&self) -> Result<String> {
        Ok(self.db.query_row(
            "SELECT value FROM worker_meta WHERE key='stream_id'",
            [],
            |r| r.get(0),
        )?)
    }

    pub fn confirmed_sequence(&self) -> Result<i64> {
        let value: String = self.db.query_row(
            "SELECT value FROM worker_meta WHERE key='confirmed_sequence'",
            [],
            |r| r.get(0),
        )?;
        Ok(value.parse()?)
    }

    pub fn checkpoint(&self, agent: &str) -> Result<Option<Value>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT checkpoint FROM worker_sources WHERE agent=?",
                [agent],
                |r| r.get(0),
            )
            .optional()?
            .flatten();
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    pub(crate) fn baseline(&self, agent: &str) -> Result<SourceBaseline> {
        let saved: Option<(Option<String>, bool)> = self
            .db
            .query_row(
                "SELECT state,complete FROM worker_sources WHERE agent=?",
                [agent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let (state, complete) = saved.unwrap_or_default();
        let mut query = self.db.prepare(
            "SELECT head,source,attachments FROM worker_sessions WHERE agent=? ORDER BY rowid",
        )?;
        let raw = query
            .query_map([agent], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let sessions = raw
            .into_iter()
            .map(|(head, source, attachments)| {
                Ok(SessionRecord {
                    head: serde_json::from_str(&head)?,
                    source: source.into(),
                    attachments: serde_json::from_str(&attachments)?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(SourceBaseline {
            state: state.map(|s| serde_json::from_str(&s)).transpose()?,
            complete,
            sessions,
        })
    }

    pub fn save_batch(&mut self, agent: &str, batch: &mut ScanBatch) -> Result<()> {
        let tx = self.db.transaction()?;
        for session in &batch.sessions {
            ensure!(
                session.head.reference.agent_name == agent,
                "Scan batch contains a different Agent"
            );
            let captured = CapturedSession::from_parsed(session.clone());
            let content_hash = digest(&serde_json::to_vec(&(
                &captured.detail.messages,
                &captured.detail.file_activity,
                &captured.message_cost_inputs,
            ))?);
            let metadata = Operation::Metadata {
                head: Box::new(captured.detail.head.clone()),
                cost_inputs: captured.head_cost_inputs.clone(),
                source_path: captured.source_path.clone(),
            };
            let metadata_hash = digest(&serde_json::to_vec(&metadata)?);
            let previous: Option<(String,String)> = tx.query_row("SELECT content_hash,metadata_hash FROM worker_sessions WHERE agent=? AND session_id=?", params![agent,session.head.reference.session_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if previous
                .as_ref()
                .is_none_or(|(content, _)| *content != content_hash)
            {
                let payload = serde_json::to_vec(&captured)?;
                let transfer_id = uuid::Uuid::new_v4().to_string();
                let chunks = u32::try_from(payload.len().div_ceil(CHUNK_BYTES))
                    .context("Session snapshot is too large")?;
                for (index, bytes) in payload.chunks(CHUNK_BYTES).enumerate() {
                    enqueue(
                        &tx,
                        &Operation::SnapshotChunk {
                            transfer_id: transfer_id.clone(),
                            index: index as u32,
                            data: STANDARD.encode(bytes),
                        },
                    )?;
                }
                enqueue(
                    &tx,
                    &Operation::SnapshotCommit {
                        transfer_id,
                        chunks,
                        bytes: payload.len() as u64,
                        digest: digest(&payload),
                    },
                )?;
            } else if previous.is_some_and(|(_, metadata)| metadata != metadata_hash) {
                enqueue(&tx, &metadata)?;
            }
            let attachments = AttachmentReferences::from_messages(&session.detail.messages);
            tx.execute("INSERT INTO worker_sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(agent,session_id) DO UPDATE SET head=excluded.head,source=excluded.source,attachments=excluded.attachments,content_hash=excluded.content_hash,metadata_hash=excluded.metadata_hash",
                params![agent,session.head.reference.session_id,serde_json::to_string(&session.head)?,captured.source_path,serde_json::to_string(&attachments)?,content_hash,metadata_hash])?;
        }
        let source_state = batch
            .checkpoint
            .as_ref()
            .and_then(|v| v.get("sourceState"))
            .map(serde_json::to_string)
            .transpose()?;
        let checkpoint = if batch.complete {
            None
        } else {
            batch
                .checkpoint
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?
        };
        tx.execute("INSERT INTO worker_sources VALUES(?,?,?,?) ON CONFLICT(agent) DO UPDATE SET state=COALESCE(excluded.state,worker_sources.state),checkpoint=excluded.checkpoint,complete=excluded.complete",
            params![agent,source_state,checkpoint,batch.complete])?;
        tx.commit()?;
        batch.on_reject.take();
        Ok(())
    }

    pub fn next_upload(&self) -> Result<Option<PendingUpload>> {
        let raw: Option<(i64,u32,Vec<u8>,String)> = self.db.query_row("SELECT sequence,payload_version,payload,digest FROM worker_outbox WHERE sequence>CAST((SELECT value FROM worker_meta WHERE key='confirmed_sequence') AS INTEGER) ORDER BY sequence LIMIT 1", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        raw.map(|(sequence,payload_version,payload,digest)| {
            ensure!(payload_version == PAYLOAD_VERSION, "Unsupported queued payload version {payload_version}; preserve the queue and upgrade Worker");
            ensure!(super::worker_store::digest(&payload) == digest, "Queued payload checksum mismatch; preserve the queue for recovery");
            Ok(PendingUpload { sequence,payload_version,operation:serde_json::from_slice(&payload)?,digest })
        }).transpose()
    }

    pub fn acknowledge(&mut self, stream_id: &str, sequence: i64, digest: &str) -> Result<()> {
        ensure!(
            self.stream_id()? == stream_id,
            "Confirmation belongs to another upload stream"
        );
        if sequence <= self.confirmed_sequence()? {
            return Ok(());
        }
        let next = self
            .next_upload()?
            .context("Confirmation has no pending upload")?;
        ensure!(
            next.sequence == sequence && next.digest == digest,
            "Confirmation does not match the pending upload"
        );
        let tx = self.db.transaction()?;
        if !matches!(next.operation, Operation::SnapshotChunk { .. }) {
            tx.execute("DELETE FROM worker_outbox WHERE sequence<=?", [sequence])?;
        }
        tx.execute(
            "UPDATE worker_meta SET value=? WHERE key='confirmed_sequence'",
            [sequence.to_string()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn queue_status(&self) -> Result<QueueStatus> {
        Ok(self.db.query_row(
            "SELECT COUNT(*),COALESCE(SUM(length(payload)),0),MIN(created_at) FROM worker_outbox WHERE sequence>CAST((SELECT value FROM worker_meta WHERE key='confirmed_sequence') AS INTEGER)",
            [],
            |r| {
                Ok(QueueStatus {
                    batches: r.get(0)?,
                    bytes: r.get(1)?,
                    oldest_at: r.get(2)?,
                })
            },
        )?)
    }
}

#[cfg(test)]
mod tests;
