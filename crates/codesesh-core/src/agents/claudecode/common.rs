use crate::{contract::*, projects::path_identity};
use regex::Regex;
use serde_json::Value;
use std::{collections::BTreeMap, path::Path, sync::LazyLock};

pub fn text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(a) => a.iter().map(text).collect::<Vec<_>>().join(","),
        _ => value.to_string(),
    }
}

pub fn clean(value: &str) -> String {
    static BLOCKS: LazyLock<Vec<(Regex, Regex, Regex)>> = LazyLock::new(|| {
        [
            "command-message",
            "command-name",
            "local-command-caveat",
            "local-command-stdout",
            "system-reminder",
        ]
        .iter()
        .map(|tag| {
            (
                Regex::new(&format!(
                    r"(?is)(^|\r?\n)[ \t]*<{tag}\b[^>]*>.*?</{tag}>[ \t]*(?:\r?\n|$)"
                ))
                .unwrap(),
                Regex::new(&format!(r"(?is)<{tag}\b[^>]*>.*?</{tag}>")).unwrap(),
                Regex::new(&format!(r"(?is)\n*<{tag}\b[^>]*>.*$")).unwrap(),
            )
        })
        .collect()
    });
    static TAGS: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)</?(?:command-message|command-name|local-command-caveat|local-command-stdout|system-reminder|command-args)\b[^>]*>").unwrap()
    });
    let mut value = value.to_owned();
    if value.contains('<') && TAGS.is_match(&value) {
        for (line, block, open) in BLOCKS.iter() {
            for (pattern, replacement) in [(line, "$1"), (block, ""), (open, "")] {
                if let std::borrow::Cow::Owned(updated) = pattern.replace_all(&value, replacement) {
                    value = updated;
                }
            }
        }
        if let std::borrow::Cow::Owned(updated) = TAGS.replace_all(&value, "") {
            value = updated;
        }
    }
    let mut output = String::with_capacity(value.len());
    for (index, line) in value.split('\n').enumerate() {
        if index > 0 {
            output.push('\n');
        }
        if let Some(line) = line.strip_suffix('\r') {
            output.push_str(line.trim_end_matches([' ', '\t']));
            output.push('\r');
        } else {
            output.push_str(line.trim_end_matches([' ', '\t']));
        }
    }
    if output.trim().is_empty() {
        output.clear();
    } else {
        output.truncate(output.trim_end_matches(['\r', '\n']).len());
    }
    output
}

