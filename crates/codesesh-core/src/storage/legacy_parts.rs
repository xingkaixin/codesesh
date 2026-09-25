use crate::contract::MessagePart;
use serde_json::{Map, Value};

fn text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}
fn plan(value: &Value) -> Option<&str> {
    value.as_str().or_else(|| {
        value
            .get("text")
            .or_else(|| value.get("plan"))
            .or_else(|| value.get("content"))
            .and_then(plan)
    })
}
fn normalized(value: &Value) -> Option<Value> {
    let part = value.as_object()?;
    let kind = value["type"].as_str()?;
    let mut result = Map::new();
    result.insert("type".into(), Value::String(kind.into()));
    match kind {
        "text" | "reasoning" => {
            result.insert("text".into(), Value::String(value["text"].as_str()?.into()));
        }
        "plan" => {
            let failed = value["approval_status"] == "fail";
            let content = value
                .get("text")
                .filter(|v| !v.is_null())
                .unwrap_or(&value[if failed { "output" } else { "input" }]);
            let text = plan(content).filter(|text| !text.is_empty())?;
            result.insert("text".into(), Value::String(text.into()));
            result.insert(
                "approval_status".into(),
                Value::String(if failed { "fail" } else { "success" }.into()),
            );
        }
        "image" => {
            let data = text(&value["data"]);
            let mime = text(&value["mime_type"]);
            let url = text(&value["url"]);
            if data.is_some() && mime.is_some() {
                result.insert("data".into(), Value::String(data?.into()));
                result.insert("mime_type".into(), Value::String(mime?.into()));
                if let Some(url) = url {
                    result.insert("url".into(), Value::String(url.into()));
                }
            } else {
                result.insert("url".into(), Value::String(url?.into()));
                if let Some(data) = data {
                    result.insert("data".into(), Value::String(data.into()));
                }
                if let Some(mime) = mime {
                    result.insert("mime_type".into(), Value::String(mime.into()));
                }
            }
        }
        "tool" => {
            let title = text(&value["title"]);
            let tool = text(&value["tool"])
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .or_else(|| {
                    title.map(|title| {
                        if title
                            .get(..5)
                            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("tool:"))
                        {
                            title[5..].trim()
                        } else {
                            title.trim()
                        }
                    })
                })
                .filter(|t| !t.is_empty())?;
            result.insert("tool".into(), Value::String(tool.into()));
            if let Some(title) = title {
                result.insert("title".into(), Value::String(title.into()));
            }
            if let Some(id) = text(&value["callID"]) {
                result.insert("callID".into(), Value::String(id.into()));
            }
            let empty = Map::new();
            let state = value["state"].as_object().unwrap_or(&empty);
            let input = state
                .get("input")
                .or_else(|| state.get("arguments"))
                .or_else(|| part.get("input"));
            let output = state
                .get("output")
                .or_else(|| state.get("result"))
                .or_else(|| part.get("output"));
            let error = state.get("error");
            let status = match state.get("status").and_then(Value::as_str) {
                Some("running") => "running",
                Some("completed" | "success") => "completed",
                Some("error") => "error",
                _ if error.is_some_and(|v| !v.is_null()) => "error",
                _ if output.is_some() => "completed",
                _ => "running",
            };
            let mut normalized = Map::new();
            normalized.insert("status".into(), Value::String(status.into()));
            for (key, value) in [("input", input), ("output", output), ("error", error)] {
                if let Some(value) = value {
                    normalized.insert(key.into(), value.clone());
                }
            }
            let metadata = state
                .get("metadata")
                .filter(|v| !v.is_null())
                .or_else(|| state.get("meta"));
            let extras = state
                .iter()
                .filter(|(key, _)| {
                    ![
                        "status",
                        "input",
                        "arguments",
                        "output",
                        "result",
                        "error",
                        "metadata",
                        "meta",
                    ]
                    .contains(&key.as_str())
                })
                .collect::<Vec<_>>();
            if extras.is_empty() {
                if let Some(metadata) = metadata {
                    normalized.insert("metadata".into(), metadata.clone());
                }
            } else {
                let mut metadata = metadata
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                for (key, value) in extras {
                    metadata.insert(key.clone(), value.clone());
                }
                normalized.insert("metadata".into(), Value::Object(metadata));
            }
            result.insert("state".into(), Value::Object(normalized));
        }
        _ => return None,
    }
    if value["time_created"].as_f64().is_some_and(f64::is_finite) {
        result.insert("time_created".into(), value["time_created"].clone());
    }
    Some(Value::Object(result))
}

pub fn normalize(raw: &str) -> Vec<MessagePart> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|value| {
            value.as_array().map(|parts| {
                parts
                    .iter()
                    .filter_map(normalized)
                    .filter_map(|value| serde_json::from_value(value).ok())
                    .collect()
            })
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upgrades_legacy_tool_arguments_results_and_plan_payloads() {
        let parts = normalize(
            r#"[{"type":"tool","title":"tool: Read","state":{"status":"success","arguments":{"path":"src/main.rs"},"result":"done","duration":2}},{"type":"plan","input":{"plan":"Implement it"}},{"type":"image","url":"https://example.test/a.png"},{"type":"unknown"}]"#,
        );
        assert_eq!(parts.len(), 3);
        let MessagePart::Tool { tool, state, .. } = &parts[0] else {
            panic!("tool")
        };
        assert_eq!(tool, "Read");
        assert_eq!(state.status, "completed");
        assert_eq!(state.input.as_ref().unwrap()["path"], "src/main.rs");
        assert_eq!(state.output.as_ref().unwrap(), "done");
        assert_eq!(state.metadata.as_ref().unwrap()["duration"], 2);
        let MessagePart::Plan {
            text,
            approval_status,
            ..
        } = &parts[1]
        else {
            panic!("plan")
        };
        assert_eq!(text, "Implement it");
        assert_eq!(approval_status, "success");
    }
}
