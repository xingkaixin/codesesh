mod capture;
mod hub_types;
mod protocol;
pub(crate) mod worker_store;

pub(crate) use capture::CapturedSession;
pub(crate) use protocol::{MessageState, Operation, PayloadError, SnapshotBase};
pub use protocol::{PAYLOAD_VERSION, PROTOCOL_VERSION, check_compatibility};
pub(crate) use worker_store::QueueStatus;
pub use worker_store::WorkerStore;

pub use hub_types::{
    CollectionStatus, HostInfo, HubHello, HubNodes, LocalNode, Node, NodeAgentActivity,
    PairingGrant, Receipt, Recovery, RescanHistory, Upload, WorkerHello,
};
pub(crate) use hub_types::{
    NodeHealth, NodeTask, RescanProgress, RescanRequest, RescanScanProgress,
};

fn local_worker_mac(
    key: &str,
    hub_id: &str,
    token: &str,
    stream: &str,
) -> hmac::Hmac<sha2::Sha256> {
    use hmac::{KeyInit, Mac};
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(key.as_bytes())
        .expect("HMAC accepts any key length");
    for part in ["codesesh-local-worker-v1", hub_id, token, stream] {
        mac.update(&(part.len() as u64).to_be_bytes());
        mac.update(part.as_bytes());
    }
    mac
}

pub fn local_worker_proof(key: &str, hub_id: &str, token: &str, stream: &str) -> String {
    use base64::Engine;
    use hmac::Mac;
    base64::engine::general_purpose::STANDARD.encode(
        local_worker_mac(key, hub_id, token, stream)
            .finalize()
            .into_bytes(),
    )
}

pub(crate) fn verify_local_worker_proof(
    key: &str,
    hub_id: &str,
    token: &str,
    stream: &str,
    proof: &str,
) -> bool {
    use base64::Engine;
    use hmac::Mac;
    base64::engine::general_purpose::STANDARD
        .decode(proof)
        .is_ok_and(|proof| {
            local_worker_mac(key, hub_id, token, stream)
                .verify_slice(&proof)
                .is_ok()
        })
}
