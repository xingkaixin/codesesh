use super::*;
use crate::{runtime::ScanBatch, sync::WorkerStore};

mod pairing;
mod recovery;
mod rescans;
mod uploads;

fn transfer(cache: &mut Cache, worker: &mut WorkerStore, grant: &PairingGrant) {
    while let Some(pending) = worker.next_upload().unwrap() {
        let upload = Upload {
            epoch: grant.epoch.clone(),
            stream_id: worker.stream_id().unwrap(),
            sequence: pending.sequence,
            payload_version: pending.payload_version,
            digest: pending.digest,
            operation: pending.operation,
        };
        let receipt = cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        let duplicate = cache
            .receive_upload(&grant.node_id, &upload, &Pricing::bundled())
            .unwrap();
        assert_eq!(receipt.sequence, duplicate.sequence);
        worker
            .acknowledge(&receipt.stream_id, receipt.sequence, &receipt.digest)
            .unwrap();
    }
}
