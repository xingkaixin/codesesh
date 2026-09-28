use super::*;
use crate::sync::WorkerStore;

impl Cache {
    pub fn resume_local_worker(
        &mut self,
        worker: &mut WorkerStore,
        hub_id: &str,
        pricing: &Pricing,
    ) -> Result<Option<String>> {
        let Some((origin, mut grant)) = worker.binding()? else {
            return Ok(None);
        };
        if grant.hub_id != hub_id {
            return Ok(None);
        }
        let epoch = self.initialize_hub(hub_id)?;
        if grant.epoch != epoch || worker.recovery()?.is_some() {
            let recovery = worker.prepare_recovery(&epoch)?;
            self.recover_worker(&grant.node_id, &recovery)?;
            grant.epoch = epoch;
            worker.finish_recovery(&origin, &grant)?;
        }
        while let Some(pending) = worker.next_upload()? {
            let receipt = self.receive_upload(
                &grant.node_id,
                &Upload {
                    epoch: grant.epoch.clone(),
                    stream_id: worker.stream_id()?,
                    sequence: pending.sequence,
                    payload_version: pending.payload_version,
                    digest: pending.digest,
                    operation: pending.operation,
                },
                pricing,
            )?;
            worker.acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)?;
        }
        let marker = format!("{}:{}", worker.stream_id()?, worker.confirmed_sequence()?);
        let previous: Option<String> = self
            .connection
            .query_row(
                "SELECT value FROM cache_meta WHERE key='local_worker_baseline'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if previous.as_deref() != Some(&marker) {
            let tx = self.connection.transaction()?;
            for agent in crate::agents::catalog(0) {
                let baseline = worker.baseline(&agent.name)?;
                let checkpoint = worker.checkpoint(&agent.name)?;
                if baseline.state.is_none() && checkpoint.is_none() && !baseline.complete {
                    continue;
                }
                let mut checkpoint = checkpoint.unwrap_or_else(|| serde_json::json!({}));
                checkpoint["sourceNodeId"] = grant.node_id.clone().into();
                if let Some(mut state) = baseline.state {
                    state["sourceNodeId"] = grant.node_id.clone().into();
                    checkpoint["sourceState"] = state;
                }
                Self::write_sessions(
                    &tx,
                    &[],
                    &[],
                    Some((&agent.name, &Some(checkpoint), baseline.complete)),
                    None,
                )?;
            }
            tx.execute("INSERT INTO cache_meta VALUES('local_worker_baseline',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&marker])?;
            tx.commit()?;
        }
        Ok(Some(grant.node_id))
    }
}
