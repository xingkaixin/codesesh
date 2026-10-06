use std::collections::{HashMap, HashSet};

use serde_json::{Value, json};

use crate::contract::{Message, MessagePart, ToolState};

type Position = (usize, usize);

#[derive(Clone, Default)]
pub(super) struct ToolEvents {
    pending: HashMap<String, Vec<Position>>,
    completed: HashSet<String>,
}

impl ToolEvents {
    pub fn register(&mut self, namespace: &str, name: &str, position: Position) {
        if let Some(server) = namespace.strip_prefix("mcp__") {
            let server = server.strip_suffix("__").unwrap_or(server);
            if server != "codex_app" || name != "read_thread" {
                return;
            }
            self.pending
                .entry(format!("{server}:{name}"))
                .or_default()
                .push(position);
        }
    }

    pub fn complete(
        &mut self,
        item: &Value,
        messages: &mut [Message],
        time: f64,
    ) -> Option<MessagePart> {
        let server = item["server"].as_str()?;
        let name = item["tool"].as_str()?;
        if server != "codex_app" || name != "read_thread" {
            return None;
        }
        let id = item["id"].as_str().filter(|id| !id.is_empty())?;
        if !self.completed.insert(id.into()) {
            return None;
        }
        let arguments = &item["arguments"];
        let result = &item["result"];
        let error = item["status"] == "failed" || result["isError"] == true;
        let mut state = ToolState {
            status: if error { "error" } else { "completed" }.into(),
            input: Some(arguments.clone()),
            output: (!result.is_null()).then(|| result.clone()),
            error: error.then(|| result.clone()),
            metadata: Some(json!({"name":name,"namespace":format!("mcp__{server}__")})),
        };
        let pending = self.pending.entry(format!("{server}:{name}")).or_default();
        let matched = pending
            .iter()
            .position(|&(message, part)| {
                let MessagePart::Tool { state, .. } = &messages[message].parts[part] else {
                    return false;
                };
                state.input.as_ref() == Some(arguments)
            })
            .or_else(|| {
                pending.iter().position(|&(message, part)| {
                    let MessagePart::Tool { state, .. } = &messages[message].parts[part] else {
                        return false;
                    };
                    // JS variables unresolved by exec decoding are represented as null.
                    state
                        .input
                        .as_ref()
                        .and_then(Value::as_object)
                        .is_some_and(|input| {
                            input.iter().all(|(key, value)| {
                                value.is_null() || arguments.get(key) == Some(value)
                            })
                        })
                })
            });
        if let Some(index) = matched {
            let (message, part) = pending.remove(index);
            if let MessagePart::Tool {
                state: previous, ..
            } = &mut messages[message].parts[part]
            {
                state.metadata = previous.metadata.clone().or(state.metadata);
                *previous = Box::new(state);
            }
            return None;
        }
        Some(MessagePart::Tool {
            tool: name.into(),
            title: Some(format!("Tool: {name}")),
            call_id: Some(id.into()),
            state: Box::new(state),
            time_created: Some(time),
        })
    }
}

