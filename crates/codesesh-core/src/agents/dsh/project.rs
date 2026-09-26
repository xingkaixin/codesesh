use crate::{contract::*, pricing::Pricing};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn positive(v: &Value) -> f64 {
    v.as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(0.0)
}
static CLEANERS: std::sync::LazyLock<Vec<(regex::Regex, &'static str)>> =
    std::sync::LazyLock::new(|| {
        let mut rules = Vec::new();
        let tags = [
            "command-message",
            "command-name",
            "local-command-caveat",
            "local-command-stdout",
            "system-reminder",
        ];
        for tag in tags {
            rules.push((
                regex::Regex::new(&format!(
                    r"(?i)(^|\r?\n)[ \t]*<{tag}(?-u:\b)[^>]*>[\s\S]*?</{tag}>[ \t]*(?:\r?\n|$)"
                ))
                .unwrap(),
                "$1",
            ));
            rules.push((
                regex::Regex::new(&format!(r"(?i)<{tag}(?-u:\b)[^>]*>[\s\S]*?</{tag}>")).unwrap(),
                "",
            ));
            rules.push((
                regex::Regex::new(&format!(r"(?i)\n*<{tag}(?-u:\b)[^>]*>[\s\S]*$")).unwrap(),
                "",
            ));
        }
        for tag in tags.into_iter().chain(["command-args"]) {
            rules.push((
                regex::Regex::new(&format!(r"(?i)</?{tag}(?-u:\b)[^>]*>")).unwrap(),
                "",
            ));
        }
        rules
    });
pub fn clean(input: &str) -> String {
    let mut s = input.to_owned();
    if s.contains('<') {
        for (pattern, replacement) in CLEANERS.iter() {
            s = pattern.replace_all(&s, *replacement).into_owned();
        }
    }
    s = s
        .split_inclusive('\n')
        .map(|line| {
            let ending = if line.ends_with("\r\n") {
                "\r\n"
            } else if line.ends_with('\n') {
                "\n"
            } else {
                ""
            };
            format!(
                "{}{}",
                line.strip_suffix(ending)
                    .unwrap_or(line)
                    .trim_end_matches([' ', '\t']),
                ending
            )
        })
        .collect::<String>();
    while let Some(prefix) = s.strip_suffix("\r\n").or_else(|| s.strip_suffix('\n')) {
        s.truncate(prefix.len());
    }
    if s.trim().is_empty() {
        String::new()
    } else {
        s
    }
}
fn clean_value(v: &mut Value) {
    match v {
        Value::String(s) => *s = clean(s),
        Value::Array(items) => items.iter_mut().for_each(clean_value),
        Value::Object(map) => map.values_mut().for_each(clean_value),
        _ => {}
    }
}
pub fn title(s: &str) -> Option<String> {
    let s = clean(s);
    let line = s.lines().find(|l| !l.trim().is_empty())?;
    let s = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(String::from_utf16_lossy(
        &s.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
}
fn tool(id: &str, name: &str, args: &Value, time: f64) -> MessagePart {
    let name = if name.trim().is_empty() {
        "tool"
    } else {
        name.trim()
    };
    let mut input = if let Some(s) = args.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| args.clone())
    } else if args.is_null() {
        json!({})
    } else {
        args.clone()
    };
    clean_value(&mut input);
    MessagePart::Tool {
        tool: name.into(),
        title: Some(name.to_lowercase()),
        call_id: (!id.is_empty()).then(|| id.into()),
        time_created: Some(time),
        state: Box::new(ToolState {
            status: "running".into(),
            input: Some(input),
            output: None,
            error: None,
            metadata: None,
        }),
    }
}
fn content(
    raw: &Value,
    time: f64,
    attachments: &Path,
    canonical: &HashSet<String>,
) -> Vec<MessagePart> {
    let mut parts = Vec::new();
    let mut dropped = 0;
    for block in raw.as_array().into_iter().flatten() {
        match text(&block["type"]) {
            "text" | "reasoning" => {
                let s = clean(text(&block["text"]));
                if !s.is_empty() {
                    parts.push(if block["type"] == "text" {
                        MessagePart::Text {
                            text: s,
                            time_created: Some(time),
                        }
                    } else {
                        MessagePart::Reasoning {
                            text: s,
                            time_created: Some(time),
                        }
                    });
                }
            }
            "tool-call" => {
                if !canonical.contains(text(&block["id"])) {
                    parts.push(tool(
                        text(&block["id"]),
                        text(&block["name"]),
                        &block["arguments"],
                        time,
                    ));
                }
            }
            "image" => {
                let a = &block["attachment"];
                let id = text(&a["attachmentId"]);
                let mime = text(&a["mediaType"]);
                let image = id
                    .strip_prefix("sha256:")
                    .filter(|s| {
                        s.len() == 64
                            && s.bytes()
                                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    })
                    .and_then(|digest| {
                        if !["image/png", "image/jpeg", "image/webp", "image/gif"].contains(&mime) {
                            return None;
                        }
                        let bytes = std::fs::read(
                            attachments.join("objects").join(&digest[..2]).join(digest),
                        )
                        .ok()?;
                        if a["bytes"].as_f64().is_some_and(|n| n != bytes.len() as f64)
                            || crate::hash::hex(&Sha256::digest(&bytes)) != digest
                        {
                            return None;
                        }
                        Some(MessagePart::Image {
                            url: None,
                            data: Some(STANDARD.encode(bytes)),
                            mime_type: Some(mime.into()),
                            time_created: Some(time),
                        })
                    });
                if let Some(image) = image {
                    parts.push(image);
                } else {
                    dropped += 1;
                }
            }
            _ => {}
        }
    }
    if parts.is_empty() && dropped > 0 {
        parts.push(MessagePart::Text {
            text: "Image attachment unavailable".into(),
            time_created: Some(time),
        });
    }
    parts
}
fn append(event: &Value) -> Result<bool> {
    let op = &event["surfaceOp"];
    if op == "append" {
        return Ok(true);
    }
    ensure!(
        op["op"] == "replace"
            && ["start", "end"].iter().all(|k| op[k]
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)),
        "DSH invalid or absent surfaceOp at seq {}",
        event["seq"]
    );
    Ok(false)
}
fn message(id: String, role: Role, time: f64, parts: Vec<MessagePart>) -> Message {
    Message {
        cost_inputs: Vec::new(),
        id,
        agent: if role == Role::Assistant {
            Some("dsh".into())
        } else {
            None
        },
        role,
        time_created: time,
        time_completed: None,
        mode: None,
        model: None,
        provider: None,
        tokens: None,
        cost: None,
        cost_source: None,
        parts,
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}
struct Pending {
    turn: f64,
    step: f64,
    first: f64,
    last: f64,
    blocks: BTreeMap<String, Value>,
    usage: Value,
}
pub struct Projection {
    pub messages: Vec<Message>,
    pub stats: SessionStats,
    pub usage: BTreeMap<String, f64>,
    pub title: Option<String>,
    pub updated: f64,
}
struct Projector<'a> {
    pricing: &'a Pricing,
    attachments: &'a Path,
    canonical: HashSet<String>,
    messages: Vec<Message>,
    current: Option<usize>,
    tools: HashMap<String, (usize, usize)>,
    pending: Option<Pending>,
    settled: HashSet<String>,
    provider: Option<String>,
    model: Option<String>,
    stats: SessionStats,
    usage: BTreeMap<String, f64>,
    own_title: Option<String>,
    inherited_title: Option<String>,
    label: Option<String>,
    human: Option<String>,
    updated: f64,
}
impl Projector<'_> {
    fn push(&mut self, m: Message) {
        let index = self.messages.len();
        self.current = if m.role == Role::Assistant {
            Some(index)
        } else {
            None
        };
        for (part, p) in m.parts.iter().enumerate() {
            if let MessagePart::Tool {
                call_id: Some(id), ..
            } = p
            {
                self.tools.insert(id.clone(), (index, part));
            }
        }
        self.messages.push(m);
    }
    fn assistant(
        &mut self,
        id: String,
        time: f64,
        parts: Vec<MessagePart>,
        provider: Option<String>,
        model: Option<String>,
        usage: &Value,
    ) {
        let mut m = message(id, Role::Assistant, time, parts);
        m.provider = provider;
        m.model = model;
        if usage.is_object() {
            let read = positive(&usage["cacheReadTokens"]);
            let create = positive(&usage["cacheWriteTokens"]);
            let input = positive(&usage["inputTokens"]) + read + create;
            let output = positive(&usage["outputTokens"]);
            let reasoning = positive(&usage["reasoningTokens"]).min(output);
            let tokens = MessageTokens {
                input: Some(input),
                output: Some(output - reasoning),
                reasoning: (reasoning > 0.0).then_some(reasoning),
                cache_read: (read > 0.0).then_some(read),
                cache_create: (create > 0.0).then_some(create),
            };
            m.cost =
                self.pricing
                    .estimate_tracked(m.model.as_deref(), &tokens, 0.0, &mut m.cost_inputs);
            m.cost_source = m.cost.filter(|n| *n > 0.0).map(|_| CostSource::Estimated);
            m.tokens = Some(tokens);
            self.stats.total_input_tokens += input;
            self.stats.total_output_tokens += output;
            self.stats.total_cost += m.cost.unwrap_or(0.0);
            self.stats.cost_inputs.extend(m.cost_inputs.iter().cloned());
            self.stats.total_cache_read_tokens =
                Some(self.stats.total_cache_read_tokens.unwrap_or(0.0) + read);
            self.stats.total_cache_create_tokens =
                Some(self.stats.total_cache_create_tokens.unwrap_or(0.0) + create);
            if let Some(model) = &m.model {
                *self.usage.entry(model.clone()).or_default() += input + output;
            }
        }
        if !m.parts.is_empty() {
            self.push(m);
        }
    }
    fn flush(&mut self) {
        let Some(p) = self.pending.take() else {
            return;
        };
        let mut parts = Vec::new();
        let mut blocks: Vec<_> = p.blocks.into_iter().collect();
        blocks.sort_by(|(a, _), (b, _)| {
            a.parse::<f64>()
                .unwrap_or(0.0)
                .total_cmp(&b.parse::<f64>().unwrap_or(0.0))
        });
        for (_, b) in blocks {
            if b["type"] == "tool-call" {
                if !self.canonical.contains(text(&b["id"])) {
                    parts.push(tool(
                        text(&b["id"]),
                        text(&b["name"]),
                        &b["arguments"],
                        p.last,
                    ));
                }
            } else {
                let s = clean(text(&b["text"]));
                if !s.is_empty() {
                    parts.push(if b["type"] == "text" {
                        MessagePart::Text {
                            text: s,
                            time_created: Some(p.first),
                        }
                    } else {
                        MessagePart::Reasoning {
                            text: s,
                            time_created: Some(p.first),
                        }
                    });
                }
            }
        }
        if !parts.is_empty() {
            self.assistant(
                format!("dsh-step-{}-{}", p.turn, p.step),
                p.first,
                parts,
                self.provider.clone(),
                self.model.clone(),
                &p.usage,
            );
        }
    }
    fn chunk(&mut self, d: &Value, time: f64) {
        if !d["turn"].is_number() || !d["step"].is_number() {
            return;
        }
        let key = format!(
            "{}:{}",
            d["turn"].as_f64().unwrap(),
            d["step"].as_f64().unwrap()
        );
        if self.settled.contains(&key) {
            return;
        }
        if self.pending.as_ref().is_some_and(|p| {
            p.turn != d["turn"].as_f64().unwrap() || p.step != d["step"].as_f64().unwrap()
        }) {
            self.flush();
        }
        let p = self.pending.get_or_insert_with(|| Pending {
            turn: d["turn"].as_f64().unwrap(),
            step: d["step"].as_f64().unwrap(),
            first: time,
            last: time,
            blocks: BTreeMap::new(),
            usage: Value::Null,
        });
        p.last = time;
        let c = &d["chunk"];
        if !c["index"].is_number() {
            if c["type"] == "usage" {
                p.usage = c["usage"].clone();
            }
            return;
        }
        let key = c["index"].as_f64().unwrap().to_string();
        let old = p.blocks.get(&key).cloned().unwrap_or(Value::Null);
        match text(&c["type"]) {
            "text-delta" | "reasoning-delta" => {
                let kind = if c["type"] == "text-delta" {
                    "text"
                } else {
                    "reasoning"
                };
                let previous = if old["type"] == kind {
                    text(&old["text"])
                } else {
                    ""
                };
                p.blocks.insert(
                    key,
                    json!({"type":kind,"text":format!("{previous}{}",text(&c["text"]))}),
                );
            }
            "tool-call-delta" => {
                let previous = if old["type"] == "tool-call" {
                    text(&old["arguments"])
                } else {
                    ""
                };
                let name = if !text(&c["name"]).is_empty() {
                    text(&c["name"])
                } else if old["type"] == "tool-call" {
                    text(&old["name"])
                } else {
                    ""
                };
                p.blocks.insert(key,json!({"type":"tool-call","id":text(&c["id"]),"name":name,"arguments":format!("{previous}{}",text(&c["argumentsDelta"]))}));
            }
            "block-end" => {
                if ["text", "reasoning", "tool-call"].contains(&text(&c["block"]["type"])) {
                    p.blocks.insert(key, c["block"].clone());
                }
            }
            _ => {}
        }
    }
    fn consume(&mut self, e: &Value, own: bool) -> Result<()> {
        let d = &e["data"];
        let time = e["time"].as_f64().unwrap_or(0.0);
        let seq = e["seq"].as_f64().unwrap_or(0.0);
        match text(&e["type"]) {
            "user/message" => {
                let visible = append(e)?;
                if visible && own && d["source"]["kind"] == "user" {
                    let parts = content(&d["content"], time, self.attachments, &self.canonical);
                    if !parts.is_empty() {
                        self.push(message(
                            if text(&d["id"]).is_empty() {
                                format!("dsh-user-{seq}")
                            } else {
                                text(&d["id"]).into()
                            },
                            Role::User,
                            time,
                            parts,
                        ));
                        if self.human.is_none() {
                            self.human = d["content"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|b| b["type"] == "text")
                                .map(|b| clean(text(&b["text"])))
                                .find(|s| !s.is_empty());
                        }
                    }
                }
            }
            "assistant/message" => {
                let visible = append(e)?;
                if d["turn"].is_number() && d["step"].is_number() {
                    self.settled.insert(format!(
                        "{}:{}",
                        d["turn"].as_f64().unwrap(),
                        d["step"].as_f64().unwrap()
                    ));
                    if self.pending.as_ref().is_some_and(|p| {
                        p.turn == d["turn"].as_f64().unwrap()
                            && p.step == d["step"].as_f64().unwrap()
                    }) {
                        self.pending = None;
                    }
                }
                if visible && own {
                    let m = &d["message"];
                    let provider = nonempty(&m["source"]["provider"]);
                    let model = nonempty(&m["source"]["model"]);
                    if provider.is_some() {
                        self.provider = provider.clone();
                    }
                    if model.is_some() {
                        self.model = model.clone();
                    }
                    self.assistant(
                        if text(&m["id"]).is_empty() {
                            format!("dsh-assistant-{seq}")
                        } else {
                            text(&m["id"]).into()
                        },
                        time,
                        content(&m["content"], time, self.attachments, &self.canonical),
                        provider,
                        model,
                        &d["usage"],
                    );
                }
            }
            "tool/call" if own => {
                let id = text(&d["callId"]);
                let part = tool(id, text(&d["name"]), &d["arguments"], time);
                if let Some(current) = self.current {
                    let index = self.messages[current].parts.len();
                    self.messages[current].parts.push(part);
                    self.tools.insert(id.into(), (current, index));
                } else {
                    self.push(message(id.into(), Role::Assistant, time, vec![part]));
                }
            }
            "tool/result" => {
                if append(e)? && own {
                    let m = &d["message"];
                    let id = text(&m["source"]["callId"]);
                    let blocks = m["content"]
                        .as_array()
                        .ok_or_else(|| anyhow::anyhow!("DSH tool result content invalid"))?;
                    ensure!(
                        m["source"]["kind"] == "tool"
                            && blocks.len() == 1
                            && blocks[0]["type"] == "tool-result"
                            && text(&blocks[0]["toolCallId"]) == id,
                        "DSH invalid tool result identity"
                    );
                    let b = &blocks[0];
                    let output = content(&b["content"], time, self.attachments, &self.canonical);
                    if let Some((message, part)) = self.tools.remove(id)
                        && let MessagePart::Tool { state, .. } =
                            &mut self.messages[message].parts[part]
                    {
                        state.output = Some(serde_json::to_value(output)?);
                        state.status = if b["isError"] == true || d["error"].is_object() {
                            "error"
                        } else {
                            "completed"
                        }
                        .into();
                        state.metadata = d.get("meta").cloned();
                        if let Some(v) = &mut state.metadata {
                            clean_value(v);
                        }
                    }
                }
            }
            "assistant/chunk" if own => self.chunk(d, time),
            "request/context" => {
                if let Some(p) = nonempty(&d["provider"]) {
                    self.provider = Some(p);
                }
                if let Some(m) = nonempty(&d["model"]) {
                    self.model = Some(m);
                }
            }
            "session/title" => {
                if let Some(t) = title(text(&d["title"])) {
                    if own {
                        self.own_title = Some(t);
                    } else {
                        self.inherited_title = Some(t);
                    }
                }
            }
            "subagent/descriptor" if own => {
                if self.label.is_none() {
                    self.label = title(text(&d["label"]));
                }
            }
            _ => {}
        }
        Ok(())
    }
}
fn nonempty(v: &Value) -> Option<String> {
    let s = text(v);
    (!s.is_empty()).then(|| s.into())
}
pub fn project(
    head: &Value,
    events: &[Value],
    attachments: &Path,
    pricing: &Pricing,
) -> Result<Projection> {
    let mut canonical = HashSet::new();
    for e in events {
        if e["type"] == "tool/call" {
            let id = text(&e["data"]["callId"]);
            ensure!(
                !id.is_empty() && canonical.insert(id.to_owned()),
                "DSH absent or duplicate canonical tool call id"
            );
        }
    }
    let mut p = Projector {
        pricing,
        attachments,
        canonical,
        messages: Vec::new(),
        current: None,
        tools: HashMap::new(),
        pending: None,
        settled: HashSet::new(),
        provider: None,
        model: None,
        stats: SessionStats::default(),
        usage: BTreeMap::new(),
        own_title: None,
        inherited_title: None,
        label: None,
        human: None,
        updated: 0.0,
    };
    let seed = head["seedLength"].as_f64().unwrap_or(0.0) as u64;
    for e in events {
        let own = e["seq"].as_f64().unwrap_or(0.0) as u64 >= seed;
        if own {
            p.updated = p.updated.max(e["time"].as_f64().unwrap_or(0.0));
        }
        p.consume(e, own)?;
    }
    p.flush();
    p.stats.message_count = p.messages.len();
    p.stats.cost_source = (p.stats.total_cost > 0.0).then_some(CostSource::Estimated);
    p.stats.total_cache_read_tokens = p.stats.total_cache_read_tokens.filter(|n| *n > 0.0);
    p.stats.total_cache_create_tokens = p.stats.total_cache_create_tokens.filter(|n| *n > 0.0);
    Ok(Projection {
        messages: p.messages,
        stats: p.stats,
        usage: p.usage,
        title: p.own_title.or(p.label).or(p.human).or(p.inherited_title),
        updated: if p.updated == 0.0 {
            head["createdAt"].as_f64().unwrap_or(0.0)
        } else {
            p.updated
        },
    })
}
