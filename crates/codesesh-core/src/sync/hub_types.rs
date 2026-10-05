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

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct CollectionStatus {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sources:
        Option<std::collections::BTreeMap<String, crate::discovery::AgentCollectionStatus>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub rescan: Option<RescanScanProgress>,
    pub active_agent: Option<String>,
    #[ts(type = "number | null")]
    pub last_success_at: Option<i64>,
    pub errors: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RescanScanProgress {
    pub id: String,
    pub agent: String,
    #[ts(type = "number")]
    pub completed: i64,
    #[ts(type = "number")]
    pub total: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeHealth {
    #[ts(type = "number")]
    pub reported_at: i64,
    pub collection: CollectionStatus,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub health: Option<NodeHealth>,
    pub id: String,
    pub name: String,
    pub version: String,
    #[ts(type = "number")]
    pub paired_at: i64,
    #[ts(type = "number | null")]
    pub last_seen: Option<i64>,
    #[ts(type = "number | null")]
    pub last_confirmed_at: Option<i64>,
    pub revoked: bool,
    #[ts(type = "number")]
    pub incomplete_sessions: i64,
    pub collection_complete: bool,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_status: Option<CollectionStatus>,
    #[serde(default)]
    pub collection_complete: bool,
    #[serde(default)]
    pub collection_error: Option<String>,
    #[serde(default)]
    pub epoch: Option<String>,
    #[serde(default)]
    pub confirmed_sequence: i64,
    pub version: String,
    pub protocol_version: u32,
    pub payload_version: u32,
    pub stream_id: String,
    pub queue: QueueStatus,
    #[serde(default)]
    pub rescan: Option<RescanProgress>,
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
    pub rescan: Option<RescanRequest>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RescanRequest {
    pub id: String,
    pub agents: Vec<String>,
    pub reason: String,
    pub required_revisions: std::collections::BTreeMap<String, String>,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RescanProgress {
    pub id: String,
    pub pending_agents: Vec<String>,
    #[ts(type = "number | null")]
    pub target_sequence: Option<i64>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recovery {
    pub epoch: String,
    pub previous_stream: String,
    pub new_stream: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeTask {
    pub node_id: String,
    pub request: RescanRequest,
    pub status: String,
    pub progress: Option<RescanProgress>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct LocalNode {
    pub enabled: bool,
    #[ts(type = "number")]
    pub sessions: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HubNodes {
    pub nodes: Vec<Node>,
    pub tasks: Vec<NodeTask>,
    pub local: Option<LocalNode>,
    pub version: String,
    pub minimum_worker_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct RescanHistory {
    pub tasks: Vec<NodeTask>,
    pub next_cursor: Option<String>,
}
