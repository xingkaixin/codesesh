use serde::Serialize;
use serde_json::Value;

pub fn stringify(value: &impl Serialize) -> serde_json::Result<String> {
    let mut value = serde_json::to_value(value)?;
    integers(&mut value);
    serde_json::to_string(&value)
}

fn integers(value: &mut Value) {
    match value {
        Value::Number(number) if number.is_f64() => {
            if let Some(float) = number.as_f64()
                && float.fract() == 0.0
                && float.abs() <= 9_007_199_254_740_991.0
            {
                *number = serde_json::Number::from(float as i64);
            }
        }
        Value::Array(values) => {
            for value in values {
                integers(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                integers(value);
            }
        }
        _ => {}
    }
}
