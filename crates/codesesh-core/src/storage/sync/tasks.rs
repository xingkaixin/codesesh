use super::*;

impl Cache {
    pub fn request_rescan(
        &mut self,
        nodes: &[String],
        agents: &[String],
        reason: &str,
    ) -> Result<Vec<crate::sync::RescanRequest>> {
        let catalog = crate::agents::catalog(0);
        let agents = agents.to_vec();
        ensure!(
            agents
                .iter()
                .all(|agent| catalog.iter().any(|entry| entry.name == *agent)),
            "Unknown rescan Agent"
        );
        let nodes = if nodes.is_empty() {
            self.nodes()?
                .into_iter()
                .filter(|node| !node.revoked)
                .map(|node| node.id)
                .collect()
        } else {
            nodes.to_vec()
        };
        let tx = self.connection.transaction()?;
        let mut requests = Vec::new();
        for node in nodes {
            ensure!(
                tx.query_row(
                    "SELECT COUNT(*) FROM hub_nodes WHERE id=? AND revoked=0 AND id IN (SELECT id FROM hub_control.nodes WHERE revoked=0)",
                    [&node],
                    |r| r.get::<_, i64>(0)
                )? == 1,
                "Unknown or revoked node"
            );
            let request = crate::sync::RescanRequest {
                id: uuid::Uuid::new_v4().to_string(),
                agents: agents.clone(),
                reason: reason.into(),
                required_revisions: catalog
                    .iter()
                    .map(|agent| {
                        (
                            agent.name.clone(),
                            crate::agents::parser_version(&agent.name).into(),
                        )
                    })
                    .collect(),
                created_at: chrono::Utc::now().timestamp_millis(),
            };
            tx.execute(
                "INSERT INTO hub_rescans VALUES(?,?,?,'waiting',NULL)",
                params![request.id, node, serde_json::to_string(&request)?],
            )?;
            requests.push(request);
        }
        tx.commit()?;
        Ok(requests)
    }

    pub fn rescan_tasks(&self) -> Result<Vec<crate::sync::NodeTask>> {
        let mut query = self.connection.prepare(
            "SELECT node_id,request,status,progress FROM hub_rescans ORDER BY rowid DESC",
        )?;
        let rows = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(node, request, status, progress)| {
                Ok(crate::sync::NodeTask {
                    node_id: node,
                    request: serde_json::from_str(&request)?,
                    status,
                    progress: progress.map(|raw| serde_json::from_str(&raw)).transpose()?,
                })
            })
            .collect()
    }

    pub fn rotate_data_epoch(&mut self) -> Result<String> {
        let epoch = uuid::Uuid::new_v4().to_string();
        self.connection
            .execute("UPDATE hub_meta SET value=? WHERE key='epoch'", [&epoch])?;
        Ok(epoch)
    }

    pub fn recover_worker(&mut self, node: &str, recovery: &crate::sync::Recovery) -> Result<()> {
        uuid::Uuid::parse_str(&recovery.new_stream).context("Invalid recovery stream")?;
        let tx = self.connection.transaction()?;
        let epoch: String =
            tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
                r.get(0)
            })?;
        ensure!(epoch == recovery.epoch, "HUB_EPOCH_CHANGED");
        let (stream,recovery_epoch): (String,Option<String>)=tx.query_row("SELECT stream_id,recovery_epoch FROM hub_nodes WHERE id=? AND revoked=0 AND id IN (SELECT id FROM hub_control.nodes WHERE revoked=0)",[node],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.context("Worker is unknown or revoked")?;
        if stream == recovery.new_stream {
            return Ok(());
        }
        ensure!(
            stream == recovery.previous_stream || recovery_epoch.as_ref() != Some(&epoch),
            "UPLOAD_STREAM_MISMATCH"
        );
        tx.execute("DELETE FROM hub_chunks WHERE node_id=?", [node])?;
        tx.execute("UPDATE hub_nodes SET stream_id=?,confirmed_sequence=0,confirmed_digest=NULL,confirmed_reference=NULL,recovery_epoch=? WHERE id=?",params![recovery.new_stream,epoch,node])?;
        tx.execute("UPDATE hub_rescans SET status='superseded' WHERE node_id=? AND status IN ('waiting','running','paused','uploading')",[node])?;
        let task = crate::sync::RescanRequest {
            id: recovery.new_stream.clone(),
            agents: Vec::new(),
            reason: "hub-recovery".into(),
            required_revisions: crate::agents::catalog(0)
                .into_iter()
                .map(|agent| {
                    (
                        agent.name.clone(),
                        crate::agents::parser_version(&agent.name).into(),
                    )
                })
                .collect(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        tx.execute(
            "INSERT INTO hub_rescans VALUES(?,?,?,'waiting',NULL)",
            params![task.id, node, serde_json::to_string(&task)?],
        )?;
        tx.commit()?;
        Ok(())
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
                "SELECT stream_id,confirmed_sequence FROM hub_nodes WHERE id=? AND revoked=0 AND id IN (SELECT id FROM hub_control.nodes WHERE revoked=0)",
                [node],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .context("Worker is unknown or revoked")?;
        let epoch: String =
            tx.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
                r.get(0)
            })?;
        ensure!(
            hello
                .epoch
                .as_ref()
                .is_some_and(|previous| previous != &epoch)
                || stream == hello.stream_id,
            "UPLOAD_STREAM_MISMATCH"
        );
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
            "UPDATE hub_nodes SET version=?,last_seen=?,queue=?,error=?,collection_complete=? WHERE id=?",
            params![
                hello.version,
                chrono::Utc::now().timestamp_millis(),
                serde_json::to_string(&hello.queue)?,
                error.map(|value|serde_json::to_string(&value)).transpose()?.or_else(||hello.collection_error.clone()),
                hello.collection_complete,
                node
            ],
        )?;
        if hello
            .epoch
            .as_ref()
            .is_none_or(|previous| previous == &epoch)
            && let Some(progress) = &hello.rescan
        {
            ensure!(
                progress
                    .target_sequence
                    .is_none_or(|target| target >= 0 && progress.pending_agents.is_empty()),
                "Invalid rescan completion marker"
            );
            let incomplete: i64 = tx.query_row(
                "SELECT COUNT(*) FROM hub_orphans WHERE node_id=?",
                [node],
                |r| r.get(0),
            )?;
            let status = if progress.error.is_some() {
                "failed"
            } else if error.is_some() {
                "paused"
            } else if progress
                .target_sequence
                .is_some_and(|target| target <= confirmed_sequence)
            {
                if incomplete > 0 {
                    "partial"
                } else {
                    "completed"
                }
            } else if progress.target_sequence.is_some() {
                "uploading"
            } else {
                "running"
            };
            tx.execute("UPDATE hub_rescans SET status=?,progress=? WHERE id=? AND node_id=? AND status<>'completed'",params![status,serde_json::to_string(progress)?,progress.id,node])?;
        }
        let rescan: Option<String> = tx.query_row("SELECT request FROM hub_rescans WHERE node_id=? AND status IN ('waiting','running','paused','uploading') ORDER BY rowid LIMIT 1",[node],|r|r.get(0)).optional()?;
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
            rescan: rescan.map(|raw| serde_json::from_str(&raw)).transpose()?,
        };
        tx.commit()?;
        Ok(result)
    }
}
