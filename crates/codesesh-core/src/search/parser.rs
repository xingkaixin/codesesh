use super::SearchOptions;

#[derive(Clone, Debug)]
pub struct ParsedQuery {
    pub text: String,
    pub filters: SearchOptions,
    pub has_qualifiers: bool,
}

pub fn split_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    for ch in input.chars() {
        if ch == '"' {
            quoted = !quoted;
        }
        if (matches!(
            ch,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )) && !quoted
        {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
        } else {
            token.push(ch);
        }
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

pub fn unwrap_value(value: &str) -> &str {
    let value = value.trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        value[1..value.len() - 1].trim()
    } else {
        value
    }
}

pub fn parse_query(input: &str) -> ParsedQuery {
    let mut filters = SearchOptions::default();
    let mut text = Vec::new();
    let mut has_qualifiers = false;
    for token in split_tokens(input) {
        let Some((key, raw)) = token.split_once(':') else {
            text.push(token);
            continue;
        };
        if raw.is_empty()
            || !key.starts_with(|c: char| c.is_ascii_alphabetic())
            || !key
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '_' || c == '-')
        {
            text.push(token);
            continue;
        }
        let value = unwrap_value(raw);
        if value.is_empty() {
            continue;
        }
        let mut consumed = true;
        match key.to_ascii_lowercase().as_str() {
            "agent" => filters.agent = Some(value.to_lowercase()),
            "project" => filters.project = Some(value.into()),
            "projectkey" | "project-key" => filters.project_key = Some(value.into()),
            "projectkind" | "project-kind"
                if [
                    "git_remote",
                    "git_common_dir",
                    "manifest_path",
                    "synthetic",
                    "path",
                    "loose",
                ]
                .contains(&value) =>
            {
                filters.project_kind = Some(value.into())
            }
            "cwd" => filters.cwd = Some(value.into()),
            "tool" => unique(&mut filters.tools, value.to_lowercase()),
            "file" | "path" => filters.file = Some(value.into()),
            "kind" | "filekind" | "file-kind"
                if ["read", "edit", "write", "delete"].contains(&value) =>
            {
                filters.file_kind = Some(value.into())
            }
            "tag" | "signal"
                if [
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
                .contains(&value.to_lowercase().as_str()) =>
            {
                unique(&mut filters.tags, value.to_lowercase())
            }
            "cost" => parse_cost(value, &mut filters),
            _ => consumed = false,
        }
        if consumed {
            has_qualifiers = true;
        } else {
            text.push(token);
        }
    }
    ParsedQuery {
        text: text.join(" ").trim().into(),
        filters,
        has_qualifiers,
    }
}

fn unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn decimal(value: &str) -> Option<f64> {
    if value.is_empty()
        || !value.chars().all(|c| c.is_ascii_digit() || c == '.')
        || value.starts_with('.')
        || value.ends_with('.')
    {
        return None;
    }
    value.parse().ok()
}

fn parse_cost(value: &str, filters: &mut SearchOptions) {
    if let Some((low, high)) = value.split_once("..")
        && let (Some(low), Some(high)) = (decimal(low), decimal(high))
    {
        filters.cost_min = Some(low);
        filters.cost_max = Some(high);
        filters.cost_min_exclusive = false;
        filters.cost_max_exclusive = false;
        return;
    }
    for prefix in [">=", ">", "<=", "<"] {
        if let Some(amount) = value.strip_prefix(prefix).and_then(decimal) {
            if prefix.starts_with('>') {
                filters.cost_min = Some(amount);
                filters.cost_min_exclusive = prefix == ">";
            } else {
                filters.cost_max = Some(amount);
                filters.cost_max_exclusive = prefix == "<";
            }
            return;
        }
    }
    let number = value.parse::<f64>().ok().or_else(|| {
        for (prefix, radix) in [
            ("0x", 16),
            ("0X", 16),
            ("0b", 2),
            ("0B", 2),
            ("0o", 8),
            ("0O", 8),
        ] {
            if let Some(digits) = value.strip_prefix(prefix) {
                return u64::from_str_radix(digits, radix).ok().map(|n| n as f64);
            }
        }
        None
    });
    if let Some(amount) = number.filter(|n| {
        !n.is_nan() && (n.is_finite() || matches!(value, "Infinity" | "+Infinity" | "-Infinity"))
    }) {
        filters.cost_min = Some(amount);
        filters.cost_max = Some(amount);
        filters.cost_min_exclusive = false;
        filters.cost_max_exclusive = false;
    }
}

pub fn to_fts_query(input: &str) -> String {
    let tokens: Vec<String> = split_tokens(input)
        .into_iter()
        .map(|token| {
            if token.eq_ignore_ascii_case("OR") {
                "OR".into()
            } else {
                let text = if token.len() >= 2 && token.starts_with('"') && token.ends_with('"') {
                    &token[1..token.len() - 1]
                } else {
                    &token
                };
                format!("\"{}\"", text.replace('"', "\"\""))
            }
        })
        .collect();
    tokens
        .iter()
        .enumerate()
        .filter(|(i, token)| {
            token.as_str() != "OR"
                || (*i > 0
                    && *i + 1 < tokens.len()
                    && tokens[*i - 1] != "OR"
                    && tokens[*i + 1] != "OR")
        })
        .map(|(_, token)| token.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn merge(query: &str, options: &SearchOptions) -> (ParsedQuery, SearchOptions) {
    let parsed = parse_query(query);
    let mut merged = options.clone();
    macro_rules! fallback { ($($field:ident),*) => { $(if merged.$field.is_none() { merged.$field = parsed.filters.$field.clone(); })* }; }
    fallback!(
        agent,
        project,
        project_kind,
        project_key,
        file,
        file_kind,
        cwd
    );
    for value in &parsed.filters.tags {
        unique(&mut merged.tags, value.clone());
    }
    for value in &parsed.filters.tools {
        unique(&mut merged.tools, value.clone());
    }
    if merged.cost_min.is_none() {
        merged.cost_min = parsed.filters.cost_min;
        merged.cost_min_exclusive = parsed.filters.cost_min_exclusive;
    }
    if merged.cost_max.is_none() {
        merged.cost_max = parsed.filters.cost_max;
        merged.cost_max_exclusive = parsed.filters.cost_max_exclusive;
    }
    (parsed, merged)
}
