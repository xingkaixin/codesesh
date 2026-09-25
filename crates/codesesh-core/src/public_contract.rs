use crate::contract::{
    CostSource, FileActivityKind, MessageTokens, PlanApprovalStatus, ProjectIdentityKind, Role,
    SessionReference, SessionStats, SmartTag, ToolPartStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireProjectIdentity {
    pub kind: ProjectIdentityKind,
    pub key: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireSessionHead {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub version: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    #[serde(deserialize_with = "crate::contract::present_value")]
    pub summary_files: Option<serde_json::Value>,
    pub reference: SessionReference,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_title: Option<String>,
    pub directory: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_reference: Option<SessionReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_identity: Option<WireProjectIdentity>,
    pub time_created: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_updated: Option<f64>,
    pub stats: SessionStats,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smart_tags: Option<Vec<SmartTag>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct PublicReferencedSessionHead {
    pub reference: SessionReference,
    pub session: WireSessionHead,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ProjectGroup {
    #[serde(rename = "identityKind")]
    pub identity_kind: ProjectIdentityKind,
    #[serde(rename = "identityKey")]
    pub identity_key: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub sources: Vec<String>,
    #[serde(rename = "sessionCount")]
    pub session_count: f64,
    #[serde(rename = "lastActivity")]
    pub last_activity: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireAgentInfo {
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub count: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon: Option<String>,
    #[serde(rename = "iconColored")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_colored: Option<bool>,
    #[serde(rename = "resumeCommandPrefix")]
    pub resume_command_prefix: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireSessionFileActivity {
    pub reference: SessionReference,
    #[serde(rename = "projectIdentityKey")]
    pub project_identity_key: String,
    pub path: String,
    pub kind: FileActivityKind,
    pub count: f64,
    #[serde(rename = "latestTime")]
    pub latest_time: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionFileActivityOccurrence {
    pub path: String,
    pub kind: FileActivityKind,
    pub time: f64,
    pub tool_label: String,
    pub message_index: f64,
    pub tool_index: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireToolState {
    pub status: ToolPartStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    #[serde(deserialize_with = "crate::contract::present_value")]
    pub input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    #[serde(deserialize_with = "crate::contract::present_value")]
    pub output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    #[serde(deserialize_with = "crate::contract::present_value")]
    pub error: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    #[serde(deserialize_with = "crate::contract::present_value")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireTextPart {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireReasoningPart {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WirePlanPart {
    pub text: String,
    pub approval_status: PlanApprovalStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireToolPart {
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(rename = "callID")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub call_i_d: Option<String>,
    pub state: WireToolState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireImageDataPart {
    pub data: String,
    pub mime_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireImageUrlPart {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time_created: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(untagged)]
pub enum WireImagePart {
    Data(WireImageDataPart),
    Url(WireImageUrlPart),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WireMessagePart {
    Text(WireTextPart),
    Reasoning(WireReasoningPart),
    Plan(WirePlanPart),
    Tool(Box<WireToolPart>),
    Image(WireImagePart),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireMessage {
    pub id: String,
    pub role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub agent: Option<Option<String>>,
    pub time_created: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub time_completed: Option<Option<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub mode: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[serde(deserialize_with = "present_nullable")]
    pub provider: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens: Option<MessageTokens>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    pub parts: Vec<WireMessagePart>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subagent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub automated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum DetailFreshness {
    #[serde(rename = "fresh")]
    Fresh,
    #[serde(rename = "stale")]
    Stale,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum MessageUpdate {
    #[serde(rename = "reset")]
    Reset,
    #[serde(rename = "append")]
    Append,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireSessionDetail {
    #[serde(flatten)]
    pub head: WireSessionHead,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_usage: Option<BTreeMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_identity_input_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_identity_resolver_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smart_tags_classifier_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smart_tags_source_updated_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail_freshness: Option<DetailFreshness>,
    pub messages: Vec<WireMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_update: Option<MessageUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_activity: Option<Vec<WireSessionFileActivity>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionWindow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub to: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub days: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct AppConfig {
    pub window: SessionWindow,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ApiProjectAgentStat {
    pub name: String,
    pub sessions: f64,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ApiProjectGroup {
    #[serde(flatten)]
    pub project: ProjectGroup,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    #[serde(rename = "agentStats")]
    pub agent_stats: Vec<ApiProjectAgentStat>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ApiProjectSummary {
    pub projects: f64,
    pub sessions: f64,
    pub tokens: f64,
    pub cost: f64,
    #[serde(rename = "latestActivity")]
    pub latest_activity: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ApiProjectPage {
    pub projects: Vec<ApiProjectGroup>,
    pub summary: ApiProjectSummary,
    #[serde(rename = "nextCursor")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum SessionsUpdatedEventType {
    #[serde(rename = "sessions-updated")]
    SessionsUpdated,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionsUpdatedEvent {
    pub r#type: SessionsUpdatedEventType,
    #[serde(rename = "changedAgents")]
    pub changed_agents: Vec<String>,
    #[serde(rename = "newSessionRefs")]
    pub new_session_refs: Vec<SessionReference>,
    #[serde(rename = "totalSessions")]
    pub total_sessions: f64,
    pub timestamp: f64,
    #[serde(rename = "changedSessionHeads")]
    pub changed_session_heads: Vec<PublicReferencedSessionHead>,
    #[serde(rename = "projectionRelatedSessionHeads")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection_related_session_heads: Option<Vec<PublicReferencedSessionHead>>,
    #[serde(rename = "projectionSessionOrder")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub projection_session_order: Option<Vec<SessionReference>>,
    #[serde(rename = "removedSessionRefs")]
    pub removed_session_refs: Vec<SessionReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum ScanCompleteness {
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "partial")]
    Partial,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ScanCompletion {
    pub completeness: ScanCompleteness,
    #[serde(rename = "sourceFailureCount")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_failure_count: Option<f64>,
    #[serde(rename = "sourceFailureSummary")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_failure_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum AgentScanPhase {
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "scanning")]
    Scanning,
    #[serde(rename = "finalizing")]
    Finalizing,
    #[serde(rename = "publish-queued")]
    PublishQueued,
    #[serde(rename = "publishing")]
    Publishing,
    #[serde(rename = "indexing")]
    Indexing,
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "failed")]
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct AgentScanStatus {
    #[serde(rename = "agentName")]
    pub agent_name: String,
    pub status: AgentScanPhase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completeness: Option<ScanCompleteness>,
    #[serde(rename = "sourceFailureCount")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_failure_count: Option<f64>,
    #[serde(rename = "sourceFailureSummary")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub source_failure_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub processed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sessions: Option<f64>,
    #[serde(rename = "startedAt")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<f64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    #[serde(rename = "completedAt")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum BackfillPhase {
    #[serde(rename = "scanning")]
    Scanning,
    #[serde(rename = "finalizing")]
    Finalizing,
    #[serde(rename = "publish-queued")]
    PublishQueued,
    #[serde(rename = "publishing")]
    Publishing,
    #[serde(rename = "indexing")]
    Indexing,
    #[serde(rename = "committing")]
    Committing,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct BackfillProgress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub phase: Option<BackfillPhase>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub processed: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sessions: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct BackfillStatus {
    pub active: bool,
    #[serde(rename = "pendingAgents")]
    pub pending_agents: Vec<String>,
    #[serde(rename = "currentAgent")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub progress: Option<BackfillProgress>,
    #[serde(rename = "completedAgents")]
    pub completed_agents: Vec<String>,
    #[serde(rename = "failedAgents")]
    pub failed_agents: Vec<String>,
    #[serde(rename = "partialAgents")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub partial_agents: Option<BTreeMap<String, ScanCompletion>>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SearchIndexMaintenanceStatus {
    pub active: bool,
    #[serde(rename = "pendingAgents")]
    pub pending_agents: Vec<String>,
    #[serde(rename = "currentAgent")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub current_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remaining: Option<f64>,
    #[serde(rename = "completedAgents")]
    pub completed_agents: Vec<String>,
    #[serde(rename = "failedAgents")]
    pub failed_agents: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum ScanStatusEventType {
    #[serde(rename = "scan-status")]
    ScanStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum ScanPhase {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "publishing")]
    Publishing,
    #[serde(rename = "indexing")]
    Indexing,
    #[serde(rename = "initializing")]
    Initializing,
    #[serde(rename = "scanning")]
    Scanning,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ScanStatusEvent {
    pub r#type: ScanStatusEventType,
    pub active: bool,
    pub phase: ScanPhase,
    #[serde(rename = "pendingAgents")]
    pub pending_agents: Vec<String>,
    #[serde(rename = "scanningAgents")]
    pub scanning_agents: Vec<String>,
    #[serde(rename = "completedAgents")]
    pub completed_agents: Vec<String>,
    #[serde(rename = "agentStatuses")]
    pub agent_statuses: BTreeMap<String, AgentScanStatus>,
    #[serde(rename = "totalAgents")]
    pub total_agents: f64,
    #[serde(rename = "startedAt")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<f64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
    #[serde(rename = "completedAt")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub completed_at: Option<f64>,
    pub backfill: BackfillStatus,
    #[serde(rename = "searchIndexMaintenance")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub search_index_maintenance: Option<SearchIndexMaintenanceStatus>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum SearchMatchType {
    #[serde(rename = "recent")]
    Recent,
    #[serde(rename = "title")]
    Title,
    #[serde(rename = "user_message")]
    UserMessage,
    #[serde(rename = "assistant_reply")]
    AssistantReply,
    #[serde(rename = "tool_output")]
    ToolOutput,
    #[serde(rename = "file_path")]
    FilePath,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SearchResultParent {
    pub reference: SessionReference,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SearchHighlightRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SearchResult {
    #[serde(flatten)]
    pub session: PublicReferencedSessionHead,
    pub snippet: String,
    #[serde(rename = "snippetHighlights")]
    pub snippet_highlights: Vec<SearchHighlightRange>,
    #[serde(rename = "matchType")]
    pub match_type: SearchMatchType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent: Option<SearchResultParent>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct BookmarkRecord {
    pub reference: SessionReference,
    #[serde(rename = "bookmarkedAt")]
    pub bookmarked_at: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum UnavailableBookmarkReason {
    #[serde(rename = "session-unavailable")]
    SessionUnavailable,
    #[serde(rename = "agent-unavailable")]
    AgentUnavailable,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub enum AvailableBookmarkReason {
    #[serde(rename = "available")]
    Available,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct AvailableBookmarkView {
    #[serde(flatten)]
    pub bookmark: BookmarkRecord,
    pub availability: AvailableBookmarkReason,
    pub session: WireSessionHead,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct UnavailableBookmarkView {
    #[serde(flatten)]
    pub bookmark: BookmarkRecord,
    pub availability: UnavailableBookmarkReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(untagged)]
pub enum BookmarkView {
    Available(Box<AvailableBookmarkView>),
    Unavailable(UnavailableBookmarkView),
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ModelCostEntry {
    pub model: String,
    pub cost: f64,
    #[serde(rename = "costRecorded")]
    pub cost_recorded: f64,
    #[serde(rename = "costEstimated")]
    pub cost_estimated: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardAgentStat {
    pub name: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub icon: String,
    #[serde(rename = "iconColored")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub icon_colored: Option<bool>,
    pub sessions: f64,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardDailyBucket {
    pub date: String,
    pub sessions: f64,
    pub messages: f64,
    pub cost: f64,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ModelDistributionEntry {
    pub model: String,
    pub tokens: f64,
    pub sessions: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardProjectStat {
    #[serde(rename = "identityKind")]
    pub identity_kind: ProjectIdentityKind,
    #[serde(rename = "identityKey")]
    pub identity_key: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub sessions: f64,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    pub agents: Vec<String>,
    pub sparkline: Vec<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardProjectRollup {
    pub projects: f64,
    pub sessions: f64,
    pub tokens: f64,
    pub cost: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardPreviousTotals {
    pub sessions: f64,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardTotals {
    pub sessions: f64,
    pub messages: f64,
    pub tokens: f64,
    pub cost: f64,
    #[serde(rename = "costRecorded")]
    pub cost_recorded: f64,
    #[serde(rename = "costEstimated")]
    pub cost_estimated: f64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    #[serde(rename = "latestActivity")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_activity: Option<f64>,
    #[serde(rename = "latestActivityProject")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_activity_project: Option<String>,
    #[serde(rename = "latestActivityAgent")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub latest_activity_agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub previous: Option<DashboardPreviousTotals>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ScopeCounts {
    pub projects: f64,
    pub agents: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardAggregate {
    pub totals: DashboardTotals,
    #[serde(rename = "scopeCounts")]
    pub scope_counts: ScopeCounts,
    #[serde(rename = "perAgent")]
    pub per_agent: Vec<DashboardAgentStat>,
    #[serde(rename = "dailyActivity")]
    pub daily_activity: Vec<DashboardDailyBucket>,
    #[serde(rename = "modelDistribution")]
    pub model_distribution: Vec<ModelDistributionEntry>,
    #[serde(rename = "modelCost")]
    pub model_cost: Option<Vec<ModelCostEntry>>,
    #[serde(rename = "perProject")]
    pub per_project: Vec<DashboardProjectStat>,
    #[serde(rename = "projectRollup")]
    pub project_rollup: DashboardProjectRollup,
    #[serde(rename = "recentSessions")]
    pub recent_sessions: Vec<PublicReferencedSessionHead>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardActiveHours {
    #[serde(rename = "timeZone")]
    pub time_zone: String,
    pub counts: Vec<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardWindow {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub from: Option<f64>,
    pub to: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub days: Option<f64>,
    #[serde(rename = "compareFrom")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compare_from: Option<f64>,
    #[serde(rename = "compareTo")]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compare_to: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct FileActivityResult {
    #[serde(flatten)]
    pub activity: WireSessionFileActivity,
    pub session: WireSessionHead,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct DashboardData {
    #[serde(flatten)]
    pub aggregate: DashboardAggregate,
    #[serde(rename = "activeHours")]
    pub active_hours: Option<DashboardActiveHours>,
    #[serde(rename = "recentFileActivities")]
    pub recent_file_activities: Vec<FileActivityResult>,
    pub window: DashboardWindow,
}

fn present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct WireSessionListPage {
    pub sessions: Vec<WireSessionHead>,
    #[serde(
        rename = "nextCursor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_preserves_absent_fields_explicit_null_and_json_tool_values() {
        for nullable in [false, true] {
            let mut value = json!({
                "id": "message", "role": "assistant", "time_created": 123.5,
                "parts": [{"type": "tool", "tool": "read", "state": {
                    "status": "completed", "input": null, "output": [1, null, {"nested": true}]
                }}]
            });
            if nullable {
                for name in ["agent", "time_completed", "mode", "model", "provider"] {
                    value[name] = serde_json::Value::Null;
                }
            }
            let message: WireMessage = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(message).unwrap(), value);
        }
    }

    #[test]
    fn message_parts_reject_invalid_closed_values_and_images_without_content() {
        for value in [
            json!({"type": "plan", "text": "plan", "approval_status": "pending"}),
            json!({"type": "tool", "tool": "read", "state": {"status": "unknown"}}),
            json!({"type": "image", "mime_type": "image/png"}),
        ] {
            assert!(serde_json::from_value::<WireMessagePart>(value).is_err());
        }
        for value in [
            json!({"type": "image", "data": "base64", "mime_type": "image/png"}),
            json!({"type": "image", "url": "https://example.com/image.png"}),
        ] {
            let part: WireMessagePart = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(part).unwrap(), value);
        }
    }

    #[test]
    fn public_session_does_not_serialize_internal_cache_provenance() {
        let value = json!({
            "reference": {"agentName": "codex", "sessionId": "session"},
            "title": "Session", "directory": "/project", "time_created": 1,
            "stats": {"message_count": 0, "total_input_tokens": 0.0,
                      "total_output_tokens": 0.0, "total_cost": 0.0},
            "model_usage": {"internal-model": 1},
            "project_identity_input_signature": "private"
        });
        let head: WireSessionHead = serde_json::from_value(value).unwrap();
        let public = serde_json::to_value(head).unwrap();
        assert!(public.get("model_usage").is_none());
        assert!(public.get("project_identity_input_signature").is_none());
    }
}
