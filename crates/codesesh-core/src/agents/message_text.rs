use regex::Regex;
use std::sync::LazyLock;

pub(super) fn strip_tags(value: &str) -> String {
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
    value
}
