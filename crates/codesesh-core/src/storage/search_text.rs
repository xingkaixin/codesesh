use crate::contract::{Message, MessagePart};
use serde_json::Value;

const TOOL_TEXT_EDGE_BYTES: usize = 8 * 1024;
const BLOB_MIN_BYTES: usize = 256;

pub(super) fn message_text(message: &Message) -> String {
    text(
        super::role_name(&message.role),
        message.agent.as_deref(),
        message.model.as_deref(),
        &message.parts,
    )
}

fn text(role: &str, agent: Option<&str>, model: Option<&str>, parts: &[MessagePart]) -> String {
    let mut fields = vec![role.to_owned()];
    for value in [agent, model].into_iter().flatten() {
        push(value, &mut fields);
    }
    for part in parts {
        match part {
            MessagePart::Text { text, .. } => {
                fields.push("text".into());
                push(text, &mut fields);
            }
            MessagePart::Reasoning { text, .. } => {
                fields.push("reasoning".into());
                push(text, &mut fields);
            }
            MessagePart::Plan { text, .. } => {
                fields.push("plan".into());
                push(text, &mut fields);
            }
            MessagePart::Image { .. } => fields.push("image".into()),
            MessagePart::Tool {
                tool, state, title, ..
            } => {
                fields.push("tool".into());
                if let Some(title) = title {
                    push(title, &mut fields);
                }
                push(tool, &mut fields);
                let mut state_fields = Vec::new();
                push(&state.status, &mut state_fields);
                for value in [&state.input, &state.output, &state.error, &state.metadata]
                    .into_iter()
                    .flatten()
                {
                    append(value, &mut state_fields);
                }
                if !state_fields.is_empty() {
                    fields.push(edges(state_fields.join("\n")));
                }
            }
        }
    }
    fields.join("\n")
}

fn append(value: &Value, fields: &mut Vec<String>) {
    match value {
        Value::Null => (),
        Value::String(value) => push(value, fields),
        Value::Array(values) => values.iter().for_each(|value| append(value, fields)),
        Value::Object(values) => values.values().for_each(|value| append(value, fields)),
        value => fields.push(value.to_string()),
    }
}

fn push(value: &str, fields: &mut Vec<String>) {
    let value = value.trim();
    if !value.is_empty() && !is_blob(value) {
        fields.push(value.to_owned());
    }
}

// Inline images and attachments arrive as base64; their tokens are unique noise for FTS.
fn is_blob(value: &str) -> bool {
    let payload = value
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .map_or(value, |(_, payload)| payload);
    payload.len() >= BLOB_MIN_BYTES
        && payload.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn edges(text: String) -> String {
    if text.len() <= TOOL_TEXT_EDGE_BYTES * 2 {
        return text;
    }
    let mut head = TOOL_TEXT_EDGE_BYTES;
    while !text.is_char_boundary(head) {
        head -= 1;
    }
    let mut tail = text.len() - TOOL_TEXT_EDGE_BYTES;
    while !text.is_char_boundary(tail) {
        tail += 1;
    }
    format!("{}\n{}", &text[..head], &text[tail..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::ToolState;
    use serde_json::json;

    fn tool(output: Value) -> String {
        text(
            "assistant",
            None,
            None,
            &[MessagePart::Tool {
                tool: "view_image".into(),
                call_id: None,
                state: Box::new(ToolState {
                    status: "completed".into(),
                    input: Some(json!({"path": "/tmp/shot.png"})),
                    output: Some(output),
                    error: None,
                    metadata: None,
                }),
                time_created: None,
                title: None,
            }],
        )
    }

    #[test]
    fn skips_inline_binary_and_keeps_tool_edges() {
        let image = "iVBORw0KGgo".repeat(64);
        let text = tool(json!([
            {"type": "text", "text": "rendered ok"},
            {"type": "image", "mime_type": "image/png", "data": image},
            {"type": "text", "text": format!("data:image/png;base64,{image}")},
        ]));
        assert!(text.contains("/tmp/shot.png") && text.contains("rendered ok"));
        assert!(!text.contains("iVBORw0KGgo"));

        let log = format!("start {} finish", "line of build output\n".repeat(2000));
        let text = tool(json!(log));
        assert!(text.contains("start") && text.contains("finish"));
        assert!(text.len() < 3 * TOOL_TEXT_EDGE_BYTES);
    }
}
