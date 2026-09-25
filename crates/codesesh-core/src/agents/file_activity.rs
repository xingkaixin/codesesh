use crate::contract::{Message, MessagePart, SessionFileActivity, SessionHead};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};

fn kind(tool: &str) -> Option<&'static str> {
    match tool.trim().to_lowercase().as_str() {
        "read" | "read_file" | "read_file_v2" | "read_text_file" | "readfile" | "view_image" => {
            Some("read")
        }
        "apply_patch" | "edit" | "edit_file" | "edit_file_v2" | "editfile" | "multiedit"
        | "notebookedit" | "patch" | "search_replace" | "str_replace" => Some("edit"),
        "create_file" | "write" | "write_file" | "writefile" => Some("write"),
        "delete" | "delete_file" => Some("delete"),
        _ => None,
    }
}
fn path_key(key: &str) -> bool {
    let key = key.trim().to_lowercase();
    ![
        "command",
        "content",
        "text",
        "prompt",
        "url",
        "body",
        "title",
        "description",
    ]
    .iter()
    .any(|excluded| key.contains(excluded))
        && !matches!(key.as_str(), "cwd" | "workdir" | "directory")
        && (key.contains("file") || key.contains("path"))
}
fn file_path(text: &str) -> bool {
    let text = text.trim();
    static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z]+://").unwrap());
    static FILE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.@-]+\.[A-Za-z0-9_-]+$").unwrap());
    !text.is_empty()
        && text.encode_utf16().count() <= 300
        && !text.contains(['\n', '<', '>', '{', '}'])
        && !URL.is_match(text)
        && (text.contains(['/', '\\']) || FILE.is_match(text))
}
fn paths(
    value: &Value,
    key: &str,
    depth: usize,
    output: &mut Vec<String>,
    seen: &mut HashSet<String>,
) {
    if depth > 4 {
        return;
    }
    match value {
        Value::String(text) if path_key(key) && file_path(text) => {
            let text = text.trim().to_owned();
            if seen.insert(text.clone()) {
                output.push(text);
            }
        }
        Value::Array(values) => {
            for value in values {
                paths(value, key, depth + 1, output, seen);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                paths(value, key, depth + 1, output, seen);
            }
        }
        _ => {}
    }
}
fn operations(tool: &str, input: &Value) -> Vec<(String, String)> {
    let entries = input.as_array().or_else(|| input["content"].as_array());
    let patch = entries
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let kind = match entry["type"].as_str()? {
                "edit_file" | "update_file" | "move_file" => "edit",
                "write_file" => "write",
                "delete_file" => "delete",
                _ => return None,
            };
            let path = entry["path"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| entry["old_path"].as_str())?
                .trim();
            (!path.is_empty()).then(|| (kind.to_owned(), path.to_owned()))
        })
        .collect::<Vec<_>>();
    if !patch.is_empty() {
        return patch;
    }
    let Some(kind) = kind(tool) else {
        return Vec::new();
    };
    let mut collected = Vec::new();
    paths(input, "", 0, &mut collected, &mut HashSet::new());
    collected
        .into_iter()
        .map(|path| (kind.into(), path))
        .collect()
}

pub fn summarize(head: &SessionHead, messages: &[Message]) -> Vec<SessionFileActivity> {
    let mut activities = Vec::<SessionFileActivity>::new();
    let mut indexes = HashMap::new();
    for message in messages {
        for part in &message.parts {
            if let MessagePart::Tool {
                tool,
                state,
                time_created,
                ..
            } = part
                && let Some(input) = &state.input
            {
                for (kind, path) in operations(tool, input) {
                    let index = *indexes
                        .entry((kind.clone(), path.clone()))
                        .or_insert_with(|| {
                            activities.push(SessionFileActivity {
                                reference: head.reference.clone(),
                                project_identity_key: head.project_identity.key.clone(),
                                path,
                                kind,
                                count: 0,
                                latest_time: time_created.unwrap_or(message.time_created),
                            });
                            activities.len() - 1
                        });
                    let activity = &mut activities[index];
                    activity.count += 1;
                    activity.latest_time = activity
                        .latest_time
                        .max(time_created.unwrap_or(message.time_created));
                }
            }
        }
    }
    activities.sort_by(|a, b| {
        b.latest_time
            .total_cmp(&a.latest_time)
            .then_with(|| crate::locale::compare(&a.path, &b.path))
    });
    activities
}
