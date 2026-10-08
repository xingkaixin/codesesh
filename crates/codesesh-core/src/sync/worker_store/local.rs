use super::*;

impl WorkerStore {
    pub fn adopt_local_history(
        &mut self,
        cache: &crate::storage::Cache,
        grant: &super::super::PairingGrant,
    ) -> Result<Option<usize>> {
        ensure!(
            grant.node_id == crate::contract::LOCAL_SOURCE_NODE_ID,
            "Only the authenticated local Worker can adopt Hub history"
        );
        let snapshot = cache.connection().unchecked_transaction()?;
        let hub_id: String =
            snapshot.query_row("SELECT value FROM hub_meta WHERE key='hub_id'", [], |r| {
                r.get(0)
            })?;
        let epoch: String =
            snapshot.query_row("SELECT value FROM hub_meta WHERE key='epoch'", [], |r| {
                r.get(0)
            })?;
        ensure!(
            hub_id == grant.hub_id,
            "Local Hub belongs to another installation"
        );
        if epoch != grant.epoch || self.history_choice()?.as_deref() == Some("local") {
            return Ok(None);
        }
        ensure!(
            self.next_upload()?.is_none() && self.recovery()?.is_none(),
            "Pending Worker data must be synchronized before adopting Hub history"
        );
        let tx = self.db.transaction()?;
        tx.execute("DELETE FROM worker_sessions", [])?;
        tx.execute("DELETE FROM worker_sources", [])?;
        let mut count = 0;
        for agent in crate::agents::catalog(0) {
            for head in
                cache.source_agent_snapshot(crate::contract::LOCAL_SOURCE_NODE_ID, &agent.name)?
            {
                let source: Option<String> = snapshot.query_row("SELECT source_path FROM sessions WHERE source_node_id='local' AND agent_name=? AND session_id=?", params![agent.name,head.reference.session_id], |r| r.get(0))?;
                let Some(source) = source else {
                    continue;
                };
                let attachments = if agent.name == "dsh" {
                    cache
                        .detail(head.clone())?
                        .map(|detail| AttachmentReferences::from_messages(&detail.messages))
                        .unwrap_or_default()
                } else {
                    Default::default()
                };
                tx.execute(
                    "INSERT INTO worker_sessions(agent,session_id,head,source,attachments,content_hash,metadata_hash) VALUES(?,?,?,?,?,'','')",
                    params![
                        agent.name,
                        head.reference.session_id,
                        serde_json::to_string(&head)?,
                        source,
                        serde_json::to_string(&attachments)?
                    ],
                )?;
                count += 1;
            }
            let state: Option<String> = snapshot
                .query_row(
                    "SELECT value FROM cache_meta WHERE key=?",
                    [format!("rust_source_state:{}", agent.name)],
                    |r| r.get(0),
                )
                .optional()?;
            let checkpoint: Option<String> = snapshot
                .query_row(
                    "SELECT value FROM cache_meta WHERE key=?",
                    [format!("rust_sync_checkpoint:{}", agent.name)],
                    |r| r.get(0),
                )
                .optional()?;
            let complete: bool = snapshot.query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_initialization WHERE agent_name=?)",
                [&agent.name],
                |r| r.get(0),
            )?;
            tx.execute(
                "INSERT INTO worker_sources VALUES(?,?,?,?)",
                params![agent.name, state, checkpoint, complete],
            )?;
        }
        tx.execute("INSERT INTO worker_meta VALUES('history_choice','local') ON CONFLICT(key) DO UPDATE SET value=excluded.value", [])?;
        tx.commit()?;
        snapshot.commit()?;
        Ok(Some(count))
    }
}
