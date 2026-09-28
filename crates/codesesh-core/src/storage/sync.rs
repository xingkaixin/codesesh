use super::Cache;
use crate::{
    contract::{SessionHead, SessionReference},
    pricing::Pricing,
    sync::{
        CapturedSession, Node, Operation, PAYLOAD_VERSION, PairingGrant, Receipt, Upload,
        worker_store::digest,
    },
};
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::{OptionalExtension, Transaction, params};

fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn namespace(head: &mut SessionHead, node: &str) -> Result<()> {
    ensure!(
        head.reference.source_node_id == crate::contract::LOCAL_SOURCE_NODE_ID,
        "Worker must submit its own local session identity"
    );
    ensure!(
        crate::agents::catalog(0)
            .iter()
            .any(|agent| agent.name == head.reference.agent_name),
        "Unknown Agent"
    );
    head.reference.source_node_id = node.into();
    if let Some(parent) = &mut head.parent_reference {
        ensure!(
            parent.source_node_id == crate::contract::LOCAL_SOURCE_NODE_ID,
            "Parent belongs to a different source"
        );
        parent.source_node_id = node.into();
    }
    head.project_identity.key = format!("@{node}/{}", head.project_identity.key);
    head.display_title = None;
    Ok(())
}

impl Cache {
    pub fn initialize_hub(&mut self, hub_id: &str) -> Result<String> {
        let tx = self.connection.transaction()?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS hub_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_pairing(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS hub_nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,version TEXT NOT NULL,credential_hash TEXT NOT NULL UNIQUE,stream_id TEXT NOT NULL,confirmed_sequence INTEGER NOT NULL DEFAULT 0,confirmed_digest TEXT,confirmed_reference TEXT,paired_at INTEGER NOT NULL,last_seen INTEGER,revoked INTEGER NOT NULL DEFAULT 0,queue TEXT,error TEXT);
            CREATE TABLE IF NOT EXISTS hub_chunks(node_id TEXT NOT NULL REFERENCES hub_nodes(id),stream_id TEXT NOT NULL,transfer_id TEXT NOT NULL,chunk_index INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(node_id,stream_id,transfer_id,chunk_index));")?;
        tx.execute(
            "INSERT OR IGNORE INTO hub_meta VALUES('hub_id',?)",
            [hub_id],
        )?;
        let existing: String =
            tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
                r.get(0)
            })?;
        ensure!(
            existing == hub_id,
            "Hub database belongs to a different installation"
        );
        tx.execute(
            "INSERT OR IGNORE INTO hub_meta VALUES('epoch',?)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        let epoch = tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
            r.get(0)
        })?;
        tx.commit()?;
        Ok(epoch)
    }

    pub fn create_pairing_token(&mut self) -> Result<String> {
        let token = secret();
        let now = chrono::Utc::now().timestamp_millis();
        let tx = self.connection.transaction()?;
        tx.execute("DELETE FROM hub_pairing WHERE expires_at<=?", [now])?;
        tx.execute(
            "INSERT INTO hub_pairing VALUES(?,?)",
            params![digest(token.as_bytes()), now + 10 * 60 * 1000],
        )?;
        tx.commit()?;
        Ok(token)
    }

    pub fn pair_worker(
        &mut self,
        token: &str,
        name: &str,
        version: &str,
        stream_id: &str,
    ) -> Result<PairingGrant> {
        ensure!(
            !name.trim().is_empty() && name.len() <= 128,
            "Invalid node name"
        );
        uuid::Uuid::parse_str(stream_id).context("Invalid upload stream")?;
        let tx = self.connection.transaction()?;
        let used = tx.execute(
            "DELETE FROM hub_pairing WHERE token_hash=? AND expires_at>?",
            params![
                digest(token.as_bytes()),
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        ensure!(
            used == 1,
            "Pairing token is invalid, expired, or already used"
        );
        let node_id = uuid::Uuid::new_v4().to_string();
        let credential = secret();
        tx.execute("INSERT INTO hub_nodes(id,name,version,credential_hash,stream_id,paired_at) VALUES(?,?,?,?,?,?)", params![node_id,name,version,digest(credential.as_bytes()),stream_id,chrono::Utc::now().timestamp_millis()])?;
        let hub_id = tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
            r.get(0)
        })?;
        let epoch = tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
            r.get(0)
        })?;
        tx.commit()?;
        Ok(PairingGrant {
            node_id,
            credential,
            hub_id,
            epoch,
        })
    }

    pub fn authenticate_worker(&self, credential: &str) -> Result<String> {
        self.connection
            .query_row(
                "SELECT id FROM hub_nodes WHERE credential_hash=? AND revoked=0",
                [digest(credential.as_bytes())],
                |r| r.get(0),
            )
            .optional()?
            .context("Worker credential is invalid or revoked")
    }

    pub fn revoke_worker(&mut self, node: &str) -> Result<()> {
        ensure!(
            self.connection
                .execute("UPDATE hub_nodes SET revoked=1 WHERE id=?", [node])?
                == 1,
            "Unknown node"
        );
        Ok(())
    }

    pub fn nodes(&self) -> Result<Vec<Node>> {
        let mut query=self.connection.prepare("SELECT id,name,version,paired_at,last_seen,revoked,queue,error FROM hub_nodes ORDER BY paired_at,id")?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    Node {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        version: r.get(2)?,
                        paired_at: r.get(3)?,
                        last_seen: r.get(4)?,
                        revoked: r.get(5)?,
                        queue: None,
                        error: r.get(7)?,
                    },
                    r.get::<_, Option<String>>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(mut node, queue)| {
                node.queue = queue.map(|raw| serde_json::from_str(&raw)).transpose()?;
                Ok(node)
            })
            .collect()
    }

    pub fn worker_hello(
        &mut self,
        node: &str,
        hello: &crate::sync::WorkerHello,
        minimum: &str,
    ) -> Result<crate::sync::HubHello> {
        let tx = self.connection.transaction()?;
        let (stream, confirmed_sequence): (String, i64) = tx
            .query_row(
                "SELECT stream_id,confirmed_sequence FROM hub_nodes WHERE id=? AND revoked=0",
                [node],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .context("Worker is unknown or revoked")?;
        ensure!(stream == hello.stream_id, "UPLOAD_STREAM_MISMATCH");
        ensure!(
            hello.queue.batches >= 0 && hello.queue.bytes >= 0,
            "Invalid queue status"
        );
        let version = env!("CARGO_PKG_VERSION");
        let error = crate::sync::check_compatibility(
            &hello.version,
            version,
            minimum,
            hello.protocol_version,
            hello.payload_version,
        )
        .err();
        tx.execute(
            "UPDATE hub_nodes SET version=?,last_seen=?,queue=?,error=? WHERE id=?",
            params![
                hello.version,
                chrono::Utc::now().timestamp_millis(),
                serde_json::to_string(&hello.queue)?,
                error
                    .map(|value| serde_json::to_string(&value))
                    .transpose()?,
                node
            ],
        )?;
        let result = crate::sync::HubHello {
            hub_id: tx.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
                r.get(0)
            })?,
            epoch: tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
                r.get(0)
            })?,
            version: version.into(),
            minimum_worker_version: minimum.into(),
            protocol_version: crate::sync::PROTOCOL_VERSION,
            payload_version: crate::sync::PAYLOAD_VERSION,
            error,
            confirmed_sequence,
            heartbeat_seconds: 15,
            max_in_flight: 1,
        };
        tx.commit()?;
        Ok(result)
    }

    pub fn receive_upload(
        &mut self,
        node: &str,
        upload: &Upload,
        pricing: &Pricing,
    ) -> Result<Receipt> {
        ensure!(
            upload.payload_version == PAYLOAD_VERSION,
            "PAYLOAD_UNSUPPORTED"
        );
        ensure!(
            upload.sequence > 0 && upload.sequence <= 9_007_199_254_740_991,
            "Invalid sequence"
        );
        ensure!(
            digest(&serde_json::to_vec(&upload.operation)?) == upload.digest,
            "Payload checksum mismatch"
        );
        let tx = self.connection.transaction()?;
        let epoch: String =
            tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
                r.get(0)
            })?;
        ensure!(epoch == upload.epoch, "HUB_EPOCH_CHANGED");
        let (stream,confirmed,last_digest,last_reference): (String,i64,Option<String>,Option<String>)=tx.query_row("SELECT stream_id,confirmed_sequence,confirmed_digest,confirmed_reference FROM hub_nodes WHERE id=? AND revoked=0", [node], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.context("Worker is unknown or revoked")?;
        ensure!(stream == upload.stream_id, "UPLOAD_STREAM_MISMATCH");
        let mut receipt = Receipt {
            epoch,
            stream_id: stream,
            sequence: upload.sequence,
            digest: upload.digest.clone(),
            changed: None,
        };
        if upload.sequence == confirmed {
            ensure!(
                last_digest.as_ref() == Some(&upload.digest),
                "SEQUENCE_CONFLICT"
            );
            receipt.changed = last_reference
                .map(|raw| serde_json::from_str(&raw))
                .transpose()?;
            return Ok(receipt);
        }
        ensure!(upload.sequence == confirmed + 1, "UPLOAD_SEQUENCE_GAP");
        receipt.changed =
            apply_operation(&tx, node, &upload.stream_id, &upload.operation, pricing)?;
        tx.execute(
            "UPDATE hub_nodes SET confirmed_sequence=?,confirmed_digest=?,confirmed_reference=?,last_seen=? WHERE id=?",
            params![
                upload.sequence,
                upload.digest,
                receipt.changed.as_ref().map(serde_json::to_string).transpose()?,
                chrono::Utc::now().timestamp_millis(),
                node
            ],
        )?;
        tx.commit()?;
        Ok(receipt)
    }
}

