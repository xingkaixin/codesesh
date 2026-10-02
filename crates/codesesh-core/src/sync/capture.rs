use crate::{
    agents::ParsedSession,
    contract::{Message, SessionDetail, SessionFileActivity, SessionHead},
    pricing::CostInput,
};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{borrow::Cow, collections::BTreeMap};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CapturedSessionRef<'a> {
    detail: DetailRef<'a>,
    pub source_path: Cow<'a, str>,
    head_cost_inputs: &'a [CostInput],
    pub message_cost_inputs: BTreeMap<usize, &'a [CostInput]>,
}

#[derive(Serialize)]
struct DetailRef<'a> {
    #[serde(flatten)]
    head: &'a SessionHead,
    messages: &'a [Message],
    detail_freshness: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_cursor: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_update: &'a Option<String>,
    file_activity: &'a [SessionFileActivity],
}

impl<'a> CapturedSessionRef<'a> {
    pub fn new(session: &'a ParsedSession) -> Self {
        Self {
            detail: DetailRef {
                head: &session.head,
                messages: &session.detail.messages,
                detail_freshness: &session.detail.detail_freshness,
                message_cursor: &session.detail.message_cursor,
                message_update: &session.detail.message_update,
                file_activity: &session.detail.file_activity,
            },
            source_path: session.source.to_string_lossy(),
            head_cost_inputs: &session.head.stats.cost_inputs,
            message_cost_inputs: session
                .detail
                .messages
                .iter()
                .enumerate()
                .filter(|(_, message)| !message.cost_inputs.is_empty())
                .map(|(index, message)| (index, message.cost_inputs.as_slice()))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapturedSession {
    pub detail: SessionDetail,
    pub source_path: String,
    pub head_cost_inputs: Vec<CostInput>,
    pub message_cost_inputs: BTreeMap<usize, Vec<CostInput>>,
}

impl CapturedSession {
    pub fn from_parsed(session: ParsedSession) -> Self {
        let mut detail = session.detail;
        detail.head = session.head;
        let head_cost_inputs = std::mem::take(&mut detail.head.stats.cost_inputs);
        let message_cost_inputs = detail
            .messages
            .iter_mut()
            .enumerate()
            .filter_map(|(index, message)| {
                (!message.cost_inputs.is_empty())
                    .then(|| (index, std::mem::take(&mut message.cost_inputs)))
            })
            .collect();
        Self {
            detail,
            source_path: session.source.to_string_lossy().into_owned(),
            head_cost_inputs,
            message_cost_inputs,
        }
    }

    pub fn into_parsed(mut self) -> Result<ParsedSession> {
        self.detail.head.stats.cost_inputs = self.head_cost_inputs;
        for (index, inputs) in self.message_cost_inputs {
            ensure!(
                index < self.detail.messages.len(),
                "Cost inputs reference a missing message"
            );
            self.detail.messages[index].cost_inputs = inputs;
        }
        Ok(ParsedSession {
            head: self.detail.head.clone(),
            detail: self.detail,
            source: self.source_path.into(),
        })
    }
}
