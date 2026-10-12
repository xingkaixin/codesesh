#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Step {
    #[prost(message, optional, tag = "5")]
    pub metadata: Option<StepMetadata>,
    #[prost(message, optional, tag = "19")]
    pub user: Option<UserPrompt>,
    #[prost(message, optional, tag = "20")]
    pub assistant: Option<Text>,
    #[prost(message, optional, tag = "30")]
    pub title: Option<Title>,
}

#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct UserPrompt {
    #[prost(string, optional, tag = "2")]
    pub text: Option<String>,
    #[prost(message, optional, tag = "3")]
    pub content: Option<Text>,
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
    #[prost(message, repeated, tag = "28")]
    pub retries: Vec<Retry>,
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
