use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn fixture(root: &Path, compressed: bool, extra: Value, events: &[Value]) -> PathBuf {
    let mut h = json!({"type":"session","version":0,"id":"child","cwd":"/tmp/project","createdAt":100,"delegationDepth":0});
    for (key, value) in extra.as_object().unwrap() {
        h[key] = value.clone();
    }
    let dir = root.join("sessions/--tmp-project--/child");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(if compressed {
        "session.jsonl.zstd"
    } else {
        "session.jsonl"
    });
    let mut bytes = Vec::new();
    for value in std::iter::once(&h).chain(events) {
        let line = format!("{value}\n");
        if compressed {
            bytes.extend(zstd::stream::encode_all(line.as_bytes(), 1).unwrap());
        } else {
            bytes.extend(line.as_bytes());
        }
    }
    fs::write(&path, bytes).unwrap();
    path
}
fn event(kind: &str, seq: u64, data: Value) -> Value {
    json!({"type":kind,"seq":seq,"time":100+seq,"surfaceOp":"append","data":data})
}
fn user(seq: u64, s: &str) -> Value {
    event(
        "user/message",
        seq,
        json!({"id":format!("u{seq}"),"source":{"kind":"user"},"content":[{"type":"text","text":s}]}),
    )
}
fn assistant(seq: u64, s: &str) -> Value {
    event(
        "assistant/message",
        seq,
        json!({"turn":1,"step":1,"message":{"id":"answer","source":{"provider":"deepseek","model":"deepseek-chat"},"content":[{"type":"text","text":s}]},"usage":{"inputTokens":10,"cacheReadTokens":3,"cacheWriteTokens":2,"outputTokens":8,"reasoningTokens":2}}),
    )
}
#[test]
fn plaintext_and_zstd_preserve_prefix_fork_usage_and_tools() {
    for compressed in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let events = vec![
            user(0, "Parent prompt"),
            assistant(1, "Parent reply"),
            user(2, "Child question"),
            event(
                "assistant/chunk",
                3,
                json!({"turn":2,"step":1,"chunk":{"type":"text-delta","index":0,"text":"obsolete"}}),
            ),
            event(
                "assistant/message",
                4,
                json!({"turn":2,"step":1,"message":{"id":"child-answer","source":{"model":"deepseek-chat"},"content":[{"type":"tool-call","id":"call","name":"read_file","arguments":"{\"path\":\"src/main.rs\"}"}]},"usage":{"inputTokens":10,"cacheReadTokens":3,"cacheWriteTokens":2,"outputTokens":8,"reasoningTokens":2}}),
            ),
            event(
                "tool/call",
                5,
                json!({"callId":"call","name":"read_file","arguments":{"path":"src/main.rs"}}),
            ),
            event(
                "tool/result",
                6,
                json!({"message":{"source":{"kind":"tool","callId":"call"},"content":[{"type":"tool-result","toolCallId":"call","content":[{"type":"text","text":"hello"}]}]}}),
            ),
        ];
        let path = fixture(
            temp.path(),
            compressed,
            json!({"parentSession":"parent","seedLength":2}),
            &events,
        );
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend(if compressed {
            &[0x28, 0xb5, 0x2f][..]
        } else {
            b"{unfinished"
        });
        fs::write(&path, bytes).unwrap();
        let parsed = scan(temp.path(), &Pricing::bundled()).unwrap();
        let d = &parsed[0].detail;
        assert_eq!(d.head.title, "Child question");
        assert_eq!(
            d.head.parent_reference.as_ref().unwrap().session_id,
            "parent"
        );
        assert_eq!(d.messages.len(), 2);
        assert_eq!(d.head.stats.total_input_tokens, 15.0);
        assert_eq!(d.head.stats.total_output_tokens, 8.0);
        assert_eq!(d.messages[1].parts.len(), 1);
        let MessagePart::Tool { state, .. } = &d.messages[1].parts[0] else {
            panic!("tool expected")
        };
        assert_eq!(state.status, "completed");
    }
}
#[test]
fn packed_rows_rebuild_stream_and_validate_sequence() {
    let temp = tempfile::tempdir().unwrap();
    let rows = vec![
        user(0, "Prompt"),
        event(
            "request/context",
            1,
            json!({"provider":"deepseek","model":"deepseek-chat"}),
        ),
        json!({"type":"text-chunks","seq0":2,"time0":102,"data":{"turn":1,"step":1,"index":0,"texts":["hello ","world"],"dt":[3]}}),
        event(
            "assistant/chunk",
            4,
            json!({"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":4,"outputTokens":5}}}),
        ),
    ];
    fixture(temp.path(), true, json!({}), &rows);
    let p = scan(temp.path(), &Pricing::bundled()).unwrap();
    let m = &p[0].detail.messages[1];
    assert_eq!(m.id, "dsh-step-1-1");
    assert_eq!(m.model.as_deref(), Some("deepseek-chat"));
    assert_eq!(m.tokens.as_ref().unwrap().input, Some(4.0));
    assert!(matches!(&m.parts[0],MessagePart::Text{text,..} if text=="hello world"));
    let mut bad = rows;
    bad[2]["seq0"] = json!(3);
    fixture(temp.path(), true, json!({}), &bad);
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
}
#[test]
fn attachments_require_verified_digest_and_keep_missing_placeholders() {
    let temp = tempfile::tempdir().unwrap();
    let bytes = b"test image";
    let digest = format!("{:x}", Sha256::digest(bytes));
    let attachment = json!({"type":"image","attachment":{"attachmentId":format!("sha256:{digest}"),"mediaType":"image/png","bytes":bytes.len()}});
    let mut prompt = user(0, "");
    prompt["data"]["content"] = json!([attachment]);
    fixture(temp.path(), false, json!({}), &[prompt]);
    let missing = scan(temp.path(), &Pricing::bundled()).unwrap();
    assert!(
        matches!(&missing[0].detail.messages[0].parts[0],MessagePart::Text{text,..} if text=="Image attachment unavailable")
    );
    let dir = temp
        .path()
        .join("attachments/v1/objects")
        .join(&digest[..2]);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(&digest), bytes).unwrap();
    let verified = scan_changed(
        temp.path(),
        &Pricing::bundled(),
        &[dir.join(&digest)],
        &missing,
    )
    .unwrap();
    assert!(matches!(
        &verified.upserts[0].detail.messages[0].parts[0],
        MessagePart::Image { data: Some(_), .. }
    ));
    fs::remove_file(dir.join(&digest)).unwrap();
    let deleted = scan_changed(
        temp.path(),
        &Pricing::bundled(),
        &[dir.join(&digest)],
        &verified.upserts,
    )
    .unwrap();
    assert!(
        matches!(&deleted.upserts[0].detail.messages[0].parts[0], MessagePart::Text { text, .. } if text == "Image attachment unavailable")
    );
    assert!(deleted.removed.is_empty());
}
#[test]
fn refuses_corrupt_headers_surface_placement_and_mixed_encodings() {
    let temp = tempfile::tempdir().unwrap();
    fixture(
        temp.path(),
        false,
        json!({"version":1}),
        &[user(0, "prompt")],
    );
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
    let mut missing = user(0, "prompt");
    missing.as_object_mut().unwrap().remove("surfaceOp");
    fixture(temp.path(), false, json!({}), &[missing]);
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
    fixture(temp.path(), true, json!({}), &[user(0, "prompt")]);
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
}

