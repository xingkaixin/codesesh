use super::HighlightRange;
use super::parser::{split_tokens, unwrap_value};

#[derive(Clone)]
pub struct Terms {
    pub values: Vec<String>,
    pub any: bool,
    patterns: Vec<regex::Regex>,
}
impl Terms {
    pub fn parse(query: &str) -> Self {
        let tokens = split_tokens(query);
        let values: Vec<String> = tokens
            .iter()
            .filter(|t| !t.eq_ignore_ascii_case("OR"))
            .map(|t| unwrap_value(t).to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let mut seen = std::collections::HashSet::new();
        let patterns = values
            .iter()
            .filter(|term| seen.insert(term.as_str()))
            .filter_map(|term| {
                regex::RegexBuilder::new(&regex::escape(term))
                    .case_insensitive(true)
                    .build()
                    .ok()
            })
            .collect();
        Self {
            any: tokens.iter().any(|t| t.eq_ignore_ascii_case("OR")),
            values,
            patterns,
        }
    }
    pub fn matches(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        if self.values.is_empty() {
            true
        } else if self.any {
            self.values.iter().any(|t| lower.contains(t))
        } else {
            self.values.iter().all(|t| lower.contains(t))
        }
    }
}

pub fn highlights(text: &str, terms: &Terms) -> Vec<HighlightRange> {
    let mut ranges = Vec::new();
    for pattern in &terms.patterns {
        for hit in pattern.find_iter(text) {
            ranges.push(HighlightRange {
                start: text[..hit.start()].encode_utf16().count(),
                end: text[..hit.end()].encode_utf16().count(),
            });
        }
    }
    ranges.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut merged: Vec<HighlightRange> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut().filter(|last| range.start <= last.end) {
            last.end = last.end.max(range.end);
        } else {
            merged.push(range);
        }
    }
    merged
}

pub fn build(text: &str, terms: &Terms) -> (String, Vec<HighlightRange>) {
    let lower = text.to_lowercase();
    let term = terms
        .values
        .iter()
        .find(|t| lower.contains(t.as_str()))
        .or(terms.values.first());
    let units: Vec<u16> = text.encode_utf16().collect();
    let Some(term) = term else {
        return (
            String::from_utf16_lossy(&units[..units.len().min(180)]),
            Vec::new(),
        );
    };
    let index = lower
        .find(term)
        .map(|i| lower[..i].encode_utf16().count() as isize)
        .unwrap_or(-1);
    let start = (index - 80).max(0) as usize;
    let end = units
        .len()
        .min((index + term.encode_utf16().count() as isize + 80).max(0) as usize);
    let snippet = format!(
        "{}{}{}",
        if start > 0 { "… " } else { "" },
        String::from_utf16_lossy(&units[start.min(end)..end]),
        if end < units.len() { " …" } else { "" }
    );
    let ranges = highlights(&snippet, terms);
    (snippet, ranges)
}
