use super::{Operation, QueueStatus};
use crate::contract::SessionReference;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Upload {
    pub epoch: String,
    pub stream_id: String,
    pub sequence: i64,
    pub payload_version: u32,
    pub digest: String,
    pub operation: Operation,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub epoch: String,
    pub stream_id: String,
    pub sequence: i64,
    pub digest: String,
    pub changed: Option<SessionReference>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub name: String,
    pub version: String,
    pub paired_at: i64,
    pub last_seen: Option<i64>,
    pub revoked: bool,
    pub queue: Option<QueueStatus>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingGrant {
    pub node_id: String,
    pub credential: String,
    pub hub_id: String,
    pub epoch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerHello {
    pub version: String,
    pub protocol_version: u32,
    pub payload_version: u32,
    pub stream_id: String,
    pub queue: QueueStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubHello {
    pub hub_id: String,
    pub epoch: String,
    pub version: String,
    pub minimum_worker_version: String,
    pub protocol_version: u32,
    pub payload_version: u32,
    pub error: Option<super::PayloadError>,
    pub confirmed_sequence: i64,
    pub heartbeat_seconds: u32,
    pub max_in_flight: u32,
}
