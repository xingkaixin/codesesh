use serde::Serialize;
use serde_json::Value;

pub fn stringify(value: &impl Serialize) -> serde_json::Result<String> {
    let value = serde_json::to_value(value)?;
    stringify_value(&value)
}
fn stringify_value(value: &Value) -> serde_json::Result<String> {
    let mut output = String::new();
    write(value, &mut output)?;
    Ok(output)
}
pub fn message_parts(
    head: &crate::contract::SessionHead,
    parts: &[crate::contract::MessagePart],
) -> serde_json::Result<String> {
    // Node cursors hash JSON text, including each adapter's property insertion order.
    let agent = head.reference.agent_name.as_str();
    let mut output = String::from("[");
    for (index, part) in parts.iter().enumerate() {
        let mut value = serde_json::to_value(part)?;
        let order: Option<&[&str]> = match (agent, value["type"].as_str()) {
            ("dsh" | "deepchat", Some("tool")) => {
                Some(&["type", "tool", "callID", "time_created", "state", "title"])
            }
            ("opencode" | "zcode", Some("tool")) if head.stats.total_tokens.is_some() => {
                Some(&["type", "tool", "callID", "time_created", "state", "title"])
            }
            ("grok", Some("image")) if value.get("data").is_some() => {
                Some(&["type", "data", "mime_type", "url", "time_created"])
            }
            _ => None,
        };
        if let Some(order) = order {
            let object = value.as_object_mut().expect("message part object");
            let mut old = std::mem::take(object);
            for key in order {
                if let Some(value) = old.shift_remove(*key) {
                    object.insert((*key).into(), value);
                }
            }
            for (key, value) in old {
                if !object.contains_key(&key) {
                    object.insert(key, value);
                }
            }
        }
        if index > 0 {
            output.push(',');
        }
        write(&value, &mut output)?;
    }
    output.push(']');
    Ok(output)
}

pub fn tokens(agent: &str, tokens: &crate::contract::MessageTokens) -> serde_json::Result<String> {
    let value = serde_json::to_value(tokens)?;
    if agent != "cherrystudio" {
        return stringify_value(&value);
    }
    let mut ordered = serde_json::Map::new();
    for key in ["input", "output", "cache_read", "cache_create", "reasoning"] {
        if let Some(value) = value.get(key) {
            ordered.insert(key.into(), value.clone());
        }
    }
    stringify_value(&Value::Object(ordered))
}

fn write(value: &Value, output: &mut String) -> serde_json::Result<()> {
    match value {
        Value::Number(number) => output.push_str(
            ryu_js::Buffer::new().format(number.as_f64().expect("JSON number is finite")),
        ),
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            output.push('{');
            let mut numeric = values
                .keys()
                .filter_map(|key| {
                    key.parse::<u32>()
                        .ok()
                        .filter(|index| *index < u32::MAX && index.to_string() == *key)
                        .map(|index| (index, key))
                })
                .collect::<Vec<_>>();
            numeric.sort_unstable_by_key(|(index, _)| *index);
            let keys = numeric
                .iter()
                .map(|(_, key)| *key)
                .chain(values.keys().filter(|key| {
                    !key.parse::<u32>()
                        .ok()
                        .is_some_and(|index| index < u32::MAX && index.to_string() == **key)
                }));
            for (index, key) in keys.enumerate() {
                let value = &values[key];
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key)?);
                output.push(':');
                write(value, output)?;
            }
            output.push('}');
        }
        value => output.push_str(&serde_json::to_string(value)?),
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn matches_javascript_number_notation() {
        assert_eq!(
            super::stringify(&serde_json::json!([1e-7, 1e-6, 1e20, 1e21, -0.0])).unwrap(),
            "[1e-7,0.000001,100000000000000000000,1e+21,0]"
        );
    }
}
