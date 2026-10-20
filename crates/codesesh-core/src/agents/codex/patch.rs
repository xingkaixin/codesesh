use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub fn parse(input: &Value) -> Value {
    let Some(text) = input.as_str() else {
        return Value::Array(Vec::new());
    };
    static HEADER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\*\*\*\s+(Add|Delete|Update|Move)\s+File:\s*(.+)").unwrap());
    static MOVE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"\*\*\*\s+Move to:\s*(.+)").unwrap());
    let lines = text.split('\n').collect::<Vec<_>>();
    let mut blocks = Vec::new();
    let mut active = false;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if !active && line.contains("*** Begin Patch") {
            active = true;
            continue;
        }
        if active && line.contains("*** End Patch") {
            active = false;
            continue;
        }
        if !active {
            continue;
        }
        let Some(header) = HEADER.captures(line) else {
            continue;
        };
        let action = &header[1];
        let path = header[2].trim();
        if action == "Delete" {
            blocks.push(json!({"type":"delete_file","path":path}));
            continue;
        }
        if !matches!(action, "Add" | "Update") {
            continue;
        }
        let mut target = None;
        if action == "Update" {
            let next = (index..lines.len()).find(|next| !lines[*next].trim().is_empty());
            if let Some(next) = next
                && let Some(moved) = MOVE.captures(lines[next])
            {
                target = Some(moved[1].trim().to_owned());
                index = next + 1;
            }
        }
        let start = index;
        while index < lines.len()
            && !HEADER.is_match(lines[index])
            && !lines[index].contains("*** End Patch")
        {
            index += 1;
        }
        let content = lines[start..index].join("\n");
        blocks.push(if let Some(target) = target { json!({"type":"move_file","path":path,"targetPath":target,"content":content}) }
            else { json!({"type":if action=="Add" {"write_file"}else{"edit_file"},"path":path,"content":content}) });
    }
    Value::Array(blocks)
}