pub(super) fn record_question_reply(
    text: &str,
    messages: &mut [Message],
    tools: &HashMap<String, Position>,
) -> Option<String> {
    let body = text
        .trim()
        .strip_prefix("<send_user_message_question_reply>")?
        .strip_suffix("</send_user_message_question_reply>")?;
    let replies: Vec<Value> = serde_json::from_str(body.trim()).ok()?;
    let mut visible = Vec::new();
    for reply in replies {
        let Some(answer) = reply["answer"].as_str() else {
            continue;
        };
        let question = reply["question"].as_str().unwrap_or("");
        visible.push(format!("{question}\n\n{answer}").trim().to_owned());
        let Some(id) = reply["questionItemId"]
            .as_str()
            .and_then(|id| serde_json::from_str::<Value>(id).ok())
        else {
            continue;
        };
        if id[0] != "request_user_input_async" {
            continue;
        }
        let Some((message, part)) = id[1].as_str().and_then(|id| tools.get(id)).copied() else {
            continue;
        };
        let Some(index) = id[2].as_u64().and_then(|n| usize::try_from(n).ok()) else {
            continue;
        };
        let MessagePart::Tool { tool, state, .. } = &mut messages[message].parts[part] else {
            continue;
        };
        if tool != "request_user_input_async"
            || state
                .input
                .as_ref()
                .and_then(|input| input["questions"].as_array())
                .is_none_or(|questions| index >= questions.len())
        {
            continue;
        }
        let metadata = state.metadata.get_or_insert_with(|| json!({}));
        metadata["questionAnswers"][index.to_string()] = json!([answer]);
    }
    (!visible.is_empty()).then(|| visible.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agents::codex, pricing::Pricing};
    use std::io::Write;

    fn parse(records: Vec<Value>) -> Vec<Message> {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("rollout-2026-01-01-00000000-0000-0000-0000-000000000001.jsonl");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            json!({"type":"session_meta","timestamp":1000,"payload":{"cwd":"/project"}})
        )
        .unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
        codex::parse(&path, &HashMap::new(), &Pricing::bundled())
            .unwrap()
            .unwrap()
            .messages
    }

    fn completed(id: &str, arguments: Value, result: Value) -> Value {
        json!({"type":"event_msg","timestamp":3000,"payload":{"type":"item_completed","item":{
            "type":"McpToolCall","id":id,"server":"codex_app","tool":"read_thread",
            "arguments":arguments,"status":if result["isError"] == true {"failed"} else {"completed"},"result":result
        }}})
    }

    #[test]
    fn exec_outputs_preserve_block_order_and_settle_empty_and_failed_calls() {
        for (output, status, expected) in [
            (
                json!([
                    {"type":"input_text","text":"Script completed\nWall time 0.2 seconds\nOutput:\n\n"},
                    {"type":"input_image","image_url":"data:image/png;base64,eA=="},
                    {"type":"input_text","text":"first"},
                    {"type":"input_text","text":"second"},
                    {"type":"input_text","text":"Script completed\nWall time 0 seconds\nOutput:\nprinted envelope"}
                ]),
                "completed",
                json!([
                    {"type":"image","mime_type":"image/png","data":"eA=="},
                    {"type":"text","text":"first","time_created":3000.0},
                    {"type":"text","text":"second","time_created":3000.0},
                    {"type":"text","text":"Script completed\nWall time 0 seconds\nOutput:\nprinted envelope","time_created":3000.0}
                ]),
            ),
            (
                json!("Script completed\nWall time 0.2 seconds\nOutput:\n"),
                "completed",
                json!([]),
            ),
            (
                json!("Script failed\nWall time 0.2 seconds\nOutput:\nSyntaxError: invalid source"),
                "error",
                json!([{"type":"text","text":"SyntaxError: invalid source","time_created":3000.0}]),
            ),
            (
                json!("Script running with cell ID 7"),
                "running",
                json!([{"type":"text","text":"Script running with cell ID 7","time_created":3000.0}]),
            ),
        ] {
            let messages = parse(vec![
                json!({"type":"response_item","timestamp":2000,"payload":{"type":"custom_tool_call","name":"exec","call_id":"exec-1","input":"text('result');"}}),
                json!({"type":"response_item","timestamp":3000,"payload":{"type":"custom_tool_call_output","call_id":"exec-1","output":output}}),
            ]);
            let MessagePart::Tool { tool, state, .. } = &messages[0].parts[0] else {
                panic!()
            };
            assert_eq!(tool, "exec");
            assert_eq!(state.status, status);
            assert_eq!(state.output.as_ref(), Some(&expected));
            assert_eq!(state.error.is_some(), status == "error");
        }
    }

    #[test]
    fn mcp_results_follow_arguments_despite_reversed_completion_and_exec_summary() {
        let second = completed(
            "event-b",
            json!({"threadId":"b"}),
            json!({"content":[{"type":"text","text":"invalid cursor"}],"isError":true}),
        );
        let messages = parse(vec![
            json!({"type":"response_item","timestamp":2000,"payload":{"type":"custom_tool_call","name":"exec","call_id":"exec-1","input":"await Promise.all([tools.mcp__codex_app__read_thread({threadId:'a'}), tools.mcp__codex_app__read_thread({threadId:'b'})]);"}}),
            second.clone(),
            completed(
                "event-a",
                json!({"threadId":"a"}),
                json!({"content":[{"type":"text","text":"thread a"}]}),
            ),
            second,
            json!({"type":"response_item","timestamp":4000,"payload":{"type":"custom_tool_call_output","call_id":"exec-1","output":"combined summary"}}),
        ]);
        let parts = messages
            .iter()
            .flat_map(|message| &message.parts)
            .collect::<Vec<_>>();
        assert_eq!(parts.len(), 2);
        let MessagePart::Tool { state: a, .. } = parts[0] else {
            panic!()
        };
        let MessagePart::Tool { state: b, .. } = parts[1] else {
            panic!()
        };
        assert_eq!(a.status, "completed");
        assert_eq!(a.output.as_ref().unwrap()["content"][0]["text"], "thread a");
        assert_eq!(b.status, "error");
        assert_eq!(
            b.error.as_ref().unwrap()["content"][0]["text"],
            "invalid cursor"
        );
    }

    #[test]
    fn direct_mcp_namespaces_reconcile_without_duplicate_tools() {
        let messages = parse(vec![
            json!({"type":"response_item","timestamp":2000,"payload":{"type":"function_call","name":"read_thread","namespace":"mcp__codex_app","call_id":"direct-a","arguments":"{\"threadId\":\"a\"}"}}),
            completed(
                "event-a",
                json!({"threadId":"a"}),
                json!({"content":[{"type":"text","text":"thread a"}]}),
            ),
            json!({"type":"response_item","timestamp":4000,"payload":{"type":"function_call_output","call_id":"direct-a","output":"duplicate output"}}),
        ]);
        let parts = messages
            .iter()
            .flat_map(|message| &message.parts)
            .collect::<Vec<_>>();
        assert_eq!(parts.len(), 1);
        let MessagePart::Tool { tool, state, .. } = parts[0] else {
            panic!()
        };
        assert_eq!(tool, "codex_app.read_thread");
        assert_eq!(
            state.metadata.as_ref().unwrap()["namespace"],
            "mcp__codex_app"
        );
        assert_eq!(
            state.output.as_ref().unwrap()["content"][0]["text"],
            "thread a"
        );
    }

    #[test]
    fn repeated_dynamic_calls_keep_each_observed_result() {
        let messages = parse(vec![
            json!({"type":"response_item","timestamp":2000,"payload":{"type":"custom_tool_call","name":"exec","call_id":"exec-1","input":"for (const id of ids) { await tools.mcp__codex_app__read_thread({threadId:id}); }"}}),
            completed(
                "event-a",
                json!({"threadId":"a"}),
                json!({"content":[{"type":"text","text":"a"}]}),
            ),
            completed(
                "event-b",
                json!({"threadId":"b"}),
                json!({"content":[{"type":"text","text":"b"}]}),
            ),
        ]);
        let parts = messages
            .iter()
            .flat_map(|message| &message.parts)
            .collect::<Vec<_>>();
        assert_eq!(parts.len(), 2);
        for (part, id) in parts.iter().zip(["a", "b"]) {
            let MessagePart::Tool { state, .. } = part else {
                panic!()
            };
            assert_eq!(state.input.as_ref().unwrap()["threadId"], id);
            assert_eq!(state.status, "completed");
        }
    }

    #[test]
    fn async_replies_update_only_the_identified_question_and_remain_readable() {
        let reply = json!([
            {"questionItemId":"[\"request_user_input_async\",\"ask-a\",1]","question":"Which device?","answer":"My own device"},
            {"questionItemId":"[\"request_user_input_async\",\"missing\",0]","question":"Unknown question","answer":"Unmatched reply"}
        ]);
        let messages = parse(vec![
            json!({"type":"response_item","timestamp":2000,"payload":{"type":"function_call","name":"request_user_input_async","call_id":"ask-a","arguments":"{\"questions\":[{\"title\":\"Which site?\"},{\"title\":\"Which device?\"}]}"}}),
            json!({"type":"response_item","timestamp":2100,"payload":{"type":"function_call_output","call_id":"ask-a","output":"{\"accepted\":true}"}}),
            json!({"type":"response_item","timestamp":3000,"payload":{"type":"message","role":"user","content":[{"type":"input_text","text":format!("<send_user_message_question_reply>\n{reply}\n</send_user_message_question_reply>")} ]}}),
        ]);
        let MessagePart::Tool { state, .. } = &messages[0].parts[0] else {
            panic!()
        };
        assert_eq!(
            state.output.as_ref().unwrap()[0]["text"],
            "{\"accepted\":true}"
        );
        assert_eq!(
            state.metadata.as_ref().unwrap()["questionAnswers"],
            json!({"1":["My own device"]})
        );
        let MessagePart::Text { text, .. } = &messages[1].parts[0] else {
            panic!()
        };
        assert_eq!(
            text,
            "Which device?\n\nMy own device\n\nUnknown question\n\nUnmatched reply"
        );
    }
}
