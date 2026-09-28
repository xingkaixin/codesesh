use crate::{agents::ParsedSession, contract::SessionDetail, pricing::CostInput};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
