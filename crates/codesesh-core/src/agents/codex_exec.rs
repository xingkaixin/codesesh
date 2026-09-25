use std::{collections::HashMap, sync::LazyLock};

use regex::Regex;
use serde_json::{Map, Number, Value};

#[derive(Debug, PartialEq)]
pub struct ExecInnerCall {
    pub name: String,
    pub args: Value,
}

pub fn split_tool_name(name: &str) -> (&str, Option<&str>) {
    if name.starts_with("mcp__")
        && let Some(separator) = name.rfind("__")
        && separator > 0
        && separator + 2 < name.len()
    {
        return (&name[separator + 2..], Some(&name[..separator + 2]));
    }
    (name, None)
}

pub fn output_target(calls: &[ExecInnerCall]) -> Option<usize> {
    calls
        .iter()
        .rposition(|call| !matches!(split_tool_name(&call.name).0, "apply_patch" | "update_plan"))
        .or_else(|| calls.len().checked_sub(1))
}

pub fn patch_text(args: &Value) -> &str {
    args.as_str()
        .or_else(|| args.get("patch").and_then(Value::as_str))
        .unwrap_or("")
}

pub fn decode(input: &Value) -> Vec<ExecInnerCall> {
    static ASSIGN: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*").unwrap()
    });
    static CALL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"tools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(").unwrap());
    let Some(input) = input.as_str().filter(|input| input.contains("tools.")) else {
        return Vec::new();
    };
    let mut scope = HashMap::new();
    let mut pos = 0;
    while let Some(capture) = ASSIGN.captures_at(input, pos) {
        pos = capture.get(0).unwrap().end();
        let mut reader = Reader::new(input, pos, &scope);
        if let Some(value) = reader.value(0) {
            pos = reader.pos;
            if let Some(Value::String(value)) = value {
                scope.insert(capture[1].to_owned(), value);
            }
        }
    }
    let mut calls = Vec::new();
    pos = 0;
    while let Some(capture) = CALL.captures_at(input, pos) {
        pos = capture.get(0).unwrap().end();
        let mut reader = Reader::new(input, pos, &scope);
        if let Some(args) = reader.value(0) {
            calls.push(ExecInnerCall {
                name: capture[1].to_owned(),
                args: args.unwrap_or(Value::Null),
            });
            pos = reader.pos;
        }
    }
    calls
}

struct Reader<'a> {
    src: &'a str,
    pos: usize,
    scope: &'a HashMap<String, String>,
}

impl<'a> Reader<'a> {
    fn new(src: &'a str, pos: usize, scope: &'a HashMap<String, String>) -> Self {
        Self { src, pos, scope }
    }

    fn peek(&self) -> Option<u8> {
        self.src.as_bytes().get(self.pos).copied()
    }

    // The outer Option marks parse failure; the inner Option represents JS undefined.
    fn value(&mut self, depth: usize) -> Option<Option<Value>> {
        if depth > 256 {
            return None;
        }
        self.trivia();
        match self.peek()? {
            b'{' => self.object(depth + 1).map(Some),
            b'[' => self.array(depth + 1).map(Some),
            quote @ (b'"' | b'\'' | b'`') => Some(Some(Value::String(self.string(quote)))),
            b'-' | b'+' | b'0'..=b'9' => self.number().map(Some),
            b'A'..=b'Z' | b'a'..=b'z' | b'_' | b'$' => {
                let name = self.identifier();
                Some(match name {
                    "true" => Some(Value::Bool(true)),
                    "false" => Some(Value::Bool(false)),
                    "null" => Some(Value::Null),
                    "undefined" => None,
                    _ => self.scope.get(name).cloned().map(Value::String),
                })
            }
            _ => None,
        }
    }

