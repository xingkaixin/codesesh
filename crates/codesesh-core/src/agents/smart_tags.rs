use crate::contract::{Message, MessagePart, Role};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

fn pattern(source: &str) -> Regex {
    Regex::new(&format!("(?i){}", source.replace(r"\b", r"(?-u:\b)"))).unwrap()
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
static TESTING: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\b(pytest|vitest|jest|mocha|pnpm\s+test|npm\s+test|yarn\s+test)\b"));
static GIT: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"\bgit\s+(push|commit|merge|branch|checkout|switch|rebase|tag)\b"));
static BUILD: LazyLock<Regex> = LazyLock::new(|| {
    pattern(r"\b((npm|pnpm|yarn|bun)\s+(run\s+)?build|docker|pm2|deploy|vercel|netlify)\b")
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
                let payload = format!("{name}\n{}", serde_json::to_string(state).unwrap());
                tags[8] |= PLAN.is_match(&name);
                reads += usize::from(READ.is_match(&name));
                edits += usize::from(EDIT.is_match(&name));
                tags[3] |= TESTING.is_match(&payload);
                tags[5] |= GIT.is_match(&payload);
                tags[6] |= BUILD.is_match(&payload);
                tags[4] |= state.input.as_ref().is_some_and(doc_path);
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
