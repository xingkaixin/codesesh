use super::role_name;
use crate::contract::{Message, SessionReference};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};

fn field(hash: &mut Sha256, value: Option<&str>) {
    if let Some(text) = value {
        hash.update(format!("v{}:", text.encode_utf16().count()));
        hash.update(text);
        hash.update(";");
    } else {
        hash.update("n;");
    }
}

pub fn initial(reference: &SessionReference) -> String {
    let mut hash = Sha256::new();
    hash.update("codesesh-session-messages\0");
    for value in ["2", &reference.agent_name, &reference.session_id] {
        field(&mut hash, Some(value));
    }
    crate::hash::hex(&hash.finalize())
}

pub fn advance(
    previous: &str,
    message: &Message,
    parts: &str,
    tokens: Option<&str>,
    format: i64,
) -> Result<String> {
    let cost_source = message
        .cost_source
        .as_ref()
        .map(crate::contract::CostSource::as_str);
    let cost = message
        .cost
        .map(|value| ryu_js::Buffer::new().format(value).to_owned());
    let completed = message
        .time_completed
        .map(|value| ryu_js::Buffer::new().format(value).to_owned());
    let created = ryu_js::Buffer::new()
        .format(message.time_created)
        .to_owned();
    let mut hash = Sha256::new();
    hash.update("codesesh-session-messages-chain\0");
    for value in [
        Some(previous),
        Some(message.id.as_str()),
        Some(role_name(&message.role)),
        Some(&created),
        completed.as_deref(),
        message.agent.as_deref(),
        message.mode.as_deref(),
        message.model.as_deref(),
        message.provider.as_deref(),
        tokens,
        cost.as_deref(),
        cost_source,
        Some(parts),
        Some(&format.to_string()),
        message.subagent_id.as_deref(),
        message.nickname.as_deref(),
    ] {
        field(&mut hash, value);
    }
    if message.automated == Some(true) {
        field(&mut hash, Some("automated"));
    }
    Ok(crate::hash::hex(&hash.finalize()))
}

pub fn encode(count: usize, digest: &str) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(format!(
        "{{\"version\":2,\"count\":{count},\"digest\":\"{digest}\"}}"
    )))
}