    fn object(&mut self, depth: usize) -> Option<Value> {
        self.pos += 1;
        let mut result = Map::new();
        self.trivia();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Some(Value::Object(result));
        }
        loop {
            self.trivia();
            let key = match self.peek()? {
                quote @ (b'"' | b'\'' | b'`') => self.string(quote),
                b'A'..=b'Z' | b'a'..=b'z' | b'_' | b'$' => self.identifier().to_owned(),
                _ => return None,
            };
            self.trivia();
            let value = if self.peek() == Some(b':') {
                self.pos += 1;
                self.value(depth)?
            } else {
                self.scope.get(&key).cloned().map(Value::String)
            };
            if let Some(value) = value {
                result.insert(key, value);
            } else {
                result.remove(&key);
            }
            self.trivia();
            match self.peek()? {
                b',' => {
                    self.pos += 1;
                    self.trivia();
                    if self.peek() != Some(b'}') {
                        continue;
                    }
                }
                b'}' => {}
                _ => return None,
            }
            self.pos += 1;
            return Some(Value::Object(result));
        }
    }

    fn array(&mut self, depth: usize) -> Option<Value> {
        self.pos += 1;
        let mut result = Vec::new();
        self.trivia();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Some(Value::Array(result));
        }
        loop {
            result.push(self.value(depth)?.unwrap_or(Value::Null));
            self.trivia();
            match self.peek()? {
                b',' => {
                    self.pos += 1;
                    self.trivia();
                    if self.peek() != Some(b']') {
                        continue;
                    }
                }
                b']' => {}
                _ => return None,
            }
            self.pos += 1;
            return Some(Value::Array(result));
        }
    }

    fn string(&mut self, quote: u8) -> String {
        self.pos += 1;
        let mut result = Vec::<u16>::new();
        while let Some(byte) = self.peek() {
            if byte == quote {
                self.pos += 1;
                break;
            }
            if byte == b'\\' {
                self.pos += 1;
                let Some(escaped) = self.peek() else { break };
                let replacement = match escaped {
                    b'n' => Some(10),
                    b't' => Some(9),
                    b'r' => Some(13),
                    b'b' => Some(8),
                    b'f' => Some(12),
                    b'v' => Some(11),
                    b'0' => Some(0),
                    _ => None,
                };
                if let Some(replacement) = replacement {
                    self.pos += 1;
                    result.push(replacement);
                    continue;
                }
                if matches!(escaped, b'u' | b'x') {
                    self.pos += 1;
                    let length = if escaped == b'u' { 4 } else { 2 };
                    if let Some(hex) = self.src.as_bytes().get(self.pos..self.pos + length)
                        && hex.iter().all(u8::is_ascii_hexdigit)
                    {
                        let text = std::str::from_utf8(hex).unwrap();
                        result.push(u16::from_str_radix(text, 16).unwrap());
                        self.pos += length;
                    } else {
                        result.push(escaped as u16);
                    }
                    continue;
                }
            }
            let character = self.src[self.pos..].chars().next().unwrap();
            self.pos += character.len_utf8();
            result.extend(character.encode_utf16(&mut [0; 2]).iter().copied());
        }
        String::from_utf16_lossy(&result)
    }

    fn number(&mut self) -> Option<Value> {
        static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new(
                r"^[-+]?(?:0[xX][0-9a-fA-F]+|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][-+]?[0-9]+)?)",
            )
            .unwrap()
        });
        let token = NUMBER.find(&self.src[self.pos..])?.as_str();
        self.pos += token.len();
        let number = if token.starts_with("0x") || token.starts_with("0X") {
            token[2..].bytes().fold(0.0, |value, digit| {
                value * 16.0 + (digit as char).to_digit(16).unwrap() as f64
            })
        } else {
            token.parse::<f64>().unwrap_or(f64::NAN)
        };
        Some(
            if number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0 {
                Value::Number(Number::from(number as i64))
            } else {
                Number::from_f64(number)
                    .map(Value::Number)
                    .unwrap_or(Value::Null)
            },
        )
    }

    fn identifier(&mut self) -> &'a str {
        let start = self.pos;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'$')
        {
            self.pos += 1;
        }
        &self.src[start..self.pos]
    }

    fn trivia(&mut self) {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r') => self.pos += 1,
                Some(b'/') if self.src[self.pos..].starts_with("//") => {
                    self.pos = self.src[self.pos + 2..]
                        .find('\n')
                        .map_or(self.src.len(), |offset| self.pos + 3 + offset);
                }
                Some(b'/') if self.src[self.pos..].starts_with("/*") => {
                    self.pos = self.src[self.pos + 2..]
                        .find("*/")
                        .map_or(self.src.len(), |offset| self.pos + 4 + offset);
                }
                _ => return,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn decodes_literals_and_string_variables_without_executing_programs() {
        let calls = decode(&json!(
            r#"const patch = "a: \"x\"\npath\\to";
            await tools.exec_command({cmd:'ls', workdir:`/tmp/p`, yield_time_ms:10000});
            await tools.apply_patch({patch});
            tools.update_plan({plan:[{step:"a",status:"done"},], explanation:"go"});"#
        ));
        assert_eq!(calls.len(), 3);
        assert_eq!(
            calls[0].args,
            json!({"cmd":"ls","workdir":"/tmp/p","yield_time_ms":10000})
        );
        assert_eq!(patch_text(&calls[1].args), "a: \"x\"\npath\\to");
        assert_eq!(
            calls[2].args,
            json!({"plan":[{"step":"a","status":"done"}],"explanation":"go"})
        );
        assert_eq!(output_target(&calls), Some(0));
    }

    #[test]
    fn preserves_undefined_serialization_and_tolerates_failed_calls() {
        let calls = decode(&json!(
            r#"tools.bad({x: fn()});
            tools.good({/* skip */ missing, drop:undefined, a:[true,false,null,missing,],
            hex:0x20, signedHex:-0x20, decimal:1.5e2, text:'\uD83D\uDE00\x41\v'});
            // comment
            tools.last({ok:1});"#
        ));
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "good");
        assert_eq!(
            calls[0].args,
            json!({"a":[true,false,null,null],"hex":32,"signedHex":null,"decimal":150,"text":"😀A\u{b}"})
        );
        assert_eq!(calls[1].args, json!({"ok":1}));
        assert!(decode(&Value::Null).is_empty());
        assert!(decode(&json!("console.log(1)")).is_empty());
    }

    #[test]
    fn routes_namespaced_tools_and_patch_output() {
        assert_eq!(
            split_tool_name("mcp__node_repl__js"),
            ("js", Some("mcp__node_repl__"))
        );
        assert_eq!(split_tool_name("exec_command"), ("exec_command", None));
        let calls = decode(&json!("tools.apply_patch('abc'); tools.update_plan({});"));
        assert_eq!(patch_text(&calls[0].args), "abc");
        assert_eq!(output_target(&calls), Some(1));
        assert_eq!(output_target(&[]), None);
    }
}
