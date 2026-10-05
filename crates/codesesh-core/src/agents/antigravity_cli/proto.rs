#[derive(Clone, PartialEq, prost::Message)]
pub(super) struct Step {
    #[prost(message, optional, tag = "5")]
    pub tool: Option<ToolRun>,
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
pub(super) struct ToolRun {
    #[prost(message, optional, tag = "4")]
    pub call: Option<ToolCall>,
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