#[test]
fn matches_node_projection_for_forked_streamed_tools() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/node-projection.json")).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let projected = project::project(
        &fixture["header"],
        fixture["events"].as_array().unwrap(),
        temporary.path(),
        &Pricing::bundled(),
    )
    .unwrap();
    let expected: Vec<Message> =
        serde_json::from_value(fixture["expected"]["messages"].clone()).unwrap();
    fn numeric_json(mut value: Value) -> Value {
        match &mut value {
            Value::Number(number) => {
                *number = serde_json::Number::from_f64(number.as_f64().unwrap()).unwrap()
            }
            Value::Array(values) => values
                .iter_mut()
                .for_each(|value| *value = numeric_json(value.take())),
            Value::Object(values) => values
                .values_mut()
                .for_each(|value| *value = numeric_json(value.take())),
            _ => {}
        }
        value
    }
    assert_eq!(
        numeric_json(serde_json::to_value(&projected.messages).unwrap()),
        numeric_json(serde_json::to_value(&expected).unwrap())
    );
    let stats: SessionStats = serde_json::from_value(fixture["expected"]["stats"].clone()).unwrap();
    assert_eq!(projected.stats, stats);
    assert_eq!(
        projected.updated,
        fixture["expected"]["time_updated"].as_f64().unwrap()
    );
    assert_eq!(
        projected.title.and_then(|s| project::title(&s)).as_deref(),
        fixture["expected"]["title"].as_str()
    );
}

