use super::*;

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
    if node != crate::contract::LOCAL_SOURCE_NODE_ID {
        head.project_identity.key = format!("@{node}/{}", head.project_identity.key);
    }
    head.display_title = None;
    Ok(())
}

impl Cache {
    pub fn capture_session(&self, reference: &SessionReference) -> Result<Option<CapturedSession>> {
        let Some(head) = self.head(reference)? else {
            return Ok(None);
        };
        let Some(detail) = self.detail(head.clone())? else {
            return Ok(None);
        };
        let raw: String = self.connection.query_row("SELECT meta_json FROM sessions WHERE source_node_id=? AND agent_name=? AND session_id=?",params![reference.source_node_id,reference.agent_name,reference.session_id],|r|r.get(0))?;
        let metadata: serde_json::Value = serde_json::from_str(&raw)?;
        let source = metadata["sourcePath"]
            .as_str()
            .context("Stored session is missing its source path")?
            .into();
        let mut session = crate::agents::ParsedSession {
            head,
            detail,
            source,
        };
        crate::storage::reprice::restore_inputs(&mut session, &metadata["rustPricing"])?;
        Ok(Some(CapturedSession::from_parsed(session)))
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
        let (stream,confirmed,last_digest,last_reference): (String,i64,Option<String>,Option<String>)=tx.query_row("SELECT stream_id,confirmed_sequence,confirmed_digest,confirmed_reference FROM hub_nodes WHERE id=? AND revoked=0 AND id IN (SELECT id FROM hub_control.nodes WHERE revoked=0)", [node], |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.context("Worker is unknown or revoked")?;
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
            "UPDATE hub_nodes SET confirmed_sequence=?,confirmed_digest=?,confirmed_reference=?,last_seen=?4,last_confirmed_at=?4 WHERE id=?5",
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
            crate::storage::reprice::reprice_session(&mut session, pricing);
            let reference = session.head.reference.clone();
            Cache::write_sessions(tx, &[session], &[], None, None)?;
            tx.execute(
                "DELETE FROM hub_orphans WHERE node_id=? AND agent=? AND session_id=?",
                params![node, reference.agent_name, reference.session_id],
            )?;
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
            if crate::storage::head_from_connection(tx, &head.reference)?.is_none() {
                let recovering: bool = tx.query_row(
                    "SELECT recovery_epoch IS NOT NULL FROM hub_nodes WHERE id=?",
                    [node],
                    |r| r.get(0),
                )?;
                ensure!(recovering, "SNAPSHOT_REQUIRED");
                tx.execute("INSERT INTO hub_orphans VALUES(?,?,?,?) ON CONFLICT(node_id,agent,session_id) DO UPDATE SET payload=excluded.payload",params![node,head.reference.agent_name,head.reference.session_id,serde_json::to_string(operation)?])?;
                return Ok(None);
            }
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
    crate::storage::reprice::reprice_head(head, pricing, &mut metadata["rustPricing"])?;
    metadata["sourcePath"] = source.into();
    let reference = &head.reference;
    let head_metadata = serde_json::json!({"rustHeadVersion":head.version,"rustHeadSummaryFiles":head.summary_files});
    tx.execute("UPDATE sessions SET message_count=?,title=?,source_path=?,directory=?,project_identity_kind=?,project_identity_key=?,project_display_name=?,project_identity_resolver_revision=?,project_identity_input_signature=?,time_created=?,time_updated=?,activity_time=?,parent_agent_name=?,parent_session_id=?,total_input_tokens=?,total_output_tokens=?,total_cache_read_tokens=?,total_cache_create_tokens=?,total_tokens=?,total_cost=?,cost_source=?,model_usage_json=?,smart_tags_json=?,smart_tags_source_updated_at=?,smart_tags_classifier_revision=?,meta_json=?,head_meta_json=? WHERE source_node_id=? AND agent_name=? AND session_id=?",
        params![head.stats.message_count as i64,head.title,source,head.directory,head.project_identity.kind,head.project_identity.key,head.project_identity.display_name,head.project_identity_resolver_revision,head.project_identity_input_signature,head.time_created,head.time_updated,head.time_updated,head.parent_reference.as_ref().map(|p|&p.agent_name),head.parent_reference.as_ref().map(|p|&p.session_id),head.stats.total_input_tokens,head.stats.total_output_tokens,head.stats.total_cache_read_tokens,head.stats.total_cache_create_tokens,head.stats.total_tokens,head.stats.total_cost,head.stats.cost_source.as_ref().map(|v|v.as_str()),head.model_usage.as_ref().map(serde_json::to_string).transpose()?,serde_json::to_string(&head.smart_tags)?,head.smart_tags_source_updated_at,head.smart_tags_classifier_revision,serde_json::to_string(&metadata)?,serde_json::to_string(&head_metadata)?,reference.source_node_id,reference.agent_name,reference.session_id])?;
    tx.execute("UPDATE session_documents SET content_hash=? WHERE source_node_id=? AND agent_name=? AND session_id=?",params![crate::storage::facts::content_hash(head)?,reference.source_node_id,reference.agent_name,reference.session_id])?;
    tx.execute("UPDATE session_documents SET title=?1 WHERE source_node_id=?2 AND agent_name=?3 AND session_id=?4 AND title IS NOT ?1",params![head.title,reference.source_node_id,reference.agent_name,reference.session_id])?;
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
    crate::storage::facts::write(tx, reference, &[])?;
    tx.execute("INSERT INTO cache_meta VALUES('analytics_revision','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1",[])?;
    Ok(())
}