fn apply_operation(
    tx: &Transaction<'_>,
    node: &str,
    stream: &str,
    operation: &Operation,
    pricing: &Pricing,
) -> Result<Option<SessionReference>> {
    match operation {
        Operation::SnapshotChunk {
            transfer_id,
            index,
            data,
        } => {
            uuid::Uuid::parse_str(transfer_id).context("Invalid transfer ID")?;
            ensure!(
                data.len() <= 350_000,
                "Snapshot chunk exceeds transport limit"
            );
            let bytes = STANDARD.decode(data)?;
            let expected: i64 = tx.query_row(
                "SELECT COUNT(*) FROM hub_chunks WHERE node_id=? AND stream_id=? AND transfer_id=?",
                params![node, stream, transfer_id],
                |r| r.get(0),
            )?;
            ensure!(i64::from(*index) == expected, "SNAPSHOT_CHUNK_GAP");
            tx.execute(
                "INSERT INTO hub_chunks VALUES(?,?,?,?,?)",
                params![node, stream, transfer_id, index, bytes],
            )?;
            Ok(None)
        }
        Operation::SnapshotCommit {
            transfer_id,
            chunks,
            bytes,
            digest: expected,
        } => {
            let mut query=tx.prepare("SELECT data FROM hub_chunks WHERE node_id=? AND stream_id=? AND transfer_id=? ORDER BY chunk_index")?;
            let parts = query
                .query_map(params![node, stream, transfer_id], |r| {
                    r.get::<_, Vec<u8>>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            ensure!(
                !parts.is_empty() && parts.len() == *chunks as usize,
                "SNAPSHOT_INCOMPLETE"
            );
            let payload = parts.concat();
            ensure!(
                payload.len() as u64 == *bytes && digest(&payload) == *expected,
                "SNAPSHOT_CHECKSUM_MISMATCH"
            );
            let mut session = serde_json::from_slice::<CapturedSession>(&payload)?.into_parsed()?;
            namespace(&mut session.head, node)?;
            session.detail.head = session.head.clone();
            for activity in &mut session.detail.file_activity {
                activity.project_identity_key = session.head.project_identity.key.clone();
                activity.reference = session.head.reference.clone();
            }
            super::reprice::reprice_session(&mut session, pricing);
            let reference = session.head.reference.clone();
            Cache::write_sessions(tx, &[session], &[], None, None)?;
            tx.execute(
                "DELETE FROM hub_chunks WHERE node_id=? AND stream_id=? AND transfer_id=?",
                params![node, stream, transfer_id],
            )?;
            Ok(Some(reference))
        }
        Operation::Metadata {
            head,
            cost_inputs,
            source_path,
        } => {
            let mut head = head.as_ref().clone();
            namespace(&mut head, node)?;
            let previous =
                super::head_from_connection(tx, &head.reference)?.context("SNAPSHOT_REQUIRED")?;
            ensure!(
                head.stats.message_count == previous.stats.message_count,
                "SNAPSHOT_REQUIRED"
            );
            head.stats.cost_inputs = cost_inputs.clone();
            update_metadata(tx, &mut head, source_path, pricing)?;
            let reference = head.reference;
            Ok(Some(reference))
        }
    }
}

fn update_metadata(
    tx: &Transaction<'_>,
    head: &mut SessionHead,
    source: &str,
    pricing: &Pricing,
) -> Result<()> {
    let mut metadata: serde_json::Value = {
        let raw: String = tx.query_row("SELECT meta_json FROM sessions WHERE source_node_id=? AND agent_name=? AND session_id=?", params![head.reference.source_node_id, head.reference.agent_name, head.reference.session_id], |r|r.get(0))?;
        serde_json::from_str(&raw)?
    };
    super::reprice::reprice_head(head, pricing, &mut metadata["rustPricing"])?;
    metadata["sourcePath"] = source.into();
    let reference = &head.reference;
    let head_metadata = serde_json::json!({"rustHeadVersion":head.version,"rustHeadSummaryFiles":head.summary_files});
    tx.execute("UPDATE sessions SET title=?,source_path=?,directory=?,project_identity_kind=?,project_identity_key=?,project_display_name=?,project_identity_resolver_revision=?,project_identity_input_signature=?,time_created=?,time_updated=?,activity_time=?,parent_agent_name=?,parent_session_id=?,total_input_tokens=?,total_output_tokens=?,total_cache_read_tokens=?,total_cache_create_tokens=?,total_tokens=?,total_cost=?,cost_source=?,model_usage_json=?,smart_tags_json=?,smart_tags_source_updated_at=?,smart_tags_classifier_revision=?,meta_json=?,head_meta_json=? WHERE source_node_id=? AND agent_name=? AND session_id=?",
        params![head.title,source,head.directory,head.project_identity.kind,head.project_identity.key,head.project_identity.display_name,head.project_identity_resolver_revision,head.project_identity_input_signature,head.time_created,head.time_updated,head.time_updated,head.parent_reference.as_ref().map(|p|&p.agent_name),head.parent_reference.as_ref().map(|p|&p.session_id),head.stats.total_input_tokens,head.stats.total_output_tokens,head.stats.total_cache_read_tokens,head.stats.total_cache_create_tokens,head.stats.total_tokens,head.stats.total_cost,head.stats.cost_source.as_ref().map(|v|v.as_str()),head.model_usage.as_ref().map(serde_json::to_string).transpose()?,serde_json::to_string(&head.smart_tags)?,head.smart_tags_source_updated_at,head.smart_tags_classifier_revision,serde_json::to_string(&metadata)?,serde_json::to_string(&head_metadata)?,reference.source_node_id,reference.agent_name,reference.session_id])?;
    tx.execute("UPDATE session_documents SET title=?,content_hash=? WHERE source_node_id=? AND agent_name=? AND session_id=?",params![head.title,super::facts::content_hash(head)?,reference.source_node_id,reference.agent_name,reference.session_id])?;
    tx.execute("UPDATE session_file_activity SET project_identity_key=? WHERE source_node_id=? AND agent_name=? AND session_id=?",params![head.project_identity.key,reference.source_node_id,reference.agent_name,reference.session_id])?;
    for table in ["session_model_cost", "session_cost_summary"] {
        tx.execute(
            &format!(
                "DELETE FROM {table} WHERE source_node_id=? AND agent_name=? AND session_id=?"
            ),
            params![
                reference.source_node_id,
                reference.agent_name,
                reference.session_id
            ],
        )?;
    }
    super::facts::write(tx, reference, &[])?;
    tx.execute("INSERT INTO cache_meta VALUES('analytics_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(())
}

#[cfg(test)]
mod tests;
