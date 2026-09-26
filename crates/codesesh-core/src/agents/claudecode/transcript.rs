use super::super::codex::timestamp;
use super::{common::*, internal, output_parts, user_parts};
use crate::{contract::*, pricing::Pricing};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) struct Transcript {
    pub(super) messages: Vec<Message>,
    current: Option<usize>,
    latest_text: Option<usize>,
    tools: HashMap<String, (usize, usize)>,
    uuid_tools: HashMap<String, Vec<String>>,
    requests: HashMap<String, usize>,
    part_flags: HashMap<usize, (bool, bool)>,
}
impl Transcript {
    pub(super) fn new() -> Self {
        Self {
            messages: Vec::new(),
            current: None,
            latest_text: None,
            tools: HashMap::new(),
            uuid_tools: HashMap::new(),
            requests: HashMap::new(),
            part_flags: HashMap::new(),
        }
    }
    fn begin(&mut self) {
        self.current = None;
        self.latest_text = None;
    }
    fn assistant(
        &mut self,
        part: MessagePart,
        id: &str,
        time: f64,
        model: Option<&str>,
        subagent: Option<&String>,
    ) -> usize {
        let is_tool = matches!(part, MessagePart::Tool { .. });
        let is_text = matches!(part, MessagePart::Text { .. });
        let target = if is_tool {
            self.latest_text.or(self.current)
        } else {
            self.current.filter(|i| {
                let (has_text, has_tool) = self.part_flags.get(i).copied().unwrap_or_default();
                !has_tool && (is_text || !has_text)
            })
        };
        let index = target.unwrap_or_else(|| {
            let mut m = message(id.into(), Role::Assistant, time, Vec::new());
            m.agent = Some("claude".into());
            m.model = model.map(str::to_owned);
            if is_tool {
                m.mode = Some("tool".into());
            }
            self.messages.push(m);
            self.messages.len() - 1
        });
        let m = &mut self.messages[index];
        if m.id.is_empty() {
            m.id = id.into();
        }
        if m.model.is_none() {
            m.model = model.map(str::to_owned);
        }
        if let Some(subagent) = subagent {
            m.subagent_id = Some(subagent.clone());
        }
        let duplicate = match (&part, m.parts.last()) {
            (MessagePart::Text { text: a, .. }, Some(MessagePart::Text { text: b, .. }))
            | (
                MessagePart::Reasoning { text: a, .. },
                Some(MessagePart::Reasoning { text: b, .. }),
            ) => a == b,
            _ => false,
        };
        if !duplicate {
            if let MessagePart::Tool {
                call_id: Some(id), ..
            } = &part
                && !id.is_empty()
            {
                self.tools.insert(id.clone(), (index, m.parts.len()));
            }
            m.parts.push(part);
            let flags = self.part_flags.entry(index).or_default();
            flags.0 |= is_text;
            flags.1 |= is_tool;
        }
        self.current = Some(index);
        if is_text {
            self.latest_text = Some(index);
        }
        index
    }
    fn backfill(&mut self, id: &str, output: Vec<MessagePart>, updates: &Value) -> bool {
        let Some(&(i, p)) = self.tools.get(id) else {
            return false;
        };
        let MessagePart::Tool { state, .. } = &mut self.messages[i].parts[p] else {
            return false;
        };
        let has_output = !output.is_empty();
        if has_output {
            let extra = output.into_iter().map(|p| serde_json::to_value(p).unwrap());
            match &mut state.output {
                Some(Value::Array(existing)) => existing.extend(extra),
                None | Some(Value::Null) => state.output = Some(Value::Array(extra.collect())),
                Some(existing) => {
                    let mut combined = vec![existing.clone()];
                    combined.extend(extra);
                    state.output = Some(Value::Array(combined));
                }
            }
        }
        if let Some(success) = updates["success"].as_bool() {
            state.status = if success { "completed" } else { "error" }.into();
        }
        if let Some(name) = updates
            .get("commandName")
            .filter(|v| !v.is_null() && **v != false && **v != "")
        {
            state.metadata = Some(json!({"commandName":name}));
        }
        if has_output && state.status == "running" {
            state.status = "completed".into();
        }
        true
    }
    fn fallback(&mut self, id: &str, time: f64, parts: Vec<MessagePart>) {
        if !parts.is_empty() {
            self.messages
                .push(message(id.into(), Role::Tool, time, parts));
        }
    }
    pub(super) fn convert(
        &mut self,
        record: &Value,
        children: &HashMap<String, String>,
        pricing: &Pricing,
    ) {
        if internal(record) {
            return;
        }
        let raw = &record["message"];
        let time = timestamp(record);
        let id = text(&record["uuid"]);
        match record["type"].as_str() {
            Some("assistant") => {
                let model = raw["model"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                let key = record["requestId"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| id.trim());
                let has_usage = raw["usage"].is_object() && !key.is_empty();
                let mut usage_index = if has_usage {
                    self.requests.get(key).copied()
                } else {
                    None
                };
                if has_usage && usage_index.is_none() {
                    self.begin();
                }
                let mut calls = Vec::new();
                for part in raw["content"].as_array().into_iter().flatten() {
                    let converted = match part["type"].as_str() {
                        Some("text") => text_part(&text(&part["text"]), time),
                        Some("thinking") => {
                            let text = clean(&text(&part["thinking"]));
                            (!text.is_empty()).then_some(MessagePart::Reasoning {
                                text,
                                time_created: Some(time),
                            })
                        }
                        Some("tool_use") => {
                            let tool = text(&part["name"]);
                            let call = text(&part["id"]);
                            if !call.trim().is_empty() {
                                calls.push(call.trim().to_owned());
                            }
                            Some(MessagePart::Tool {
                                title: Some(format!("Tool: {tool}")),
                                tool,
                                call_id: Some(call),
                                time_created: Some(time),
                                state: Box::new(ToolState {
                                    status: "running".into(),
                                    input: Some(
                                        part.get("input")
                                            .filter(|v| !v.is_null())
                                            .cloned()
                                            .unwrap_or(json!({})),
                                    ),
                                    output: Some(Value::Null),
                                    error: None,
                                    metadata: None,
                                }),
                            })
                        }
                        _ => None,
                    };
                    if let Some(part) = converted {
                        let subagent = if let MessagePart::Tool {
                            call_id: Some(id), ..
                        } = &part
                        {
                            children.get(id.trim())
                        } else {
                            None
                        };
                        let i = self.assistant(part, &id, time, model, subagent);
                        usage_index.get_or_insert(i);
                    }
                }
                if !calls.is_empty() {
                    self.uuid_tools.insert(id.clone(), calls);
                }
                if has_usage {
                    let i = usage_index.unwrap_or_else(|| {
                        let mut m = message(id.clone(), Role::Assistant, time, Vec::new());
                        m.agent = Some("claude".into());
                        m.model = model.map(str::to_owned);
                        self.messages.push(m);
                        self.current = Some(self.messages.len() - 1);
                        self.messages.len() - 1
                    });
                    self.requests.insert(key.into(), i);
                    let usage = &raw["usage"];
                    let n = |k: &str| usage[k].as_f64().unwrap_or(0.0);
                    let read = n("cache_read_input_tokens");
                    let create = n("cache_creation_input_tokens");
                    let tokens = MessageTokens {
                        input: Some(n("input_tokens") + read + create),
                        output: Some(n("output_tokens")),
                        cache_read: Some(read),
                        cache_create: Some(create),
                        reasoning: None,
                    };
                    let m = &mut self.messages[i];
                    m.model = model.map(str::to_owned);
                    m.cost_inputs.clear();
                    m.cost = Some(
                        pricing
                            .estimate_tracked(model, &tokens, 0.0, &mut m.cost_inputs)
                            .unwrap_or(0.0),
                    );
                    m.cost_source = (m.cost.unwrap_or(0.0) > 0.0).then_some(CostSource::Estimated);
                    m.tokens = Some(tokens);
                    m.time_completed = Some(time);
                }
            }
            Some("user") => {
                let content = &raw["content"];
                let visible = user_parts(content, time);
                if let Some(items) = content.as_array() {
                    for item in items.iter().filter(|i| i["type"] == "tool_result") {
                        let direct = text(&item["tool_use_id"]).trim().to_owned();
                        let source = text(&record["sourceToolAssistantUUID"]).trim().to_owned();
                        let resolved = if !direct.is_empty() {
                            direct
                        } else {
                            self.uuid_tools
                                .get(&source)
                                .filter(|ids| ids.len() == 1)
                                .map(|ids| ids[0].clone())
                                .unwrap_or_default()
                        };
                        let output = output_parts(&item["content"], time);
                        if !self.backfill(&resolved, output.clone(), &record["toolUseResult"]) {
                            self.fallback(&id, time, output);
                        }
                    }
                }
                if !visible.is_empty() {
                    self.messages.push(message(id, Role::User, time, visible));
                }
                self.begin();
            }
            Some("tool_result") => {
                self.fallback(&id, time, output_parts(&raw["content"], time));
                self.begin();
            }
            _ => {}
        }
    }
}