#[test]
#[ignore = "invoked by fixed-reference comparison script"]
fn export_reference_fixture() {
    let root = std::env::var("DSH_COMPARE_ROOT").unwrap();
    let mut sessions = scan(Path::new(&root), &Pricing::bundled()).unwrap();
    let mut cache = crate::storage::Cache::open(None).unwrap();
    cache.publish(&mut sessions).unwrap();
    let output = sessions
        .into_iter()
        .map(|s| {
            let detail = cache.detail(s.head.clone()).unwrap().unwrap();
            json!({"head":s.head,"detail":detail})
        })
        .collect::<Vec<_>>();
    fs::write(
        Path::new(&root).join("rust.json"),
        serde_json::to_vec_pretty(&output).unwrap(),
    )
    .unwrap();
}

#[test]
fn changed_scan_does_not_parse_unrelated_corrupt_artifacts() {
    let temp = tempfile::tempdir().unwrap();
    let path = fixture(temp.path(), false, json!({}), &[user(0, "keep")]);
    let other = temp.path().join("sessions/--tmp-project--/other");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("session.jsonl"), "invalid header\n").unwrap();
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
    let parsed = scan_changed(
        temp.path(),
        &Pricing::bundled(),
        std::slice::from_ref(&path),
        &[],
    )
    .unwrap();
    assert_eq!(parsed.upserts.len(), 1);
    fs::remove_file(&path).unwrap();
    let delta = scan_changed(temp.path(), &Pricing::bundled(), &[path], &parsed.upserts).unwrap();
    assert!(delta.upserts.is_empty());
    assert_eq!(
        delta.removed,
        vec![parsed.upserts[0].head.reference.clone()]
    );
}

#[test]
fn rejects_fractional_storage_times_and_preserves_safe_integer_precision() {
    let temp = tempfile::tempdir().unwrap();
    fixture(
        temp.path(),
        false,
        json!({"createdAt": 100.25}),
        &[user(0, "prompt")],
    );
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
    let mut fractional = user(0, "prompt");
    fractional["time"] = json!(100.25);
    fixture(temp.path(), false, json!({}), &[fractional]);
    assert!(scan(temp.path(), &Pricing::bundled()).is_err());
    let mut precise = user(0, "prompt");
    precise["time"] = json!(9_007_199_254_740_991_u64);
    fixture(
        temp.path(),
        false,
        json!({"createdAt": 9_007_199_254_740_990_u64}),
        &[precise],
    );
    let sessions = scan(temp.path(), &Pricing::bundled()).unwrap();
    assert_eq!(sessions[0].head.time_created, 9_007_199_254_740_990.0);
    assert_eq!(sessions[0].head.time_updated, 9_007_199_254_740_991.0);
    assert_eq!(
        sessions[0].detail.messages[0].time_created,
        9_007_199_254_740_991.0
    );
}
