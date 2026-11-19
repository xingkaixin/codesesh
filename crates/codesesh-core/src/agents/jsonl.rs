use chrono::DateTime;
use regex::Regex;
use serde_json::Value;
use std::{
    io::{self, BufRead, BufReader, Read},
    sync::LazyLock,
};

#[derive(Default)]
pub(crate) struct CachedSources<'a> {
    pub(crate) paths: std::collections::HashSet<&'a std::path::Path>,
    pub(crate) damaged: Option<std::cell::RefCell<std::collections::HashSet<String>>>,
}

impl CachedSources<'_> {
    pub(super) fn reject_invalid(&self, session_id: &str, cached: bool) -> bool {
        if let Some(damaged) = &self.damaged {
            damaged.borrow_mut().insert(session_id.to_owned());
            false
        } else {
            cached
        }
    }
}

pub(super) fn records(
    path: &std::path::Path,
    reject_invalid: impl Fn() -> bool,
) -> anyhow::Result<impl Iterator<Item = anyhow::Result<Value>>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => Some(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    Ok(file
        .into_iter()
        .flat_map(|f| BufReader::new(f).split(b'\n'))
        .filter_map(move |line| {
            let bytes = match line {
                Ok(bytes) => bytes,
                Err(error) => return Some(Err(error.into())),
            };
            if bytes.iter().all(u8::is_ascii_whitespace) {
                return None;
            }
            match serde_json::from_str(&String::from_utf8_lossy(&bytes)) {
                Ok(value) => Some(Ok(value)),
                Err(error) if reject_invalid() => Some(Err(error.into())),
                Err(_) => None,
            }
        }))
}

pub(super) struct JsonLines<R> {
    reader: BufReader<R>,
    line: String,
}

impl<R: Read> JsonLines<R> {
    pub(super) fn new(reader: R) -> Self {
        Self {
            reader: BufReader::with_capacity(64 * 1024, reader),
            line: String::new(),
        }
    }

    pub(super) fn next_line(&mut self) -> io::Result<Option<&str>> {
        if self.line.capacity() > 1024 * 1024 {
            self.line = String::new();
        } else {
            self.line.clear();
        }
        if read_line(&mut self.reader, &mut self.line)? == 0 {
            return Ok(None);
        }
        Ok(Some(&self.line))
    }
}

/// `BufRead::read_line` that replaces invalid UTF-8 instead of failing the whole source.
/// The count is in source bytes, which can differ from the replaced line's length.
pub(super) fn read_line(reader: &mut impl BufRead, line: &mut String) -> io::Result<usize> {
    let mut bytes = std::mem::take(line).into_bytes();
    let read = reader.read_until(b'\n', &mut bytes)?;
    *line = String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    Ok(read)
}

/// `read_line` that also records up to `tail_limit` trailing raw source bytes for complete lines.
pub(super) fn read_line_with_tail(
    reader: &mut impl BufRead,
    line: &mut String,
    tail: &mut Vec<u8>,
    tail_limit: usize,
) -> io::Result<usize> {
    let mut bytes = std::mem::take(line).into_bytes();
    let read = reader.read_until(b'\n', &mut bytes)?;
    if read > 0 && bytes.ends_with(b"\n") {
        let start = bytes.len().saturating_sub(tail_limit);
        tail.clear();
        tail.extend_from_slice(&bytes[start..]);
    }
    *line = String::from_utf8(bytes)
        .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned());
    Ok(read)
}

pub(crate) const ACTIVE_WINDOW: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Parser checkpoints only pay off for transcripts that are still being appended to.
pub(super) fn recently_written(metadata: &std::fs::Metadata) -> bool {
    match metadata.modified().map(|time| time.elapsed()) {
        Ok(Ok(age)) => age < ACTIVE_WINDOW,
        // An unknown or future mtime gives no evidence that the file is idle.
        _ => true,
    }
}

pub(super) fn timestamp(record: &Value) -> f64 {
    if let Some(value) = record["timestamp"].as_f64() {
        return value;
    }
    let Some(value) = record["timestamp"].as_str() else {
        return 0.0;
    };
    let mut value = value.trim().replacen(' ', "T", 1);
    static SUFFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)(?:Z|[+-]\d{2}:?\d{2})$").unwrap());
    if !SUFFIX.is_match(&value) {
        value.push('Z');
    }
    DateTime::parse_from_rfc3339(&value)
        .or_else(|_| DateTime::parse_from_str(&value, "%Y-%m-%dT%H:%M:%S%.f%z"))
        .map(|date| date.timestamp_millis() as f64)
        .unwrap_or(0.0)
}
