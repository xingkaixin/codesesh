use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::{fs, path::Path};

pub fn encode(raw: &str) -> Result<String> {
    ensure!(!raw.is_empty(), "empty DSH path segment");
    if raw == "." || raw == ".." {
        return Ok("~002E".repeat(raw.len()));
    }
    Ok(raw.encode_utf16().map(unit).collect())
}
fn unit(c: u16) -> String {
    if c < 128 && ((c as u8).is_ascii_alphanumeric() || b"._-".contains(&(c as u8))) {
        (c as u8 as char).to_string()
    } else {
        format!("~{c:04X}")
    }
}
pub fn project(cwd: &str) -> Result<String> {
    ensure!(!cwd.is_empty(), "empty DSH project path");
    let mut text = String::new();
    let mut separator = false;
    for c in cwd.encode_utf16() {
        if [47, 92, 58].contains(&c) {
            if !separator {
                text.push('-');
            }
            separator = true;
        } else {
            text.push_str(&unit(c));
            separator = false;
        }
    }
    let slug = text.trim_start_matches('-');
    Ok(format!(
        "--{}--",
        if slug.is_empty() {
            "root"
        } else {
            &slug[..slug.len().min(251)]
        }
    ))
}
fn integer(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}
fn count(v: &Value) -> bool {
    integer(v) && v.as_f64().unwrap() >= 0.0
}
fn header(v: &Value) -> Result<()> {
    ensure!(
        v["version"].as_f64() == Some(0.0),
        "unsupported DSH session format version"
    );
    ensure!(
        v["type"] == "session" && v["id"].as_str().is_some_and(|s| !s.is_empty()),
        "invalid DSH session header identity"
    );
    ensure!(
        count(&v["createdAt"]) && count(&v["delegationDepth"]),
        "invalid DSH header count"
    );
    for key in ["cwd", "parentSession", "agentPreset"] {
        ensure!(
            v.get(key).is_none_or(Value::is_string),
            "invalid DSH header {key}"
        );
    }
    ensure!(
        v.get("seedLength").is_none_or(count),
        "invalid DSH seedLength"
    );
    ensure!(
        v.get("origin").is_none_or(|x| x == "subagent"),
        "invalid DSH origin"
    );
    Ok(())
}
fn expand(row: Value) -> Result<Vec<Value>> {
    let tag = row["type"].as_str().unwrap_or("");
    if !["text-chunks", "reasoning-chunks", "tool-call-chunks"].contains(&tag) {
        const KNOWN: &str = "agent-preset/selected agent/inbox/spliced approval/asked approval/decided approval/policy assistant/chunk assistant/message command/done command/run compaction/end compaction/prune compaction/start compaction/summary feedback/record goal/change hook/invoked hook/result llm/retry llm/retry-started permission/preset plan/mode request/context request/header sandbox/mode schedule/change session/end-seed session/title session/title-llm-request step/end step/start subagent/descriptor todo/write tool-workflow/agent-end tool-workflow/agent-start tool-workflow/run-end tool-workflow/run-start tool/call tool/code-dispatch tool/code-dispatch-start tool/result turn/end turn/start user/message web/deepseek-search-llm-request";
        ensure!(
            !tag.is_empty() && (KNOWN.split(' ').any(|x| x == tag) || row["ignorable"] == true),
            "unsupported required DSH event {tag}"
        );
        ensure!(
            count(&row["seq"]) && integer(&row["time"]),
            "invalid DSH event seq/time"
        );
        return Ok(vec![row]);
    }
    ensure!(
        count(&row["seq0"]) && integer(&row["time0"]),
        "invalid DSH chunk seq/time"
    );
    let d = &row["data"];
    let tool = tag == "tool-call-chunks";
    ensure!(
        ["turn", "step", "index"].iter().all(|k| d[k].is_number()),
        "invalid DSH chunk coordinates"
    );
    let values = d[if tool { "args" } else { "texts" }]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid DSH chunk members"))?;
    let gaps = d["dt"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("invalid DSH chunk gaps"))?;
    ensure!(
        !values.is_empty()
            && values.iter().all(Value::is_string)
            && gaps.len() + 1 == values.len()
            && gaps.iter().all(integer),
        "invalid DSH chunk run"
    );
    ensure!(
        !tool || (d["id"].is_string() && d.get("name").is_none_or(Value::is_string)),
        "invalid DSH tool chunk identity"
    );
    let mut time = row["time0"].as_f64().unwrap() as i64;
    let seq = row["seq0"].as_f64().unwrap() as u64;
    let mut events = Vec::new();
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            time = time
                .checked_add(gaps[i - 1].as_f64().unwrap() as i64)
                .ok_or_else(|| anyhow::anyhow!("DSH time overflow"))?;
        }
        ensure!(
            time.unsigned_abs() <= 9_007_199_254_740_991 && seq + i as u64 <= 9_007_199_254_740_991,
            "DSH chunk overflow"
        );
        let chunk = if tool {
            let mut c = json!({"type":"tool-call-delta","index":d["index"],"id":d["id"],"argumentsDelta":value});
            if let Some(name) = d.get("name") {
                c["name"] = name.clone();
            }
            c
        } else {
            json!({"type":if tag=="text-chunks" {"text-delta"}else{"reasoning-delta"},"index":d["index"],"text":value})
        };
        events.push(json!({"type":"assistant/chunk","seq":seq+i as u64,"time":time,"data":{"turn":d["turn"],"step":d["step"],"chunk":chunk}}));
    }
    Ok(events)
}
fn frames(bytes: &[u8]) -> Result<Vec<&[u8]>> {
    let mut frames = Vec::new();
    let mut o = 0;
    'frame: while o < bytes.len() {
        let start = o;
        if bytes.len() - o < 4 {
            break;
        }
        ensure!(
            bytes[o..o + 4] == [0x28, 0xb5, 0x2f, 0xfd],
            "invalid DSH zstd magic"
        );
        o += 4;
        if o == bytes.len() {
            break;
        }
        let d = bytes[o];
        o += 1;
        ensure!(d & 0x18 == 0, "reserved zstd header bits");
        let flag = d >> 6;
        let single = d & 0x20 != 0;
        let dictionary = d & 3;
        let extra = usize::from(!single)
            + if dictionary == 3 {
                4
            } else {
                dictionary as usize
            }
            + if flag == 0 {
                usize::from(single)
            } else {
                1 << flag
            };
        if bytes.len() - o < extra {
            break;
        }
        o += extra;
        loop {
            if bytes.len() - o < 3 {
                break 'frame;
            }
            let b = u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], 0]);
            o += 3;
            let kind = (b >> 1) & 3;
            ensure!(kind != 3, "reserved zstd block type");
            let size = if kind == 1 { 1 } else { (b >> 3) as usize };
            if bytes.len() - o < size {
                break 'frame;
            }
            o += size;
            if b & 1 != 0 {
                break;
            }
        }
        if d & 4 != 0 {
            if bytes.len() - o < 4 {
                break;
            }
            o += 4;
        }
        frames.push(&bytes[start..o]);
    }
    Ok(frames)
}
pub fn read(path: &Path, compressed: bool) -> Result<(Value, Vec<Value>)> {
    let mut stable = None;
    for _ in 0..3 {
        let before = fs::metadata(path)?;
        let bytes = fs::read(path)?;
        let after = fs::metadata(path)?;
        if same_identity(&before, &after)? && bytes.len() as u64 == after.len() {
            stable = Some(bytes);
            break;
        }
    }
    let bytes = stable.ok_or_else(|| anyhow::anyhow!("DSH source changed while reading"))?;
    let mut lines = Vec::new();
    if compressed {
        let complete = frames(&bytes)?;
        if complete.iter().map(|frame| frame.len()).sum::<usize>() < bytes.len() {
            warn_tail(path, "zstd");
        }
        for (index, frame) in complete.into_iter().enumerate() {
            let decoded = zstd::stream::decode_all(frame)?;
            let text = String::from_utf8_lossy(&decoded);
            ensure!(
                text.ends_with('\n'),
                "DSH complete zstd frame ends mid-record"
            );
            let records: Vec<_> = text[..text.len() - 1]
                .split('\n')
                .map(str::to_owned)
                .collect();
            ensure!(
                index != 0 || records.len() == 1,
                "DSH header frame must contain one record"
            );
            lines.extend(records);
        }
    } else {
        let text = String::from_utf8_lossy(&bytes);
        let Some(end) = text.rfind('\n') else {
            bail!("DSH missing complete header");
        };
        if end + 1 != text.len() {
            warn_tail(path, "none");
        }
        lines.extend(text[..end].split('\n').map(str::to_owned));
    }
    ensure!(!lines.is_empty(), "DSH missing complete header");
    let head: Value = serde_json::from_str(&lines[0])?;
    header(&head)?;
    let mut events = Vec::new();
    for line in &lines[1..] {
        for event in expand(serde_json::from_str(line)?)? {
            ensure!(
                event["seq"].as_f64() == Some(events.len() as f64),
                "DSH noncontiguous event sequence"
            );
            events.push(event);
        }
    }
    ensure!(
        head["seedLength"].as_f64().unwrap_or(0.0) <= events.len() as f64,
        "DSH seed exceeds event count"
    );
    Ok((head, events))
}

fn same_identity(a: &fs::Metadata, b: &fs::Metadata) -> Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if a.dev() != b.dev()
            || a.ino() != b.ino()
            || a.ctime() != b.ctime()
            || a.ctime_nsec() != b.ctime_nsec()
        {
            return Ok(false);
        }
    }
    Ok(
        a.len() == b.len()
            && a.modified()? == b.modified()?
            && a.created().ok() == b.created().ok(),
    )
}

fn warn_tail(path: &Path, encoding: &str) {
    eprintln!(
        "{}",
        json!({"level":"warn", "event":"dsh.torn_session_tail", "source_path":path, "encoding":encoding})
    );
}
