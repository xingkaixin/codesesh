mod capture;
mod hub_types;
mod protocol;
pub(crate) mod worker_store;

pub use capture::CapturedSession;
pub use protocol::{
    Operation, PAYLOAD_VERSION, PROTOCOL_VERSION, PayloadError, check_compatibility,
};
pub use worker_store::{PendingUpload, QueueStatus, WorkerStore};

pub use hub_types::{
    CollectionStatus, HubHello, HubNodes, LocalNode, Node, NodeHealth, NodeTask, PairingGrant,
    Receipt, Recovery, RescanHistory, RescanProgress, RescanRequest, RescanScanProgress, Upload,
    WorkerHello,
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
