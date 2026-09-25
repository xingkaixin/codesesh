use super::{Level, LogContext};
use hmac::{Hmac, Mac};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::Sha256;
use std::{path::PathBuf, sync::LazyLock};

static KEY: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
});
static CAMEL: LazyLock<Regex> = LazyLock::new(|| Regex::new("([a-z0-9])([A-Z])").unwrap());
static NON_KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-zA-Z0-9]+").unwrap());
static FINGERPRINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^(?:error_message|field|identifier|path|string|url):[a-f0-9]{16}$").unwrap()
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bBearer\s+[^\s,;]+").unwrap());
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b").unwrap());
static INCOMPLETE_JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\beyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*){0,2}$").unwrap());
static SECRET_QUERY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)([?&](?:access_token|api_key|apikey|password|secret|token)=)[^&#\s]*").unwrap()
});
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)")
        .unwrap()
});

pub(super) struct Encoder {
    run_id: String,
    max_bytes: usize,
    prefixes: Vec<(String, String)>,
}
struct Budget {
    values: usize,
    characters: usize,
}
fn normalized(key: &str) -> String {
    NON_KEY
        .replace_all(&CAMEL.replace_all(key.trim(), "${1}_${2}"), "_")
        .to_ascii_lowercase()
}
fn suffix(key: &str, values: &[&str]) -> bool {
    values
        .iter()
        .any(|v| key == *v || key.strip_suffix(v).is_some_and(|p| p.ends_with('_')))
}
fn bounded(value: &str, max: usize) -> String {
    String::from_utf16_lossy(&value.encode_utf16().take(max).collect::<Vec<_>>())
}
fn correlated(key: &str) -> bool {
    matches!(
        key,
        "request_id" | "operation_id" | "publication_id" | "connection_id"
    )
}
fn audited(key: &str, value: &str) -> bool {
    match key {
        "agent" | "agent_name" | "agents" | "failed_agents" => matches!(
            value,
            "claudecode"
                | "cursor"
                | "kimi"
                | "kimi-code"
                | "codex"
                | "grok"
                | "pi"
                | "opencode"
                | "zcode"
                | "minimax-code"
                | "dsh"
                | "deepchat"
                | "cherrystudio"
        ),
        "method" => matches!(
            value,
            "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT"
        ),
        "mode" => matches!(
            value,
            "agent"
                | "bulk"
                | "incremental"
                | "invalidRoute"
                | "missingAgent"
                | "project"
                | "projects"
                | "root"
                | "session"
        ),
        "phase" => matches!(value, "measure" | "mount" | "nested-update" | "update"),
        "profiler_id" => matches!(
            value,
            "App"
                | "InteractiveReceipt"
                | "MainContent"
                | "MessageList"
                | "OverviewScreen"
                | "SearchControls"
                | "SearchResultsPanel"
                | "SessionDetail"
                | "SessionTreeSidebar"
        ),
        "source" => matches!(value, "commit-latency" | "custom-timing" | "react-profiler"),
        "trigger" => value == "route",
        "reason" => value == "query-cancelled",
        "exception_origin" => matches!(value, "uncaughtException" | "unhandledRejection"),
        _ => false,
    }
}
fn internal(key: &str) -> bool {
    matches!(
        key,
        "authentication"
            | "bind_category"
            | "cache"
            | "close_reason"
            | "context"
            | "encoding"
            | "endpoint"
            | "event"
            | "exception_origin"
            | "failure_stage"
            | "field"
            | "indexes"
            | "label"
            | "loopback_authority"
            | "message_update"
            | "operation"
            | "outcome"
            | "parameter"
            | "persistent_index_worker_job"
            | "publication_completeness"
            | "query_keys"
            | "request_type"
            | "result"
            | "route"
            | "signal"
            | "stage"
            | "state"
            | "status"
            | "transport"
            | "update"
            | "validation_outcome"
            | "version"
            | "worker_level"
    )
}
impl Encoder {
    pub(super) fn new(run_id: String, max_bytes: usize, home: PathBuf) -> Self {
        let cwd = std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let mut prefixes = vec![
            (cwd, "<cwd>".into()),
            (home.to_string_lossy().into_owned(), "~".into()),
        ];
        prefixes.retain(|(p, _)| !p.is_empty());
        prefixes.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        Self {
            run_id,
            max_bytes,
            prefixes,
        }
    }
    pub(super) fn encode(
        &self,
        level: Level,
        event: &str,
        data: &Value,
        context: &LogContext,
        sequence: u64,
    ) -> Vec<u8> {
        let mut budget = Budget {
            values: 1000,
            characters: self.max_bytes,
        };
        let trusted = !event.starts_with("client.");
        let event = bounded(event.trim(), 160)
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "_.:-".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();
        let mut record = match self.sanitize(data, "", 0, trusted, &mut budget) {
            Value::Object(fields) => fields,
            value => Map::from_iter([("diagnostic_data".into(), value)]),
        };
        let mut contexts = Map::new();
        for (key, value) in [
            ("request_id", &context.request_id),
            ("operation_id", &context.operation_id),
            ("publication_id", &context.publication_id),
        ] {
            if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                contexts.insert(
                    key.into(),
                    Value::String(bounded(&self.string(value, key, trusted, &mut budget), 160)),
                );
            }
        }
        let fixed=json!({"schema_version":1,"ts":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"level":level.as_str(),"event":event,"run_id":self.run_id,"seq":sequence,"pid":std::process::id()}).as_object().unwrap().clone();
        record.extend(contexts.clone());
        record.extend(fixed.clone());
        let mut line = serde_json::to_vec(&record).expect("JSON log record");
        line.push(b'\n');
        if line.len() <= self.max_bytes {
            return line;
        }
        let original = line.len();
        contexts.extend(fixed);
        contexts.insert("record_truncated".into(), true.into());
        contexts.insert("original_bytes".into(), original.into());
        line = serde_json::to_vec(&contexts).expect("bounded log record");
        line.push(b'\n');
        if line.len() <= self.max_bytes {
            return line;
        }
        let minimal = json!({"schema_version":1,"ts":contexts["ts"],"level":level.as_str(),"event":bounded(&event,64),"record_truncated":true,"original_bytes":original});
        line = serde_json::to_vec(&minimal).expect("minimal log record");
        line.push(b'\n');
        line
    }
    fn sanitize(
        &self,
        value: &Value,
        key: &str,
        depth: usize,
        trusted: bool,
        budget: &mut Budget,
    ) -> Value {
        if budget.values == 0 || budget.characters == 0 {
            return "[truncated]".into();
        }
        budget.values -= 1;
        let key = normalized(&bounded(key, 4000));
        if matches!(
            key.as_str(),
            "apikey" | "id_token" | "refresh_token" | "set_cookie"
        ) || suffix(
            &key,
            &[
                "access_token",
                "api_key",
                "authorization",
                "cookie",
                "credential",
                "credentials",
                "passphrase",
                "passwd",
                "password",
                "private_key",
                "secret",
                "token",
            ],
        ) {
            return "[redacted]".into();
        }
        if matches!(key.as_str(), "error" | "cause")
            && let Some(value) = value.as_str()
        {
            return self.fingerprint("error_message", value, budget).into();
        }
        if matches!(
            key.as_str(),
            "argv"
                | "body"
                | "command_args"
                | "content"
                | "env"
                | "environment"
                | "headers"
                | "http_body"
                | "message"
                | "messages"
                | "prompt"
                | "prompts"
                | "request_body"
                | "response_body"
                | "stderr"
                | "stdout"
                | "tool_output"
                | "tool_outputs"
                | "transcript"
                | "transcripts"
        ) && !value.is_null()
            && !value.is_number()
            && !value.is_boolean()
        {
            return "[omitted]".into();
        }
        match value {
            Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(value) => self.string(value, &key, trusted, budget).into(),
            _ if depth >= 5 => "[truncated]".into(),
            Value::Array(values) => {
                let mut output = Vec::new();
                for value in values.iter().take(50) {
                    output.push(self.sanitize(value, &key, depth + 1, trusted, budget));
                    if budget.values == 0 || budget.characters == 0 {
                        break;
                    }
                }
                Value::Array(output)
            }
            Value::Object(fields) => {
                let mut output = Map::new();
                for (key, value) in fields.iter().take(100) {
                    let field = if key.len() <= 4000 && key.len() <= budget.characters {
                        budget.characters -= key.len();
                        key.clone()
                    } else {
                        self.fingerprint("field", key, budget)
                    };
                    output.insert(field, self.sanitize(value, key, depth + 1, trusted, budget));
                    if budget.values == 0 || budget.characters == 0 {
                        break;
                    }
                }
                Value::Object(output)
            }
        }
    }
    fn literal(&self, value: &str, budget: &mut Budget) -> String {
        let count = value.encode_utf16().count();
        if count > budget.characters {
            return "[truncated]".into();
        }
        budget.characters -= count;
        value.into()
    }
    fn fingerprint(&self, kind: &str, value: &str, budget: &mut Budget) -> String {
        if FINGERPRINT.is_match(value) {
            return self.literal(value, budget);
        }
        let unit_count = value.encode_utf16().count();
        let input = if unit_count <= 4000 {
            value.to_owned()
        } else {
            let suffix = format!("\0{unit_count}");
            let content = 4000 - suffix.len();
            let prefix = content.div_ceil(2);
            let tail = value
                .chars()
                .rev()
                .take(content - prefix)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>();
            let tail_units = tail.encode_utf16().collect::<Vec<_>>();
            format!(
                "{}{}{}",
                bounded(value, prefix),
                String::from_utf16_lossy(&tail_units[tail_units.len() - (content - prefix)..]),
                suffix
            )
        };
        if input.encode_utf16().count() > budget.characters {
            return "[truncated]".into();
        }
        budget.characters -= input.encode_utf16().count();
        let mut mac = Hmac::<Sha256>::new_from_slice(KEY.as_bytes()).expect("HMAC key");
        mac.update(input.as_bytes());
        let digest = mac.finalize().into_bytes();
        format!(
            "{kind}:{}",
            digest[..8]
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        )
    }
    fn string(&self, value: &str, key: &str, trusted: bool, budget: &mut Budget) -> String {
        if FINGERPRINT.is_match(value)
            || matches!(
                value,
                "[accessor]"
                    | "[circular]"
                    | "[omitted]"
                    | "[redacted]"
                    | "[truncated]"
                    | "[unserializable]"
            )
        {
            return self.literal(value, budget);
        }
        if correlated(key) {
            return if trusted
                || uuid::Uuid::parse_str(value).is_ok_and(|id| {
                    value.len() == 36
                        && matches!(id.get_version_num(), 1..=8)
                        && id.get_variant() == uuid::Variant::RFC4122
                }) {
                self.literal(value, budget)
            } else {
                self.fingerprint("identifier", value, budget)
            };
        }
        if audited(key, value) {
            return self.literal(value, budget);
        }
        if matches!(
            key,
            "cursor" | "message_cursor" | "request_key" | "session" | "session_id"
        ) || suffix(key, &["cursor", "id", "request_key", "session_id"])
        {
            return self.fingerprint("identifier", value, budget);
        }
        if key == "stack" {
            let input = bounded(value, 4000.min(budget.characters));
            budget.characters = budget
                .characters
                .saturating_sub(input.encode_utf16().count());
            let body = if input.trim_start().starts_with("at ") {
                input.as_str()
            } else {
                input
                    .find(['\n', '\r'])
                    .map(|i| input[i..].trim_start_matches(['\r', '\n']))
                    .unwrap_or("")
            };
            return self.redact(body);
        }
        if trusted && internal(key) {
            let bounded = bounded(value, 4000.min(budget.characters));
            budget.characters = budget
                .characters
                .saturating_sub(bounded.encode_utf16().count());
            return self.redact(&bounded);
        }
        if suffix(key, &["cwd", "directory", "file", "path", "root"]) {
            return self.fingerprint("path", value, budget);
        }
        if suffix(key, &["origin", "url"]) {
            if value.encode_utf16().count() > 4000.min(budget.characters) {
                return self.fingerprint("url", value, budget);
            }
            budget.characters = budget
                .characters
                .saturating_sub(value.encode_utf16().count());
            return url::Url::parse(value)
                .ok()
                .filter(|u| u.origin().ascii_serialization() != "null")
                .map(|u| format!("{}/", u.origin().ascii_serialization()))
                .unwrap_or("[omitted]".into());
        }
        self.fingerprint("string", value, budget)
    }
    fn redact(&self, value: &str) -> String {
        let value = PRIVATE_KEY.replace_all(value, "[redacted]");
        let value = BEARER.replace_all(&value, "Bearer [redacted]");
        let value = JWT.replace_all(&value, "[redacted]");
        let value = INCOMPLETE_JWT.replace_all(&value, "[redacted]");
        let mut value = SECRET_QUERY
            .replace_all(&value, "${1}[redacted]")
            .into_owned();
        for (prefix, replacement) in &self.prefixes {
            if prefix.as_bytes().get(1) == Some(&b':') || prefix.starts_with("\\\\") {
                let pattern = prefix
                    .split(['\\', '/'])
                    .map(regex::escape)
                    .collect::<Vec<_>>()
                    .join(r"[\\/]+");
                if let Ok(regex) = Regex::new(&format!("(?i){pattern}")) {
                    value = regex.replace_all(&value, replacement.as_str()).into_owned();
                }
            } else {
                value = value.replace(prefix, replacement)
            }
        }
        value
    }
}