pub fn title(value: &str) -> Option<String> {
    let clean = clean(value);
    let first = clean.lines().find(|line| !line.trim().is_empty())?;
    let normalized = first.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(String::from_utf16_lossy(
        &normalized.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
}

pub fn message(id: String, role: Role, time: f64, parts: Vec<MessagePart>) -> Message {
    Message {
        id,
        role,
        agent: None,
        time_created: time,
        time_completed: None,
        mode: None,
        model: None,
        provider: None,
        tokens: None,
        cost: Some(0.0),
        cost_source: None,
        parts,
        subagent_id: None,
        nickname: None,
        automated: None,
    }
}

pub fn text_part(value: &str, time: f64) -> Option<MessagePart> {
    let text = clean(value);
    (!text.is_empty()).then_some(MessagePart::Text {
        text,
        time_created: Some(time),
    })
}

fn clean_value(value: &mut Value) {
    match value {
        Value::String(s) => *s = clean(s),
        Value::Array(a) => a.iter_mut().for_each(clean_value),
        Value::Object(o) => o.values_mut().for_each(clean_value),
        _ => {}
    }
}

pub fn finish_messages(messages: &mut Vec<Message>) {
    for message in messages.iter_mut() {
        message.parts.retain_mut(|part| match part {
            MessagePart::Text { text, .. }
            | MessagePart::Reasoning { text, .. }
            | MessagePart::Plan { text, .. } => {
                *text = clean(text);
                !text.is_empty()
            }
            MessagePart::Tool { title, state, .. } => {
                *title = title.as_ref().map(|t| clean(t)).filter(|t| !t.is_empty());
                for v in [
                    &mut state.input,
                    &mut state.output,
                    &mut state.error,
                    &mut state.metadata,
                ]
                .into_iter()
                .flatten()
                {
                    clean_value(v);
                }
                true
            }
            _ => true,
        });
    }
    messages.retain(|m| {
        !m.parts.is_empty()
            || m.cost.unwrap_or(0.0) > 0.0
            || m.tokens.as_ref().is_some_and(|t| {
                [t.input, t.output, t.reasoning, t.cache_read, t.cache_create]
                    .into_iter()
                    .flatten()
                    .any(|v| v > 0.0)
            })
    });
}

pub fn stats(messages: &[Message]) -> SessionStats {
    let mut stats = SessionStats {
        message_count: messages.len(),
        ..Default::default()
    };
    let (mut read, mut create) = (0.0, 0.0);
    let mut estimated = false;
    for m in messages {
        if let Some(t) = &m.tokens {
            stats.total_input_tokens += t.input.unwrap_or(0.0);
            stats.total_output_tokens += t.output.unwrap_or(0.0);
            read += t.cache_read.unwrap_or(0.0);
            create += t.cache_create.unwrap_or(0.0);
        }
        stats.total_cost += m.cost.unwrap_or(0.0);
        estimated |= m.cost_source == Some(CostSource::Estimated);
    }
    stats.total_cache_read_tokens = (read != 0.0).then_some(read);
    stats.total_cache_create_tokens = (create != 0.0).then_some(create);
    stats.cost_source = (stats.total_cost > 0.0).then_some(if estimated {
        CostSource::Estimated
    } else {
        CostSource::Recorded
    });
    stats
}

pub fn detail(
    reference: SessionReference,
    directory: String,
    title: String,
    created: f64,
    updated: f64,
    messages: Vec<Message>,
    models: BTreeMap<String, f64>,
) -> SessionDetail {
    let (project_identity, signature) = path_identity(&directory);
    let head = SessionHead {
        version: None,
        summary_files: None,
        reference,
        title,
        directory,
        display_title: None,
        parent_reference: None,
        project_identity,
        project_identity_resolver_revision: Some("project-identity-v2".into()),
        project_identity_input_signature: Some(signature),
        time_created: created,
        time_updated: updated,
        stats: stats(&messages),
        model_usage: (!models.is_empty()).then_some(models),
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

pub fn mtime(path: &Path) -> anyhow::Result<f64> {
    Ok(crate::time::file_mtime_ms(path)?)
}

#[cfg(test)]
pub fn assert_reference(head: &SessionHead, detail: &SessionDetail, expected: &str) {
    let expected: Value = serde_json::from_str(expected).unwrap();
    for (actual, key) in [(head, "head"), (&detail.head, "detail")] {
        let wanted = &expected[key];
        assert_eq!(
            actual.reference,
            serde_json::from_value(wanted["reference"].clone()).unwrap()
        );
        assert_eq!(actual.title, wanted["title"].as_str().unwrap());
        assert_eq!(actual.directory, wanted["directory"].as_str().unwrap());
        assert_eq!(
            actual.time_created,
            wanted["time_created"].as_f64().unwrap()
        );
        assert_eq!(
            actual.time_updated,
            wanted["time_updated"].as_f64().unwrap()
        );
        assert_eq!(
            actual.stats,
            serde_json::from_value(wanted["stats"].clone()).unwrap()
        );
    }
    assert_eq!(
        head.model_usage,
        serde_json::from_value(expected["head"]["model_usage"].clone()).unwrap()
    );
    let messages: Vec<Message> =
        serde_json::from_value(expected["detail"]["messages"].clone()).unwrap();
    fn json_numbers(value: &mut Value) {
        match value {
            Value::Number(number) => {
                *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap()
            }
            Value::Array(values) => values.iter_mut().for_each(json_numbers),
            Value::Object(values) => values.values_mut().for_each(json_numbers),
            _ => {}
        }
    }
    let mut actual = serde_json::to_value(&detail.messages).unwrap();
    let mut expected = serde_json::to_value(messages).unwrap();
    json_numbers(&mut actual);
    json_numbers(&mut expected);
    assert_eq!(actual, expected);
}

#[derive(Debug)]
pub struct InvalidSession(pub &'static str);
impl std::fmt::Display for InvalidSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for InvalidSession {}

pub fn changed_sources(
    root: &Path,
    changed: &[std::path::PathBuf],
    previous: &[crate::agents::SessionRecord],
) -> anyhow::Result<std::collections::BTreeSet<std::path::PathBuf>> {
    let mut selected = std::collections::BTreeSet::new();
    for path in changed {
        if !path.starts_with(root) && !root.starts_with(path) {
            continue;
        }
        let path = if root.starts_with(path) {
            root
        } else {
            path.as_path()
        };
        for old in previous.iter().filter(|old| old.source.starts_with(path)) {
            selected.insert(old.source.clone());
        }
        match std::fs::metadata(path) {
            Ok(meta) if meta.is_dir() => {
                for entry in walkdir::WalkDir::new(path).follow_links(false) {
                    let entry = entry?;
                    if entry.file_type().is_file()
                        && entry.path().extension().is_some_and(|e| e == "jsonl")
                    {
                        selected.insert(entry.into_path());
                    }
                }
            }
            Ok(_) if path.extension().is_some_and(|e| e == "jsonl") => {
                selected.insert(path.to_owned());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if path.extension().is_some_and(|e| e == "jsonl") {
                    selected.insert(path.to_owned());
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(selected)
}
