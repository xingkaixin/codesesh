use axum::{
    Json,
    body::Bytes,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub async fn post(
    axum::extract::Extension(context): axum::extract::Extension<crate::logging::LogContext>,
    bytes: Bytes,
) -> Response {
    let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let Some(event) = value["event"].as_str().map(str::trim).filter(|v| {
        matches!(
            *v,
            "app.load.done"
                | "app.load.error"
                | "app.load.start"
                | "bookmark.add"
                | "bookmark.delete"
                | "react.profiler.commit"
                | "route.change"
                | "search.done"
                | "search.error"
                | "search.start"
                | "session.markdown_copy.done"
                | "session.markdown_copy.error"
                | "session.open.cancel"
                | "session.open.done"
                | "session.open.error"
                | "session.open.start"
        )
    }) else {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok":false}))).into_response();
    };
    let data = sanitize(&value["data"]);
    if let Some(logger) = crate::logging::current() {
        logger
            .with_context(context)
            .info(&format!("client.{event}"), &data);
    }
    Json(json!({"ok":true})).into_response()
}
fn sanitize(value: &Value) -> Value {
    let mut result = json!({});
    let Some(values) = value.as_object() else {
        return result;
    };
    for (key, value) in values {
        if matches!(
            key.as_str(),
            "agent"
                | "error_name"
                | "mode"
                | "operation_id"
                | "phase"
                | "profiler_id"
                | "reason"
                | "request_key"
                | "session"
                | "source"
                | "trigger"
        ) && let Some(text) = value.as_str()
        {
            if key == "operation_id"
                && !uuid::Uuid::parse_str(text).is_ok_and(|id| {
                    matches!(id.get_version_num(), 1..=8)
                        && id.get_variant() == uuid::Variant::RFC4122
                        && text.len() == 36
                })
            {
                continue;
            }
            result[key] = json!(String::from_utf16_lossy(
                &text.encode_utf16().take(300).collect::<Vec<_>>()
            ));
            continue;
        }
        if matches!(
            key.as_str(),
            "actual_duration_ms"
                | "agents"
                | "base_duration_ms"
                | "commit_time_ms"
                | "duration_ms"
                | "error_status"
                | "messages"
                | "query_length"
                | "results"
                | "sessions"
                | "start_time_ms"
        ) && value.as_f64().is_some_and(|v| v >= 0.0 && v.is_finite())
        {
            result[key] = value.clone();
        }
        if matches!(key.as_str(), "agent" | "session") && value.is_null() {
            result[key] = Value::Null;
        }
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_allowlisted_log_fields_survive() {
        assert_eq!(
            sanitize(
                &json!({"query":"secret","session":"one","duration_ms":-1,"operation_id":"bad","agent":null})
            ),
            json!({"session":"one","agent":null})
        );
    }
}
