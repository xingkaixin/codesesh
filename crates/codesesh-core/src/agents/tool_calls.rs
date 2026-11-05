use crate::model::{Message, MessagePart, Role, ToolPartStatus, ToolState};
use std::collections::HashMap;

pub(crate) type ToolCalls = HashMap<String, (usize, usize)>;

// Agents reuse call ids, so results route to the newest call and an older
// call still waiting can no longer be settled.
pub(crate) fn register(
    calls: &mut ToolCalls,
    messages: &mut [Message],
    id: &str,
    at: (usize, usize),
) {
    if let Some(earlier) = calls.insert(id.to_owned(), at)
        && earlier != at
        && let Some(state) = state_at(messages, earlier)
        && state.status == ToolPartStatus::Running
    {
        state.status = ToolPartStatus::Unknown;
    }
}

// The first terminal result settles a call; repeated results are ignored.
pub(crate) fn pending<'a>(
    calls: &ToolCalls,
    messages: &'a mut [Message],
    id: &str,
) -> Option<&'a mut ToolState> {
    let at = *calls.get(id)?;
    state_at(messages, at).filter(|state| state.status == ToolPartStatus::Running)
}

// A live session may still be running its last calls; once the user has
// started another turn, calls before it will never report a result.
pub(crate) fn settle_interrupted(messages: &mut [Message]) {
    let Some(turn) = messages.iter().rposition(|message| {
        message.role == Role::User
            && message
                .parts
                .iter()
                .any(|part| !matches!(part, MessagePart::Tool { .. }))
    }) else {
        return;
    };
    for part in messages[..turn]
        .iter_mut()
        .flat_map(|message| &mut message.parts)
    {
        if let MessagePart::Tool { state, .. } = part
            && state.status == ToolPartStatus::Running
        {
            state.status = ToolPartStatus::Unknown;
        }
    }
}

fn state_at(messages: &mut [Message], (message, part): (usize, usize)) -> Option<&mut ToolState> {
    match messages.get_mut(message)?.parts.get_mut(part)? {
        MessagePart::Tool { state, .. } => Some(state),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: Role, calls: &[&str]) -> Message {
        let mut message = crate::agents::claudecode::common::message(
            String::new(),
            role,
            0.0,
            vec![MessagePart::Text {
                text: "text".into(),
                time_created: None,
            }],
        );
        message
            .parts
            .extend(calls.iter().map(|id| MessagePart::Tool {
                tool: "bash".into(),
                call_id: Some((*id).into()),
                state: Box::new(ToolState {
                    status: ToolPartStatus::Running,
                    input: None,
                    output: None,
                    error: None,
                    metadata: None,
                }),
                time_created: None,
                title: None,
            }));
        message
    }

    fn status(messages: &[Message], message: usize, part: usize) -> ToolPartStatus {
        let MessagePart::Tool { state, .. } = &messages[message].parts[part] else {
            panic!()
        };
        state.status
    }

    #[test]
    fn reused_ids_and_later_turns_settle_waiting_calls() {
        let mut messages = vec![
            message(Role::Assistant, &["reused", "waiting"]),
            message(Role::Assistant, &["reused"]),
            message(Role::User, &[]),
            message(Role::Assistant, &["live"]),
        ];
        let mut calls = ToolCalls::new();
        for (id, at) in [("reused", (0, 1)), ("waiting", (0, 2)), ("reused", (1, 1))] {
            register(&mut calls, &mut messages, id, at);
        }
        assert_eq!(status(&messages, 0, 1), ToolPartStatus::Unknown);
        pending(&calls, &mut messages, "reused").unwrap().status = ToolPartStatus::Completed;
        assert!(pending(&calls, &mut messages, "reused").is_none());

        settle_interrupted(&mut messages);
        assert_eq!(status(&messages, 0, 2), ToolPartStatus::Unknown);
        assert_eq!(status(&messages, 1, 1), ToolPartStatus::Completed);
        assert_eq!(status(&messages, 3, 1), ToolPartStatus::Running);
    }
}
