use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
pub enum ProjectIdentityKind {
    GitRemote,
    GitCommonDir,
    ManifestPath,
    Synthetic,
    Path,
    Loose,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SmartTag {
    Bugfix,
    Refactoring,
    FeatureDev,
    Testing,
    Docs,
    GitOps,
    BuildDeploy,
    Exploration,
    Planning,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "lowercase")]
pub enum FileActivityKind {
    Read,
    Edit,
    Write,
    Delete,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "lowercase")]
pub enum ToolPartStatus {
    Running,
    Completed,
    Error,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "lowercase")]
pub enum PlanApprovalStatus {
    Success,
    Fail,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionReference {
    pub agent_name: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionStats {
    #[serde(skip)]
    #[ts(skip)]
    pub cost_inputs: Vec<crate::pricing::CostInput>,
    pub message_count: usize,
    pub total_input_tokens: f64,
    pub total_output_tokens: f64,
    pub total_cost: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_cache_read_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total_cache_create_tokens: Option<f64>,
}

impl Default for SessionStats {
    fn default() -> Self {
        Self {
            cost_inputs: Vec::new(),
            message_count: 0,
            total_input_tokens: 0.0,
            total_output_tokens: 0.0,
            total_cost: 0.0,
            cost_source: None,
            total_tokens: None,
            total_cache_read_tokens: None,
            total_cache_create_tokens: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "lowercase")]
pub enum CostSource {
    Recorded,
    Estimated,
}

impl CostSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Recorded => "recorded",
            Self::Estimated => "estimated",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ProjectIdentity {
    pub kind: String,
    pub key: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionHead {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub summary_files: Option<serde_json::Value>,
    pub reference: SessionReference,
    pub title: String,
    pub directory: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub display_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_reference: Option<SessionReference>,
    pub project_identity: ProjectIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_identity_resolver_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project_identity_input_signature: Option<String>,
    #[ts(type = "number")]
    pub time_created: f64,
    #[ts(type = "number")]
    pub time_updated: f64,
    pub stats: SessionStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_usage: Option<std::collections::BTreeMap<String, f64>>,
    pub smart_tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub smart_tags_source_updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub smart_tags_classifier_revision: Option<String>,
}

impl SessionHead {
    pub fn public(&self) -> Self {
        Self {
            model_usage: None,
            project_identity_resolver_revision: None,
            project_identity_input_signature: None,
            smart_tags_source_updated_at: None,
            smart_tags_classifier_revision: None,
            ..self.clone()
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct MessageTokens {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub input: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub output: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reasoning: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_read: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cache_create: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct Message {
    #[serde(skip)]
    #[ts(skip)]
    pub cost_inputs: Vec<crate::pricing::CostInput>,
    pub id: String,
    pub role: Role,
    pub agent: Option<String>,
    #[ts(type = "number")]
    pub time_created: f64,
    #[ts(type = "number | null")]
    pub time_completed: Option<f64>,
    pub mode: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tokens: Option<MessageTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cost_source: Option<CostSource>,
    pub parts: Vec<MessagePart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subagent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub nickname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub automated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MessagePart {
    Text {
        text: String,
        #[ts(type = "number")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        time_created: Option<f64>,
    },
    Reasoning {
        text: String,
        #[ts(type = "number")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        time_created: Option<f64>,
    },
    Plan {
        text: String,
        approval_status: String,
        #[ts(type = "number")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        time_created: Option<f64>,
    },
    Tool {
        tool: String,
        #[serde(rename = "callID", skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        call_id: Option<String>,
        state: Box<ToolState>,
        #[ts(type = "number")]
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        time_created: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
    },
    Image {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mime_type: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        #[ts(type = "number")]
        time_created: Option<f64>,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct ToolState {
    pub status: String,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub input: Option<serde_json::Value>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub output: Option<serde_json::Value>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub error: Option<serde_json::Value>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub metadata: Option<serde_json::Value>,
}

pub(crate) fn present_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
pub struct SessionDetail {
    #[serde(flatten)]
    pub head: SessionHead,
    pub messages: Vec<Message>,
    pub detail_freshness: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub message_update: Option<String>,
    pub file_activity: Vec<SessionFileActivity>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionFileActivity {
    pub reference: SessionReference,
    pub project_identity_key: String,
    pub path: String,
    pub kind: String,
    pub count: usize,
    #[ts(type = "number")]
    pub latest_time: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub display_name: String,
    pub count: usize,
    pub available: bool,
}

#[derive(Serialize, TS)]
pub struct SessionIndex {
    pub agents: Vec<AgentInfo>,
    pub sessions: Vec<SessionHead>,
}

#[cfg(test)]
mod tests {
    use super::ToolState;
    use serde_json::{Value, json};

    #[test]
    fn tool_state_roundtrip_distinguishes_missing_null_and_payloads() {
        for payload in [
            None,
            Some(Value::Null),
            Some(json!({"content":[null,"text"]})),
        ] {
            let mut value = json!({"status":"completed"});
            if let Some(payload) = &payload {
                for field in ["input", "output", "error", "metadata"] {
                    value[field] = payload.clone();
                }
            }
            let state: ToolState = serde_json::from_value(value.clone()).unwrap();
            for field in [&state.input, &state.output, &state.error, &state.metadata] {
                assert_eq!(field, &payload);
            }
            assert_eq!(serde_json::to_value(state).unwrap(), value);
        }
    }
}
