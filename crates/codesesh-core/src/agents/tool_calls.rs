use crate::model::{Message, MessagePart, ToolPartStatus, ToolState};
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

fn state_at(messages: &mut [Message], (message, part): (usize, usize)) -> Option<&mut ToolState> {
    match messages.get_mut(message)?.parts.get_mut(part)? {
        MessagePart::Tool { state, .. } => Some(state),
        _ => None,
    }
}
