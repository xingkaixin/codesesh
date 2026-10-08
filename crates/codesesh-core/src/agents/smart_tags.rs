use crate::contract::{Message, MessagePart, Role};
use regex::{Regex, RegexSet};
use serde_json::Value;
use std::sync::LazyLock;

fn rule(source: &str) -> String {
    format!("(?i){}", source.replace(r"\b", r"(?-u:\b)"))
}
fn pattern(source: &str) -> Regex {
    Regex::new(&rule(source)).unwrap()
}
static USER_RULES: LazyLock<Vec<(usize, Regex)>> = LazyLock::new(|| {
    vec![
        (
            0,
            pattern(
                r"\b(fix|bug|error|crash|exception|fail(?:ed|ure)?)\b|修复|错误|报错|崩溃|异常",
            ),
        ),
        (
            1,
            pattern(r"\b(refactor|rename|simplify|clean up|cleanup)\b|重构|重命名|简化|清理"),
        ),
        (
            2,
            pattern(r"\b(add|create|implement|new|support|build)\b|新增|创建|实现|增加|开发|支持"),
        ),
        (
            4,
            pattern(r"\b(document|documentation|readme|docs?)\b|文档|说明"),
        ),
    ]
});
// Testing, git and build-deploy tags, matched in one pass over each tool payload.
static PAYLOAD_RULES: LazyLock<RegexSet> = LazyLock::new(|| {
    RegexSet::new(
        [
            r"\b(pytest|vitest|jest|mocha|pnpm\s+test|npm\s+test|yarn\s+test)\b",
            r"\bgit\s+(push|commit|merge|branch|checkout|switch|rebase|tag)\b",
            r"\b((npm|pnpm|yarn|bun)\s+(run\s+)?build|docker|pm2|deploy|vercel|netlify)\b",
        ]
        .map(rule),
    )
    .unwrap()
});
static READ: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\b(read|grep|glob|websearch|web_search|search|find|rg)\b"));
static EDIT: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\b(edit|write|apply_patch|patch|multiedit|notebookedit)\b"));
static PLAN: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\b(enterplanmode|taskcreate|update_plan|plan)\b"));
static DOC: LazyLock<Regex> = LazyLock::new(|| pattern(r"\.(md|mdx|txt|rst|adoc)$"));

fn doc_path(value: &Value) -> bool {
    match value {
        Value::String(text) => DOC.is_match(text),
        Value::Array(values) => values.iter().any(doc_path),
        Value::Object(values) => values.values().any(doc_path),
        _ => false,
    }
}

pub fn classify(messages: &[Message]) -> Vec<String> {
    let mut tags = [false; 9];
    let mut reads = 0;
    let mut edits = 0;
    for message in messages {
        if message.role == Role::User {
            let text = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    MessagePart::Text { text, .. }
                    | MessagePart::Reasoning { text, .. }
                    | MessagePart::Plan { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            for (tag, rule) in USER_RULES.iter() {
                tags[*tag] |= rule.is_match(&text);
            }
        }
        for part in &message.parts {
            if matches!(part, MessagePart::Plan { .. }) {
                tags[8] = true;
            }
            if let MessagePart::Tool {
                tool, title, state, ..
            } = part
            {
                let name = format!("{tool} {}", title.as_deref().unwrap_or(""));
                tags[8] |= PLAN.is_match(&name);
                reads += usize::from(READ.is_match(&name));
                edits += usize::from(EDIT.is_match(&name));
                // Tool states hold full outputs; skip serializing them once every payload tag is set.
                if !(tags[3] && tags[5] && tags[6]) {
                    let payload = format!("{name}\n{}", serde_json::to_string(state).unwrap());
                    let matched = PAYLOAD_RULES.matches(&payload);
                    for (rule, tag) in [3, 5, 6].into_iter().enumerate() {
                        tags[tag] |= matched.matched(rule);
                    }
                }
                tags[4] = tags[4] || state.input.as_ref().is_some_and(doc_path);
            }
        }
    }
    tags[7] = reads >= 3 && edits <= 1;
    [
        "bugfix",
        "refactoring",
        "feature-dev",
        "testing",
        "docs",
        "git-ops",
        "build-deploy",
        "exploration",
        "planning",
    ]
    .into_iter()
    .enumerate()
    .filter(|(i, _)| tags[*i])
    .map(|(_, tag)| tag.into())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_payloads_set_their_own_tags() {
        for (command, tag) in [
            ("pnpm test", "testing"),
            ("git push origin main", "git-ops"),
            ("docker compose up", "build-deploy"),
        ] {
            let message: Message = serde_json::from_value(serde_json::json!({
                "id": "m",
                "role": "assistant",
                "time_created": 1,
                "parts": [{"type": "tool", "tool": "exec_command", "state": {"status": "completed", "input": {"cmd": command}}}],
            }))
            .unwrap();
            assert_eq!(classify(&[message]), [tag], "{command}");
        }
    }
}
