use super::*;

pub(super) fn transcript(
    records: &[Value],
    id: &str,
    fallback: f64,
    initial_model: Option<String>,
) -> Vec<Message> {
    let mut messages: Vec<Message> = Vec::new();
    let mut active: Option<usize> = None;
    let mut user_prompt: Option<i64> = None;
    let mut assistant_prompt: Option<String> = None;
    let mut mode = None;
    let mut model = initial_model;
    let mut latest_plan: Option<(usize, usize)> = None;
    let mut tools = HashMap::<String, (usize, usize)>::new();
    for index in canonical(records, fallback) {
        let Some(e) = unpack(&records[index], fallback) else {
            continue;
        };
        let u = e.update;
        let kind = text(&u["sessionUpdate"]);
        if e.method == XAI {
            match kind {
                "model_changed" => model = string(&u["model_id"]).or(model),
                "model_auto_switched" => model = string(&u["new_model_id"]).or(model),
                "subagent_spawned" => {
                    if let Some(i) = active.filter(|i| messages[*i].role == Role::Assistant)
                        && messages[i].subagent_id.is_none()
                    {
                        messages[i].subagent_id = string(&u["child_session_id"])
                    }
                }
                "turn_completed" => {
                    if let Some(usage) = usage(u) {
                        let usage_model = if usage.models.len() == 1 {
                            usage.models.keys().next().cloned()
                        } else {
                            model.clone()
                        };
                        let target = messages
                            .iter()
                            .rposition(|m| m.role == Role::Assistant && m.tokens.is_none())
                            .or_else(|| {
                                messages.iter().rposition(|m| {
                                    m.role == Role::Assistant && m.model == usage_model
                                })
                            });
                        if let Some(i) = target {
                            let m = &mut messages[i];
                            if let Some(t) = m.tokens.as_mut() {
                                merge_tokens(t, &usage.tokens);
                                m.cost = Some(m.cost.unwrap_or(0.0) + usage.cost.unwrap_or(0.0))
                            } else {
                                m.tokens = Some(usage.tokens);
                                m.model = m.model.clone().or(usage_model);
                                if let Some(c) = usage.cost {
                                    m.cost = Some(c)
                                }
                            }
                            if usage.cost.is_some() {
                                m.cost_source = Some(CostSource::Recorded)
                            }
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if kind == "current_mode_update" {
            mode = string(&u["currentModeId"]);
            continue;
        }
        if kind == "tool_call_update" {
            if let Some((i, p)) = string(&u["toolCallId"]).and_then(|id| tools.get(&id).copied())
                && let MessagePart::Tool { state, .. } = &mut messages[i].parts[p]
            {
                let s = status(&u["status"]);
                if let Some(s) = s {
                    state.status = s.into()
                }
                if let Some(v) = u.get("rawInput") {
                    state.input = Some(v.clone())
                }
                if let Some(v) = output(u) {
                    if s == Some("error") {
                        state.error = Some(v)
                    } else {
                        state.output = Some(v)
                    }
                }
                let meta = state.metadata.get_or_insert(json!({}));
                for key in ["kind", "locations"] {
                    if let Some(v) = u.get(key) {
                        meta[key] = v.clone()
                    }
                }
            }
            continue;
        }
        if kind == "user_message_chunk" {
            if u["_meta"]["hostTurn"] == true {
                continue;
            }
            let Some(p) = part(&u["content"], e.time) else {
                continue;
            };
            let prompt = u["_meta"]["promptIndex"]
                .as_i64()
                .filter(|n| n.unsigned_abs() <= SAFE as u64);
            let reuse = active.filter(|i| {
                messages[*i].role == Role::User
                    && (prompt.is_none() || user_prompt.is_none() || prompt == user_prompt)
            });
            let i = reuse.unwrap_or_else(|| {
                let id = string(&e.params["_meta"]["eventId"])
                    .unwrap_or_else(|| format!("{id}-user-{}", e.time));
                messages.push(message(Role::User, id, e.time, None, None));
                messages.len() - 1
            });
            match (messages[i].parts.last_mut(), p) {
                (Some(MessagePart::Text { text: a, .. }), MessagePart::Text { text: b, .. }) => {
                    a.push_str(&b)
                }
                (_, p) => messages[i].parts.push(p),
            }
            active = Some(i);
            user_prompt = prompt;
            assistant_prompt = None;
            latest_plan = None;
            continue;
        }
        let mut p = match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let t = block_text(&u["content"]);
                if clean(t).is_empty() {
                    continue;
                }
                if kind == "agent_message_chunk" {
                    MessagePart::Text {
                        text: t.into(),
                        time_created: Some(e.time),
                    }
                } else {
                    MessagePart::Reasoning {
                        text: t.into(),
                        time_created: Some(e.time),
                    }
                }
            }
            "plan" => {
                let Some(p) = plan(u, e.time) else { continue };
                p
            }
            "tool_call" => {
                let Some(call_id) = string(&u["toolCallId"]) else {
                    continue;
                };
                let native = &u["_meta"]["x.ai/tool"];
                let name = string(&native["name"])
                    .or_else(|| string(&u["title"]))
                    .unwrap_or("tool".into());
                let mut meta = json!({});
                if let Some(kind) = native
                    .get("kind")
                    .filter(|v| v.is_string())
                    .or_else(|| u.get("kind").filter(|v| v.is_string()))
                {
                    meta["kind"] = kind.clone()
                }
                if let Some(v) = u.get("locations") {
                    meta["locations"] = v.clone()
                }
                MessagePart::Tool {
                    title: Some(tool_title(&name).into()),
                    tool: name,
                    call_id: Some(call_id),
                    state: Box::new(ToolState {
                        status: status(&u["status"]).unwrap_or("running").into(),
                        input: u.get("rawInput").cloned(),
                        output: Some(Value::Null),
                        error: None,
                        metadata: Some(meta),
                    }),
                    time_created: Some(e.time),
                }
            }
            _ => continue,
        };
        let prompt = string(&e.params["_meta"]["promptId"]);
        let reuse = active.filter(|i| {
            messages[*i].role == Role::Assistant
                && !(prompt.is_some() && assistant_prompt.is_some() && prompt != assistant_prompt)
        });
        let i = reuse.unwrap_or_else(|| {
            latest_plan = None;
            let mid = string(&e.params["_meta"]["promptId"])
                .or_else(|| string(&e.params["_meta"]["eventId"]))
                .unwrap_or_else(|| format!("{id}-assistant-{}", e.time));
            messages.push(message(
                Role::Assistant,
                mid,
                e.time,
                model.clone(),
                mode.clone(),
            ));
            messages.len() - 1
        });
        assistant_prompt = prompt.or_else(|| {
            if reuse.is_some() {
                assistant_prompt.take()
            } else {
                None
            }
        });
        active = Some(i);
        user_prompt = None;
        if let MessagePart::Plan { .. } = p {
            if let Some((mi, pi)) = latest_plan {
                messages[mi].parts[pi] = p;
                continue;
            }
            latest_plan = Some((i, messages[i].parts.len()));
        }
        let merged = match (messages[i].parts.last_mut(), &mut p) {
            (Some(MessagePart::Text { text: a, .. }), MessagePart::Text { text: b, .. })
            | (
                Some(MessagePart::Reasoning { text: a, .. }),
                MessagePart::Reasoning { text: b, .. },
            ) => {
                a.push_str(b);
                true
            }
            _ => false,
        };
        if merged {
            continue;
        }
        if let MessagePart::Tool {
            call_id: Some(id), ..
        } = &p
        {
            tools.insert(id.clone(), (i, messages[i].parts.len()));
            messages[i].mode = Some("tool".into())
        } else if messages[i].mode.is_none() {
            messages[i].mode = mode.clone()
        }
        if messages[i].model.is_none() {
            messages[i].model = model.clone()
        }
        messages[i].parts.push(p);
    }
    for m in &mut messages {
        m.parts.retain_mut(|p| match p {
            MessagePart::Text { text, .. }
            | MessagePart::Reasoning { text, .. }
            | MessagePart::Plan { text, .. } => {
                *text = clean(text);
                !text.is_empty()
            }
            MessagePart::Tool { title, state, .. } => {
                *title = title.take().map(|s| clean(&s)).filter(|s| !s.is_empty());
                for v in [
                    &mut state.input,
                    &mut state.output,
                    &mut state.error,
                    &mut state.metadata,
                ]
                .into_iter()
                .flatten()
                {
                    clean_value(v)
                }
                true
            }
            _ => true,
        });
    }
    messages.retain(|m| {
        !m.parts.is_empty()
            || m.cost.unwrap_or(0.0) > 0.0
            || m.tokens.as_ref().is_some_and(|t| {
                [t.input, t.output, t.reasoning, t.cache_read, t.cache_create]
                    .into_iter()
                    .flatten()
                    .any(|n| n > 0.0)
            })
    });
    messages
}
