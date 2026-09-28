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

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct QueueStatus {
    #[ts(type = "number")]
    pub batches: i64,
    #[ts(type = "number")]
    pub bytes: i64,
    #[ts(type = "number | null")]
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

    pub fn collection_complete(&self, agents: &[String]) -> Result<bool> {
        for agent in agents {
            let complete: bool = self.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM worker_sources WHERE agent=? AND complete=1)",
                [agent],
                |r| r.get(0),
            )?;
            if !complete {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub fn pause_reason(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT value FROM worker_meta WHERE key='pause_reason'",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn set_pause(&mut self, reason: Option<&str>) -> Result<()> {
        if let Some(reason) = reason {
            self.db.execute("INSERT INTO worker_meta VALUES('pause_reason',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[reason])?;
        } else {
            self.db
                .execute("DELETE FROM worker_meta WHERE key='pause_reason'", [])?;
        }
        Ok(())
    }

    pub fn recovery(&self) -> Result<Option<super::Recovery>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM worker_meta WHERE key='recovery'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    pub fn prepare_recovery(&mut self, epoch: &str) -> Result<super::Recovery> {
        if let Some(recovery) = self.recovery()? {
            ensure!(
                recovery.epoch == epoch,
                "Hub changed again during recovery; queue preserved"
            );
            return Ok(recovery);
        }
        let recovery = super::Recovery {
            epoch: epoch.into(),
            previous_stream: self.stream_id()?,
            new_stream: uuid::Uuid::new_v4().to_string(),
        };
        let tx = self.db.transaction()?;
        reset_queue(&tx, &recovery.new_stream)?;
        tx.execute("DELETE FROM worker_meta WHERE key='rescan'", [])?;
        tx.execute(
            "INSERT INTO worker_meta VALUES('recovery',?)",
            [serde_json::to_string(&recovery)?],
        )?;
        tx.commit()?;
        Ok(recovery)
    }

    pub fn finish_recovery(&mut self, origin: &str, grant: &super::PairingGrant) -> Result<()> {
        let recovery = self.recovery()?.context("No pending recovery")?;
        ensure!(recovery.epoch == grant.epoch, "Recovery epoch mismatch");
        let tx = self.db.transaction()?;
        tx.execute(
            "UPDATE worker_meta SET value=? WHERE key='binding'",
            [serde_json::to_string(&(origin, grant))?],
        )?;
        tx.execute("DELETE FROM worker_meta WHERE key='recovery'", [])?;
        tx.commit()?;
        Ok(())
    }

    pub fn rescan_progress(&self) -> Result<Option<super::RescanProgress>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM worker_meta WHERE key='rescan'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    pub fn begin_rescan(
        &mut self,
        request: &super::RescanRequest,
        enabled: &[String],
    ) -> Result<bool> {
        if self
            .rescan_progress()?
            .is_some_and(|progress| progress.id == request.id)
        {
            return Ok(false);
        }
        let agents = if request.agents.is_empty() {
            enabled.to_vec()
        } else {
            request.agents.clone()
        };
        let unavailable = agents.iter().find(|agent| {
            !enabled.contains(agent)
                || request
                    .required_revisions
                    .get(*agent)
                    .is_none_or(|revision| revision != crate::agents::parser_version(agent))
        });
        let progress = super::RescanProgress {
            id: request.id.clone(),
            pending_agents: agents.clone(),
            target_sequence: None,
            error: unavailable
                .map(|agent| format!("Agent {agent} is disabled or requires a Worker upgrade")),
        };
        let tx = self.db.transaction()?;
        if progress.error.is_none() {
            for agent in &agents {
                tx.execute("DELETE FROM worker_sources WHERE agent=?", [agent])?;
                tx.execute(
                    "UPDATE worker_sessions SET content_hash='',metadata_hash='' WHERE agent=?",
                    [agent],
                )?;
            }
        }
        tx.execute("INSERT INTO worker_meta VALUES('rescan',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&progress)?])?;
        tx.commit()?;
        Ok(progress.error.is_none())
    }

    pub fn history_choice(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT value FROM worker_meta WHERE key='history_choice'",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn finish_history_import(&mut self, choice: &str) -> Result<()> {
        ensure!(
            matches!(choice, "import" | "ignore"),
            "Invalid history choice"
        );
        self.db.execute("INSERT INTO worker_meta VALUES('history_choice',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[choice])?;
        Ok(())
    }

    pub fn binding(&self) -> Result<Option<(String, super::PairingGrant)>> {
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM worker_meta WHERE key='binding'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }

    pub fn bind(&mut self, origin: &str, grant: &super::PairingGrant) -> Result<()> {
        ensure!(
            self.binding()?.is_none(),
            "Worker is already paired; retain its queue and binding"
        );
        self.db.execute(
            "INSERT INTO worker_meta VALUES('binding',?)",
            [serde_json::to_string(&(origin, grant))?],
        )?;
        Ok(())
    }

    pub fn update_origin(&mut self, origin: &str) -> Result<()> {
        let (_, grant) = self.binding()?.context("Worker is not paired")?;
        self.db.execute(
            "UPDATE worker_meta SET value=? WHERE key='binding'",
            [serde_json::to_string(&(origin, grant))?],
        )?;
        Ok(())
    }

    pub fn rebind(&mut self, origin: &str, grant: &super::PairingGrant) -> Result<()> {
        let recovery = super::Recovery {
            epoch: grant.epoch.clone(),
            previous_stream: self.stream_id()?,
            new_stream: uuid::Uuid::new_v4().to_string(),
        };
        let tx = self.db.transaction()?;
        reset_queue(&tx, &recovery.new_stream)?;
        tx.execute(
            "DELETE FROM worker_meta WHERE key IN ('rescan','recovery','pause_reason')",
            [],
        )?;
        tx.execute(
            "INSERT INTO worker_meta VALUES('recovery',?)",
            [serde_json::to_string(&recovery)?],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO worker_meta VALUES('binding',?)",
            [serde_json::to_string(&(origin, grant))?],
        )?;
        tx.commit()?;
        Ok(())
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
            let metadata_bytes = serde_json::to_vec(&metadata)?;
            let metadata_hash = digest(&metadata_bytes);
            let previous: Option<(String,String)> = tx.query_row("SELECT content_hash,metadata_hash FROM worker_sessions WHERE agent=? AND session_id=?", params![agent,session.head.reference.session_id], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
            if previous
                .as_ref()
                .is_none_or(|(content, _)| *content != content_hash)
                || previous
                    .as_ref()
                    .is_some_and(|(_, hash)| *hash != metadata_hash)
                    && metadata_bytes.len() > CHUNK_BYTES
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
        let progress: Option<String> = tx
            .query_row(
                "SELECT value FROM worker_meta WHERE key='rescan'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(raw) = progress {
            let mut progress: super::RescanProgress = serde_json::from_str(&raw)?;
            if batch.complete && progress.error.is_none() && progress.target_sequence.is_none() {
                progress.pending_agents.retain(|pending| pending != agent);
                if progress.pending_agents.is_empty() {
                    progress.target_sequence = Some(tx.query_row("SELECT COALESCE((SELECT MAX(sequence) FROM worker_outbox),CAST((SELECT value FROM worker_meta WHERE key='confirmed_sequence') AS INTEGER))",[],|r|r.get(0))?);
                }
                tx.execute(
                    "UPDATE worker_meta SET value=? WHERE key='rescan'",
                    [serde_json::to_string(&progress)?],
                )?;
            }
        }
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

fn reset_queue(tx: &rusqlite::Transaction<'_>, stream: &str) -> Result<()> {
    tx.execute_batch("CREATE TEMP TABLE recovery_queue AS SELECT payload_version,payload,digest,created_at FROM worker_outbox ORDER BY sequence; DELETE FROM worker_outbox; DELETE FROM sqlite_sequence WHERE name='worker_outbox'; INSERT INTO worker_outbox(payload_version,payload,digest,created_at) SELECT payload_version,payload,digest,created_at FROM recovery_queue ORDER BY rowid; DROP TABLE recovery_queue;")?;
    tx.execute(
        "UPDATE worker_meta SET value=? WHERE key='stream_id'",
        [stream],
    )?;
    tx.execute(
        "UPDATE worker_meta SET value='0' WHERE key='confirmed_sequence'",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests;
