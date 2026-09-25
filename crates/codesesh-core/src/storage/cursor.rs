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
    format!("{:x}", hash.finalize())
}

pub fn advance(previous: &str, message: &Message, parts: &str) -> Result<String> {
    let tokens = message
        .tokens
        .as_ref()
        .map(super::json::stringify)
        .transpose()?;
    let cost_source = message
        .cost_source
        .as_ref()
        .map(crate::contract::CostSource::as_str);
    let completed = message.time_completed.map(|value| value.to_string());
    let mut hash = Sha256::new();
    hash.update("codesesh-session-messages-chain\0");
    for value in [
        Some(previous),
        Some(message.id.as_str()),
        Some(role_name(&message.role)),
        Some(&message.time_created.to_string()),
        completed.as_deref(),
        message.agent.as_deref(),
        message.mode.as_deref(),
        message.model.as_deref(),
        message.provider.as_deref(),
        tokens.as_deref(),
        Some(&message.cost.to_string()),
        cost_source,
        Some(parts),
        Some("1"),
        message.subagent_id.as_deref(),
        message.nickname.as_deref(),
    ] {
        field(&mut hash, value);
    }
    if message.automated == Some(true) {
        field(&mut hash, Some("automated"));
    }
    Ok(format!("{:x}", hash.finalize()))
}

pub fn encode(count: usize, digest: &str) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(format!(
        "{{\"version\":2,\"count\":{count},\"digest\":\"{digest}\"}}"
    )))
}
