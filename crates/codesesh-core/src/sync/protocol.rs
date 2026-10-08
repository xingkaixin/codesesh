use crate::{contract::SessionHead, pricing::CostInput};
use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;
pub const PAYLOAD_VERSION: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Operation {
    Metadata {
        head: Box<SessionHead>,
        cost_inputs: Vec<CostInput>,
        source_path: String,
    },
    SnapshotChunk {
        transfer_id: String,
        index: u32,
        data: String,
    },
    SnapshotCommit {
        transfer_id: String,
        chunks: u32,
        bytes: u64,
        digest: String,
        /// Present when the snapshot holds only the messages after `keep` of the last sent state.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base: Option<SnapshotBase>,
        /// The Worker's message state after this snapshot, for the next delta to build on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        messages: Option<MessageState>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MessageState {
    pub count: u32,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotBase {
    pub keep: u32,
    pub previous: MessageState,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PayloadError {
    WorkerTooNew,
    WorkerTooOld,
    ProtocolUnsupported,
    PayloadUnsupported,
    InvalidVersion,
}

fn release(value: &str) -> Option<[u64; 3]> {
    let base = value.split(['-', '+']).next()?;
    let mut result = [0; 3];
    let mut parts = base.split('.');
    for number in &mut result {
        let part = parts.next()?;
        if part.is_empty()
            || part.len() > 1 && part.starts_with('0')
            || !part.bytes().all(|c| c.is_ascii_digit())
        {
            return None;
        }
        *number = part.parse().ok()?;
    }
    parts.next().is_none().then_some(result)
}

pub fn check_compatibility(
    worker: &str,
    hub: &str,
    minimum: &str,
    protocol: u32,
    payload: u32,
) -> Result<(), PayloadError> {
    let worker_release = release(worker).ok_or(PayloadError::InvalidVersion)?;
    let hub_release = release(hub).ok_or(PayloadError::InvalidVersion)?;
    let minimum_release = release(minimum).ok_or(PayloadError::InvalidVersion)?;
    if worker_release > hub_release {
        return Err(PayloadError::WorkerTooNew);
    }
    if worker_release < minimum_release {
        return Err(PayloadError::WorkerTooOld);
    }
    if (worker.contains('-') || hub.contains('-')) && worker != hub {
        return Err(PayloadError::InvalidVersion);
    }
    if protocol != PROTOCOL_VERSION {
        return Err(PayloadError::ProtocolUnsupported);
    }
    if payload != PAYLOAD_VERSION {
        return Err(PayloadError::PayloadUnsupported);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatibility_rejects_new_workers_and_unsupported_old_formats() {
        assert_eq!(check_compatibility("1.2.0", "1.3.0", "1.1.0", 1, 1), Ok(()));
        assert_eq!(
            check_compatibility("1.10.0", "1.9.0", "1.1.0", 1, 1),
            Err(PayloadError::WorkerTooNew)
        );
        assert_eq!(
            check_compatibility("1.0.0", "1.3.0", "1.1.0", 1, 1),
            Err(PayloadError::WorkerTooOld)
        );
        assert_eq!(
            check_compatibility("1.3.0", "1.3.0", "1.1.0", 2, 1),
            Err(PayloadError::ProtocolUnsupported)
        );
        assert_eq!(
            check_compatibility("1.3.0", "1.3.0", "1.1.0", 1, 2),
            Err(PayloadError::PayloadUnsupported)
        );
        assert_eq!(
            check_compatibility("1.03.0", "1.3.0", "1.1.0", 1, 1),
            Err(PayloadError::InvalidVersion)
        );
        assert_eq!(
            check_compatibility("1.3.0-dev", "1.3.0", "1.1.0", 1, 1),
            Err(PayloadError::InvalidVersion)
        );
    }
}
