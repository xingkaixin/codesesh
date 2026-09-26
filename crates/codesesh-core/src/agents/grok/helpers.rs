use super::*;

pub(super) const XAI: &str = "_x.ai/session/update";
pub(super) const SAFE: f64 = 9_007_199_254_740_991.0;
pub(super) fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(super) fn string(v: &Value) -> Option<String> {
    v.as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}
pub(super) fn count(v: &Value) -> f64 {
    v.as_f64()
        .filter(|n| *n >= 0.0 && *n <= SAFE && n.fract() == 0.0)
        .unwrap_or(0.0)
}
pub(super) fn add(a: f64, b: f64) -> f64 {
    (a + b).min(SAFE)
}
pub(super) fn positive(n: f64) -> Option<f64> {
    (n > 0.0).then_some(n)
}
pub(super) fn iso(v: &Value) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(text(v))
        .ok()
        .map(|t| t.timestamp_millis() as f64)
}
pub(super) fn clean(s: &str) -> String {
    let mut result = super::super::message_text::strip_tags_in_order(s);
    result = result
        .split('\n')
        .map(|line| {
            let (body, cr) = line.strip_suffix('\r').map_or((line, ""), |s| (s, "\r"));
            format!("{}{cr}", body.trim_end_matches([' ', '\t']))
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end_matches(['\r', '\n'])
        .into();
    if result.trim().is_empty() {
        String::new()
    } else {
        result
    }
}
pub(super) fn clean_value(v: &mut Value) {
    match v {
        Value::String(s) => *s = clean(s),
        Value::Array(a) => a.iter_mut().for_each(clean_value),
        Value::Object(o) => o.values_mut().for_each(clean_value),
        _ => {}
    }
}
pub(super) fn title(s: &str) -> Option<String> {
    let cleaned = clean(s);
    let first = cleaned.lines().find(|s| !s.trim().is_empty())?;
    Some(String::from_utf16_lossy(
        &first
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .encode_utf16()
            .take(100)
            .collect::<Vec<_>>(),
    ))
}
pub(super) struct Update<'a> {
    pub(super) method: &'a str,
    pub(super) params: &'a Value,
    pub(super) update: &'a Value,
    pub(super) time: f64,
}
pub(super) fn unpack(v: &Value, fallback: f64) -> Option<Update<'_>> {
    let params = v.get("params").filter(|p| p.is_object()).unwrap_or(v);
    let update = params.get("update").filter(|p| p.is_object())?;
    let time = params["_meta"]["agentTimestampMs"]
        .as_f64()
        .filter(|n| *n >= 0.0 && *n <= SAFE && n.fract() == 0.0)
        .or_else(|| {
            v["timestamp"]
                .as_f64()
                .filter(|n| *n >= 0.0 && *n <= SAFE / 1000.0 && n.fract() == 0.0)
                .map(|n| n * 1000.0)
        })
        .unwrap_or(fallback);
    Some(Update {
        method: v["method"].as_str().unwrap_or("session/update"),
        params,
        update,
        time,
    })
}
pub(super) fn block_text(v: &Value) -> &str {
    if v["type"] == "text" {
        text(&v["text"])
    } else {
        text(&v["resource"]["text"])
    }
}
pub(super) fn part(v: &Value, time: f64) -> Option<MessagePart> {
    if v["type"] == "image" {
        let data = v["data"].as_str().map(str::to_owned);
        let url = v["uri"]
            .as_str()
            .or_else(|| v["url"].as_str())
            .map(str::to_owned);
        let mime = v["mimeType"]
            .as_str()
            .or_else(|| v["mime_type"].as_str())
            .map(str::to_owned);
        if data.as_ref().is_some_and(|s| !s.is_empty())
            && mime.as_ref().is_some_and(|s| !s.is_empty())
        {
            return Some(MessagePart::Image {
                data,
                url,
                mime_type: mime,
                time_created: Some(time),
            });
        }
        if url.as_ref().is_some_and(|s| !s.is_empty()) {
            return Some(MessagePart::Image {
                data: None,
                url,
                mime_type: mime,
                time_created: Some(time),
            });
        }
    }
    let s = block_text(v);
    (!clean(s).is_empty()).then(|| MessagePart::Text {
        text: s.into(),
        time_created: Some(time),
    })
}
pub(super) fn plan(v: &Value, time: f64) -> Option<MessagePart> {
    let entries = v["entries"]
        .as_array()?
        .iter()
        .filter_map(|e| {
            let s = clean(text(&e["content"]));
            (!s.is_empty()).then(|| (s, e["status"] == "completed"))
        })
        .collect::<Vec<_>>();
    if entries.is_empty() {
        return None;
    }
    Some(MessagePart::Plan {
        text: entries
            .iter()
            .map(|(s, c)| format!("- [{}] {s}", if *c { "x" } else { " " }))
            .collect::<Vec<_>>()
            .join("\n"),
        approval_status: if entries.iter().all(|(_, c)| *c) {
            "success"
        } else {
            "fail"
        }
        .into(),
        time_created: Some(time),
    })
}
pub(super) struct Usage {
    pub(super) tokens: MessageTokens,
    pub(super) total: f64,
    pub(super) cost: Option<f64>,
    pub(super) models: BTreeMap<String, f64>,
}
pub(super) fn usage(v: &Value) -> Option<Usage> {
    let u = v.get("usage").filter(|v| v.is_object())?;
    let input = count(&u["inputTokens"]);
    let output = count(&u["outputTokens"]);
    let total = count(&u["totalTokens"]);
    let ticks = count(&u["costUsdTicks"]);
    let cost = (u["usageIsIncomplete"] != true && u["costIsPartial"] != true && ticks > 0.0)
        .then_some(ticks / 10_000_000_000.0);
    let mut models = BTreeMap::new();
    if let Some(m) = u["modelUsage"].as_object() {
        for (name, v) in m {
            if !v.is_object() {
                continue;
            }
            let n = count(&v["totalTokens"]);
            let n = if n > 0.0 {
                n
            } else {
                add(count(&v["inputTokens"]), count(&v["outputTokens"]))
            };
            if n > 0.0 {
                models.insert(name.clone(), n);
            }
        }
    }
    Some(Usage {
        tokens: MessageTokens {
            input: Some(input),
            output: Some(output),
            reasoning: positive(count(&u["reasoningTokens"])),
            cache_read: positive(count(&u["cachedReadTokens"])),
            cache_create: positive(count(&u["cacheCreationTokens"])),
        },
        total: if total > 0.0 {
            total
        } else {
            add(input, output)
        },
        cost,
        models,
    })
}
pub(super) fn canonical(records: &[Value], fallback: f64) -> Vec<usize> {
    let mut surviving = Vec::new();
    let mut starts = Vec::new();
    let mut has_seen = false;
    let mut in_run = false;
    let mut current = None;
    for (i, v) in records.iter().enumerate() {
        let Some(e) = unpack(v, fallback) else {
            in_run = false;
            current = None;
            surviving.push(i);
            continue;
        };
        let kind = text(&e.update["sessionUpdate"]);
        if e.method == XAI
            && kind == "rewind_marker"
            && let Some(target) = e.update["target_prompt_index"]
                .as_u64()
                .filter(|n| *n <= SAFE as u64)
        {
            let target = target as usize;
            surviving.truncate(starts.get(target).copied().unwrap_or(surviving.len()));
            starts.truncate(target);
            in_run = false;
            current = None;
            continue;
        }
        if e.method != XAI && kind == "user_message_chunk" && e.update["_meta"]["hostTurn"] != true
        {
            let prompt = e.update["_meta"]["promptIndex"]
                .as_i64()
                .filter(|n| *n >= 0 && *n <= SAFE as i64);
            if prompt.is_some() {
                has_seen = true
            }
            let counted = !has_seen || prompt.is_some();
            let new = !in_run || ((has_seen || prompt.is_some()) && prompt != current);
            in_run = true;
            if new {
                current = prompt;
                if counted {
                    starts.push(surviving.len());
                }
            }
        } else {
            in_run = false;
            current = None
        }
        surviving.push(i);
    }
    surviving
}
pub(super) fn message(
    role: Role,
    id: String,
    time: f64,
    model: Option<String>,
    mode: Option<String>,
) -> Message {
    let assistant = role == Role::Assistant;
    Message {
        cost_inputs: Vec::new(),
        id,
        role,
        agent: assistant.then(|| "grok".into()),
        time_created: time,
        time_completed: None,
        mode,
        model,
        provider: assistant.then(|| "xai".into()),
        tokens: None,
        cost: Some(0.0),
        cost_source: None,
        parts: Vec::new(),
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}
pub(super) fn status(v: &Value) -> Option<&'static str> {
    match text(v).to_lowercase().as_str() {
        "completed" => Some("completed"),
        "failed" => Some("error"),
        "in_progress" | "pending" => Some("running"),
        _ => None,
    }
}
pub(super) fn tool_title(name: &str) -> &str {
    match name {
        "get_command_or_subagent_output" => "task",
        "list_dir" => "list",
        "read_file" => "read",
        "run_terminal_command" => "bash",
        "search_replace" => "edit",
        "todo_write" => "todo",
        "web_fetch" => "web fetch",
        _ => name,
    }
}
pub(super) fn output(u: &Value) -> Option<Value> {
    if let Some(v) = u.get("rawOutput").filter(|v| !v.is_null()) {
        return Some(v.clone());
    }
    let a = u["content"].as_array()?;
    let texts = a
        .iter()
        .map(|v| {
            block_text(if v["type"] == "content" {
                &v["content"]
            } else {
                v
            })
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>();
    Some(if texts.is_empty() {
        Value::Array(a.clone())
    } else {
        Value::String(texts.join("\n"))
    })
}
pub(super) fn merge_tokens(a: &mut MessageTokens, b: &MessageTokens) {
    for (x, y) in [
        (&mut a.input, b.input),
        (&mut a.output, b.output),
        (&mut a.reasoning, b.reasoning),
        (&mut a.cache_read, b.cache_read),
        (&mut a.cache_create, b.cache_create),
    ] {
        if let Some(y) = y {
            *x = Some(x.unwrap_or(0.0) + y)
        }
    }
}

pub(super) fn head_message_count(records: &[Value], fallback: f64) -> usize {
    let mut count = 0;
    let mut role = None;
    let mut user_prompt = None;
    let mut assistant_prompt: Option<String> = None;
    for index in canonical(records, fallback) {
        let Some(e) = unpack(&records[index], fallback) else {
            continue;
        };
        if e.method == XAI {
            continue;
        }
        if e.update["sessionUpdate"] == "user_message_chunk" {
            if e.update["_meta"]["hostTurn"] == true || part(&e.update["content"], e.time).is_none()
            {
                continue;
            }
            let prompt = e.update["_meta"]["promptIndex"]
                .as_i64()
                .filter(|n| n.unsigned_abs() <= SAFE as u64);
            if role != Some(Role::User)
                || !(prompt.is_none() || user_prompt.is_none() || prompt == user_prompt)
            {
                count += 1
            }
            role = Some(Role::User);
            user_prompt = prompt;
            assistant_prompt = None;
        } else {
            let visible = match text(&e.update["sessionUpdate"]) {
                "agent_message_chunk" | "agent_thought_chunk" => {
                    !clean(block_text(&e.update["content"])).is_empty()
                }
                "tool_call" => string(&e.update["toolCallId"]).is_some(),
                "plan" => plan(e.update, e.time).is_some(),
                _ => false,
            };
            if !visible {
                continue;
            }
            let prompt = string(&e.params["_meta"]["promptId"]);
            if role != Some(Role::Assistant)
                || (prompt.is_some() && assistant_prompt.is_some() && prompt != assistant_prompt)
            {
                count += 1
            }
            assistant_prompt = prompt.or_else(|| {
                if role == Some(Role::Assistant) {
                    assistant_prompt.take()
                } else {
                    None
                }
            });
            role = Some(Role::Assistant);
            user_prompt = None;
        }
    }
    count
}
