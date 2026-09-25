use crate::contract::*;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

pub fn records(path: &Path) -> anyhow::Result<Box<dyn Iterator<Item = anyhow::Result<Value>>>> {
    use std::io::BufRead;
    if !path.exists() {
        return Ok(Box::new(std::iter::empty()));
    }
    let reader = std::io::BufReader::new(std::fs::File::open(path)?);
    Ok(Box::new(reader.split(b'\n').filter_map(|line| {
        match line {
            Ok(bytes) => serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes))
                .ok()
                .map(Ok),
            Err(error) => Some(Err(error.into())),
        }
    })))
}
pub fn directories(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut paths = vec![];
    for bucket in std::fs::read_dir(root)? {
        let bucket = bucket?;
        if !bucket.file_type()?.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(bucket.path())? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    Ok(paths)
}
pub fn str_value(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a.iter().map(str_value).collect::<Vec<_>>().join(","),
        _ => v.to_string(),
    }
}
pub fn string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_owned)
}
pub fn number(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.)
}
pub fn timestamp(v: &Value) -> Option<f64> {
    if let Some(n) = v.as_f64() {
        return Some(n);
    }
    let s = v.as_str()?.trim().replacen(' ', "T", 1);
    if s.is_empty() {
        return None;
    }
    if let Ok(n) = s.parse::<f64>() {
        return n.is_finite().then_some(n);
    }
    chrono::DateTime::parse_from_rfc3339(&s)
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(&format!("{s}Z")))
        .or_else(|_| chrono::DateTime::parse_from_str(&s, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .ok()
        .map(|t| t.timestamp_millis() as f64)
}
pub fn mtime(path: &Path) -> anyhow::Result<f64> {
    Ok(crate::time::file_mtime_ms(path)?)
}
static CLEAN_PATTERNS: std::sync::LazyLock<Vec<(regex::Regex, &'static str)>> =
    std::sync::LazyLock::new(|| {
        let mut patterns = vec![];
        let tags = [
            "command-message",
            "command-name",
            "local-command-caveat",
            "local-command-stdout",
            "system-reminder",
        ];
        for tag in tags {
            for (pattern, replacement) in [
                (
                    format!(r"(?i)(^|\r?\n)[ \t]*<{tag}\b[^>]*>[\s\S]*?</{tag}>[ \t]*(?:\r?\n|$)"),
                    "$1",
                ),
                (format!(r"(?i)<{tag}\b[^>]*>[\s\S]*?</{tag}>"), ""),
                (format!(r"(?i)\n*<{tag}\b[^>]*>[\s\S]*$"), ""),
            ] {
                patterns.push((regex::Regex::new(&pattern).unwrap(), replacement));
            }
        }
        for tag in tags.into_iter().chain(["command-args"]) {
            patterns.push((
                regex::Regex::new(&format!(r"(?i)</?{tag}\b[^>]*>")).unwrap(),
                "",
            ));
        }
        patterns
    });
pub fn clean(s: &str) -> String {
    let mut s = s.to_owned();
    if s.contains('<') {
        for (pattern, replacement) in CLEAN_PATTERNS.iter() {
            s = pattern.replace_all(&s, *replacement).into_owned();
        }
    }
    s = s
        .split_inclusive('\n')
        .map(|line| {
            let (body, end) = if let Some(body) = line.strip_suffix("\r\n") {
                (body, "\r\n")
            } else if let Some(body) = line.strip_suffix('\n') {
                (body, "\n")
            } else {
                (line, "")
            };
            format!("{}{end}", body.trim_end_matches([' ', '\t']))
        })
        .collect();
    s = s.trim_end_matches(['\r', '\n']).to_owned();
    if s.trim().is_empty() {
        String::new()
    } else {
        s
    }
}
pub fn title(s: &str) -> Option<String> {
    let cleaned = clean(s);
    let line = cleaned.lines().find(|l| !l.trim().is_empty())?;
    let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(String::from_utf16_lossy(
        &line.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
}
pub fn content_text(v: &Value, fallback_content: bool) -> String {
    if let Some(s) = v.as_str() {
        return s.into();
    }
    if let Some(a) = v.as_array() {
        return a
            .iter()
            .map(|v| {
                if v.is_string() {
                    str_value(v)
                } else {
                    str_value(
                        v.get("text")
                            .filter(|v| !v.is_null())
                            .or_else(|| fallback_content.then(|| v.get("content")).flatten())
                            .unwrap_or(&Value::Null),
                    )
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
    }
    str_value(&v["text"])
}
pub fn text(s: &str, ts: f64) -> Vec<MessagePart> {
    let s = clean(s);
    if s.is_empty() {
        vec![]
    } else {
        vec![MessagePart::Text {
            text: s,
            time_created: Some(ts),
        }]
    }
}
pub fn args(v: Option<&Value>) -> Option<Value> {
    v.map(|v| {
        v.as_str()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| v.clone())
    })
}
pub fn tool(name: &str, id: &str, input: Option<Value>, ts: f64, code: bool) -> MessagePart {
    let title = match name {
        "ReadFile" => "read",
        "Glob" => "glob",
        "StrReplaceFile" => "edit",
        "Grep" => "grep",
        "WriteFile" => "write",
        "Shell" => "bash",
        "Read" if code => "read",
        "Write" if code => "write",
        "Edit" if code => "edit",
        "Bash" if code => "bash",
        "TodoList" if code => "todo",
        "AskUserQuestion" if code => "ask",
        "EnterPlanMode" if code => "plan mode",
        "ExitPlanMode" if code => "plan approved",
        _ => name,
    };
    MessagePart::Tool {
        tool: name.into(),
        call_id: Some(id.into()),
        title: Some(title.into()),
        time_created: Some(ts),
        state: Box::new(ToolState {
            status: "running".into(),
            input,
            output: Some(Value::Null),
            error: None,
            metadata: None,
        }),
    }
}
#[derive(Default)]
pub struct Builder {
    pub messages: Vec<Message>,
    pub current: Option<usize>,
    calls: HashMap<String, (usize, usize)>,
}
impl Builder {
    #[allow(clippy::too_many_arguments)]
    pub fn append(
        &mut self,
        id: String,
        role: Role,
        ts: f64,
        parts: Vec<MessagePart>,
        agent: Option<&str>,
        model: Option<&str>,
        provider: Option<&str>,
    ) {
        let i = self.messages.len();
        let mode = (role == Role::Assistant
            && !parts.is_empty()
            && parts.iter().all(|p| matches!(p, MessagePart::Tool { .. })))
        .then(|| "tool".into());
        for (p, part) in parts.iter().enumerate() {
            if let MessagePart::Tool {
                call_id: Some(id), ..
            } = part
            {
                self.calls.insert(id.clone(), (i, p));
            }
        }
        if role == Role::Assistant {
            self.current = Some(i);
        } else if role == Role::User {
            self.current = None;
        }
        self.messages.push(Message {
            id,
            role,
            agent: agent.map(str::to_owned),
            time_created: ts,
            time_completed: None,
            mode,
            model: model.map(str::to_owned),
            provider: provider.map(str::to_owned),
            tokens: None,
            cost: Some(0.),
            cost_source: None,
            parts,
            subagent_id: None,
            nickname: None,
            automated: None,
        });
    }
    pub fn part(
        &mut self,
        id: String,
        ts: f64,
        part: MessagePart,
        agent: &str,
        model: Option<&str>,
        provider: Option<&str>,
    ) {
        if let Some(i) = self.current {
            let m = &mut self.messages[i];
            if let MessagePart::Tool {
                call_id: Some(id), ..
            } = &part
            {
                self.calls.insert(id.clone(), (i, m.parts.len()));
                m.mode = Some("tool".into());
            }
            m.parts.push(part);
            if m.model.is_none() {
                m.model = model.map(str::to_owned);
            }
            if m.provider.is_none() {
                m.provider = provider.map(str::to_owned);
            }
        } else {
            self.append(
                id,
                Role::Assistant,
                ts,
                vec![part],
                Some(agent),
                model,
                provider,
            );
        }
    }
    pub fn state(&mut self, id: &str) -> Option<&mut ToolState> {
        let (m, p) = *self.calls.get(id)?;
        if let MessagePart::Tool { state, .. } = &mut self.messages[m].parts[p] {
            Some(state)
        } else {
            None
        }
    }
    pub fn resolve(
        &mut self,
        id: &str,
        parts: Vec<MessagePart>,
        status: &str,
        note: Option<String>,
    ) -> bool {
        if let Some(state) = self.state(id) {
            state.output = Some(serde_json::to_value(parts).unwrap());
            state.status = status.into();
            if let Some(note) = note {
                state.metadata = Some(serde_json::json!({"note":clean(&note)}));
            }
            true
        } else {
            false
        }
    }
    pub fn usage(&mut self, tokens: MessageTokens, model: Option<&str>, cost: Option<f64>) {
        let target = self
            .messages
            .iter()
            .rposition(|m| m.role == Role::Assistant && m.tokens.is_none())
            .or_else(|| {
                self.messages
                    .iter()
                    .rposition(|m| m.role == Role::Assistant && m.model.as_deref() == model)
            });
        let Some(i) = target else { return };
        let m = &mut self.messages[i];
        if let Some(base) = &mut m.tokens {
            for (base, extra) in [
                (&mut base.input, tokens.input),
                (&mut base.output, tokens.output),
                (&mut base.reasoning, tokens.reasoning),
                (&mut base.cache_read, tokens.cache_read),
                (&mut base.cache_create, tokens.cache_create),
            ] {
                if let Some(n) = extra {
                    *base = Some(base.unwrap_or(0.) + n);
                }
            }
            if let Some(cost) = cost {
                m.cost = Some(m.cost.unwrap_or(0.) + cost);
                m.cost_source.get_or_insert(CostSource::Estimated);
            }
        } else {
            m.tokens = Some(tokens);
            if m.model.is_none() {
                m.model = model.map(str::to_owned);
            }
            if let Some(cost) = cost {
                m.cost = Some(cost);
                m.cost_source = Some(CostSource::Estimated);
            }
        }
    }
}
fn clean_value(v: &mut Value) {
    match v {
        Value::String(s) => *s = clean(s),
        Value::Array(a) => a.iter_mut().for_each(clean_value),
        Value::Object(o) => o.values_mut().for_each(clean_value),
        _ => {}
    }
}
#[allow(clippy::too_many_arguments)]
pub fn finish(
    agent: &str,
    id: String,
    directory: String,
    title: String,
    created: f64,
    updated: f64,
    mut stats: SessionStats,
    mut messages: Vec<Message>,
    model_usage: Option<std::collections::BTreeMap<String, f64>>,
) -> SessionDetail {
    for message in &mut messages {
        for part in &mut message.parts {
            if let MessagePart::Tool { state, .. } = part {
                for value in [
                    &mut state.input,
                    &mut state.output,
                    &mut state.error,
                    &mut state.metadata,
                ]
                .into_iter()
                .flatten()
                {
                    clean_value(value);
                }
            }
        }
    }
    stats.message_count = messages.len();
    stats.total_cost = crate::pricing::round_cost(stats.total_cost);
    if stats.total_cost > 0. {
        stats.cost_source = Some(CostSource::Estimated);
    }
    let (project_identity, signature) = crate::projects::path_identity(&directory);
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference: SessionReference {
            agent_name: agent.into(),
            session_id: id,
        },
        title,
        directory,
        display_title: None,
        parent_reference: None,
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats,
        model_usage,
        smart_tags: super::super::smart_tags::classify(&messages),
        smart_tags_source_updated_at: Some(updated),
        smart_tags_classifier_revision: Some("smart-tags-v1".into()),
    };
    let file_activity = super::super::file_activity::summarize(&head, &messages);
    SessionDetail {
        head,
        messages,
        detail_freshness: "fresh".into(),
        message_cursor: None,
        message_update: None,
        file_activity,
    }
}

pub fn affected_directories(
    sessions: &Path,
    changes: &[PathBuf],
    globals: &[PathBuf],
) -> anyhow::Result<Option<Vec<PathBuf>>> {
    let root = std::path::absolute(sessions)?;
    let globals = globals
        .iter()
        .map(std::path::absolute)
        .collect::<std::io::Result<Vec<_>>>()?;
    let mut paths = std::collections::BTreeSet::new();
    for change in changes {
        let change = std::path::absolute(change)?;
        if globals.contains(&change) || root.starts_with(&change) {
            return Ok(None);
        }
        let Ok(relative) = change.strip_prefix(&root) else {
            continue;
        };
        let mut components = relative.components();
        let (Some(bucket), Some(session)) = (components.next(), components.next()) else {
            return Ok(None);
        };
        paths.insert(root.join(bucket).join(session));
    }
    Ok(Some(paths.into_iter().collect()))
}

#[cfg(test)]
pub fn assert_node_golden(session: &super::super::codex::ParsedSession, expected: &str) {
    fn numbers(value: &mut Value) {
        match value {
            Value::Number(number)
                if number
                    .as_f64()
                    .is_some_and(|n| n.fract() == 0. && n.abs() < 9_007_199_254_740_992.) =>
            {
                *number = serde_json::Number::from(number.as_f64().unwrap() as i64)
            }
            Value::Array(values) => values.iter_mut().for_each(numbers),
            Value::Object(values) => values.values_mut().for_each(numbers),
            _ => {}
        }
    }
    let mut actual = serde_json::json!({"head":session.head,"detail":session.detail});
    for name in ["head", "detail"] {
        let value = actual[name].as_object_mut().unwrap();
        for key in [
            "project_identity",
            "project_identity_resolver_revision",
            "project_identity_input_signature",
            "smart_tags",
            "smart_tags_source_updated_at",
            "smart_tags_classifier_revision",
            "detail_freshness",
            "file_activity",
        ] {
            value.remove(key);
        }
        if let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) {
            for message in messages {
                message.as_object_mut().unwrap().remove("time_completed");
            }
        }
    }
    let mut expected: Value = serde_json::from_str(expected).unwrap();
    numbers(&mut actual);
    numbers(&mut expected);
    assert_eq!(actual, expected);
}
