use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    let tags = [
        "command-message",
        "command-name",
        "local-command-caveat",
        "local-command-stdout",
        "system-reminder",
    ];
    let mut result = Vec::new();
    for tag in tags {
        result.push((
            Regex::new(&format!(
                r"(?i)(^|\r?\n)[ \t]*<{tag}(?-u:\b)[^>]*>(?s:.*?)</{tag}>[ \t]*(?:\r?\n|$)"
            ))
            .unwrap(),
            "$1",
        ));
        result.push((
            Regex::new(&format!(r"(?i)<{tag}(?-u:\b)[^>]*>(?s:.*?)</{tag}>")).unwrap(),
            "",
        ));
        result.push((
            Regex::new(&format!(r"(?i)\n*<{tag}(?-u:\b)[^>]*>(?s:.*)$")).unwrap(),
            "",
        ));
    }
    for tag in tags.into_iter().chain(["command-args"]) {
        result.push((
            Regex::new(&format!(r"(?i)</?{tag}(?-u:\b)[^>]*>")).unwrap(),
            "",
        ));
    }
    result
});
pub(super) fn clean(text: &str) -> String {
    let mut text = text.to_owned();
    for (regex, replacement) in PATTERNS.iter() {
        text = regex.replace_all(&text, *replacement).into_owned();
    }
    let mut output = String::new();
    for line in text.split_inclusive('\n') {
        let newline = line.ends_with('\n');
        let line = if newline {
            &line[..line.len() - 1]
        } else {
            line
        };
        let cr = newline && line.ends_with('\r');
        let line = if cr { &line[..line.len() - 1] } else { line };
        output.push_str(line.trim_end_matches([' ', '\t']));
        if cr {
            output.push('\r');
        }
        if newline {
            output.push('\n');
        }
    }
    while output.ends_with('\n') {
        output.pop();
        if output.ends_with('\r') {
            output.pop();
        }
    }
    if output.trim().is_empty() {
        String::new()
    } else {
        output
    }
}
pub(super) fn clean_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(clean(&s)),
        Value::Array(v) => Value::Array(v.into_iter().map(clean_value).collect()),
        Value::Object(v) => {
            Value::Object(v.into_iter().map(|(k, v)| (k, clean_value(v))).collect())
        }
        value => value,
    }
}
pub(super) fn title(text: &str) -> Option<String> {
    let text = clean(text);
    let line = text.lines().find(|s| !s.trim().is_empty())?;
    let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(String::from_utf16_lossy(
        &normalized.encode_utf16().take(100).collect::<Vec<_>>(),
    ))
}
pub(super) fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        _ => value.to_string(),
    }
}
