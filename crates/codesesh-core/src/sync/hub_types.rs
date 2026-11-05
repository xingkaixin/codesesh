use super::{Operation, QueueStatus};
use crate::model::SessionReference;
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub hostname: String,
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeHealth {
    #[ts(type = "number")]
    pub reported_at: i64,
    pub collection: CollectionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host: Option<HostInfo>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeAgentActivity {
    #[ts(type = "number")]
    pub sessions: usize,
    #[ts(type = "number | null")]
    pub last_activity: Option<f64>,
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
    pub agents: std::collections::BTreeMap<String, NodeAgentActivity>,
    pub ignored_sources: Vec<String>,
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
    #[serde(default)]
    pub host: Option<HostInfo>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
pub enum RescanStatus {
    Waiting,
    Dispatched,
    Running,
    Paused,
    Uploading,
    Completed,
    Partial,
    Failed,
    Cancelled,
    Superseded,
}

impl RescanStatus {
    pub const ALL: [Self; 10] = [
        Self::Waiting,
        Self::Dispatched,
        Self::Running,
        Self::Paused,
        Self::Uploading,
        Self::Completed,
        Self::Partial,
        Self::Failed,
        Self::Cancelled,
        Self::Superseded,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Dispatched => "dispatched",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Uploading => "uploading",
            Self::Completed => "completed",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Superseded => "superseded",
        }
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Waiting | Self::Dispatched | Self::Running | Self::Paused | Self::Uploading
        )
    }
}

impl rusqlite::ToSql for RescanStatus {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(self.as_str().into())
    }
}

impl rusqlite::types::FromSql for RescanStatus {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        let text = value.as_str()?;
        Self::ALL
            .into_iter()
            .find(|status| status.as_str() == text)
            .ok_or(rusqlite::types::FromSqlError::InvalidType)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct NodeTask {
    pub node_id: String,
    pub request: RescanRequest,
    pub status: RescanStatus,
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
