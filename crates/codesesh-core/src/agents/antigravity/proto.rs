#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Step {
    #[prost(message, optional, tag = "5")]
    pub metadata: Option<StepMetadata>,
    #[prost(message, optional, tag = "14")]
    pub view_file: Option<FileView>,
    #[prost(message, optional, tag = "19")]
    pub user: Option<UserPrompt>,
    #[prost(message, optional, tag = "20")]
    pub assistant: Option<Text>,
    #[prost(message, optional, tag = "28")]
    pub run_command: Option<CommandRun>,
    #[prost(message, optional, tag = "30")]
    pub title: Option<Title>,
    #[prost(message, optional, tag = "31")]
    pub error: Option<ErrorDetails>,
    #[prost(message, optional, tag = "47")]
    pub mcp: Option<McpCall>,
    #[prost(message, optional, tag = "140")]
    pub tool: Option<ToolExecution>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct ToolExecution {
    #[prost(message, optional, tag = "2")]
    pub result: Option<Text>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct FileView {
    #[prost(string, optional, tag = "4")]
    pub content: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct CommandRun {
    #[prost(message, optional, tag = "21")]
    pub output: Option<Text>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct McpCall {
    #[prost(string, optional, tag = "3")]
    pub result: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct ErrorDetails {
    #[prost(string, optional, tag = "2")]
    pub message: Option<String>,
    #[prost(string, optional, tag = "3")]
    pub details: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct UserPrompt {
    #[prost(string, optional, tag = "2")]
    pub text: Option<String>,
    #[prost(message, repeated, tag = "3")]
    pub items: Vec<UserItem>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct UserItem {
    #[prost(string, optional, tag = "1")]
    pub text: Option<String>,
    #[prost(message, optional, tag = "2")]
    pub context: Option<UserContext>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct UserContext {
    #[prost(message, optional, tag = "1")]
    pub file: Option<ContextTarget>,
    #[prost(message, optional, tag = "2")]
    pub directory: Option<ContextTarget>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct ContextTarget {
    #[prost(string, optional, tag = "5")]
    pub uri: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Text {
    #[prost(string, optional, tag = "1")]
    pub text: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Title {
    #[prost(string, optional, tag = "4")]
    pub text: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct StepMetadata {
    #[prost(message, optional, tag = "1")]
    pub created: Option<Timestamp>,
    #[prost(message, optional, tag = "4")]
    pub call: Option<ToolCall>,
    #[prost(message, optional, tag = "9")]
    pub usage: Option<Usage>,
    #[prost(message, optional, tag = "24")]
    pub model: Option<Model>,
    #[prost(message, repeated, tag = "28")]
    pub retries: Vec<Retry>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Model {
    #[prost(string, optional, tag = "8")]
    pub name: Option<String>,
    #[prost(string, optional, tag = "12")]
    pub api_name: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct TrajectoryMetadata {
    #[prost(string, repeated, tag = "7")]
    pub workspaces: Vec<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Timestamp {
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct ToolCall {
    #[prost(string, optional, tag = "1")]
    pub id: Option<String>,
    #[prost(string, optional, tag = "2")]
    pub name: Option<String>,
    #[prost(string, optional, tag = "3")]
    pub input: Option<String>,
    #[prost(string, optional, tag = "9")]
    pub secondary_name: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Retry {
    #[prost(message, optional, tag = "2")]
    pub usage: Option<Usage>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Usage {
    #[prost(uint64, optional, tag = "1")]
    pub model_id: Option<u64>,
    #[prost(uint64, tag = "2")]
    pub input: u64,
    #[prost(uint64, tag = "3")]
    pub total_output: u64,
    #[prost(uint64, tag = "4")]
    pub cache_create: u64,
    #[prost(uint64, tag = "5")]
    pub cache_read: u64,
    #[prost(string, optional, tag = "7")]
    pub message_id: Option<String>,
    #[prost(uint64, tag = "9")]
    pub reasoning: u64,
    #[prost(uint64, tag = "10")]
    pub visible_output: u64,
    #[prost(string, optional, tag = "11")]
    pub response_id: Option<String>,
    #[prost(string, optional, tag = "12")]
    pub provider_message_id: Option<String>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Generation {
    #[prost(message, optional, tag = "1")]
    pub chat: Option<ChatGeneration>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct ChatGeneration {
    #[prost(uint64, optional, tag = "3")]
    pub model_id: Option<u64>,
    #[prost(string, optional, tag = "19")]
    pub model: Option<String>,
}
