use codesesh_core::{contract as core, public_contract as wire};
use serde::de::IntoDeserializer;

type Result<T> = std::result::Result<T, serde::de::value::Error>;
fn closed<T: serde::de::DeserializeOwned>(value: String) -> Result<T> {
    T::deserialize(value.into_deserializer())
}
pub fn head(value: core::SessionHead) -> Result<wire::WireSessionHead> {
    Ok(wire::WireSessionHead {
        reference: value.reference,
        title: value.title,
        display_title: value.display_title,
        directory: value.directory,
        parent_reference: value.parent_reference,
        project_identity: Some(wire::WireProjectIdentity {
            kind: closed(value.project_identity.kind)?,
            key: value.project_identity.key,
            display_name: value.project_identity.display_name,
        }),
        time_created: value.time_created,
        time_updated: Some(value.time_updated),
        stats: value.stats,
        smart_tags: Some(
            value
                .smart_tags
                .into_iter()
                .map(closed)
                .collect::<Result<_>>()?,
        ),
    })
}
pub fn referenced(value: core::SessionHead) -> Result<wire::PublicReferencedSessionHead> {
    Ok(wire::PublicReferencedSessionHead {
        reference: value.reference.clone(),
        session: head(value)?,
    })
}
pub fn activity(value: core::SessionFileActivity) -> Result<wire::WireSessionFileActivity> {
    Ok(wire::WireSessionFileActivity {
        reference: value.reference,
        project_identity_key: value.project_identity_key,
        path: value.path,
        kind: closed(value.kind)?,
        count: value.count as f64,
        latest_time: value.latest_time,
    })
}
pub fn detail(mut value: core::SessionDetail) -> Result<wire::WireSessionDetail> {
    let version = value.head.version.take().map(Some);
    let summary_files = value.head.summary_files.take();
    Ok(wire::WireSessionDetail {
        model_usage: value.head.model_usage.take(),
        project_identity_input_signature: value.head.project_identity_input_signature.take(),
        project_identity_resolver_revision: value.head.project_identity_resolver_revision.take(),
        smart_tags_classifier_revision: value.head.smart_tags_classifier_revision.take(),
        smart_tags_source_updated_at: value.head.smart_tags_source_updated_at.take(),
        head: head(value.head)?,
        version,
        summary_files,
        detail_freshness: Some(closed(value.detail_freshness)?),
        messages: value
            .messages
            .into_iter()
            .map(message)
            .collect::<Result<_>>()?,
        message_cursor: value.message_cursor,
        message_update: value.message_update.map(closed).transpose()?,
        file_activity: Some(
            value
                .file_activity
                .into_iter()
                .map(activity)
                .collect::<Result<_>>()?,
        ),
    })
}
pub(super) fn message(value: core::Message) -> Result<wire::WireMessage> {
    Ok(wire::WireMessage {
        id: value.id,
        role: value.role,
        agent: Some(value.agent),
        time_created: value.time_created,
        time_completed: Some(value.time_completed),
        mode: Some(value.mode),
        model: Some(value.model),
        provider: Some(value.provider),
        tokens: value.tokens,
        cost: value.cost,
        cost_source: value.cost_source,
        parts: value.parts.into_iter().map(part).collect::<Result<_>>()?,
        subagent_id: value.subagent_id,
        nickname: value.nickname,
        automated: value.automated,
    })
}
fn part(value: core::MessagePart) -> Result<wire::WireMessagePart> {
    use core::MessagePart as C;
    use wire::WireMessagePart as W;
    Ok(match value {
        C::Text { text, time_created } => W::Text(wire::WireTextPart { text, time_created }),
        C::Reasoning { text, time_created } => {
            W::Reasoning(wire::WireReasoningPart { text, time_created })
        }
        C::Plan {
            text,
            approval_status,
            time_created,
        } => W::Plan(wire::WirePlanPart {
            text,
            approval_status: closed(approval_status)?,
            time_created,
        }),
        C::Tool {
            tool,
            call_id,
            state,
            time_created,
            title,
        } => W::Tool(Box::new(wire::WireToolPart {
            tool,
            call_i_d: call_id,
            title,
            time_created,
            state: wire::WireToolState {
                status: closed(state.status)?,
                input: state.input,
                output: state.output,
                error: state.error,
                metadata: state.metadata,
            },
        })),
        C::Image {
            url,
            data,
            mime_type,
            time_created,
        } => W::Image(match (data, mime_type, url) {
            (Some(data), Some(mime_type), url) => {
                wire::WireImagePart::Data(wire::WireImageDataPart {
                    data,
                    mime_type,
                    url,
                    time_created,
                })
            }
            (data, mime_type, Some(url)) => wire::WireImagePart::Url(wire::WireImageUrlPart {
                url,
                data,
                mime_type,
                time_created,
            }),
            _ => return Err(serde::de::Error::custom("image has no supported content")),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_conversion_preserves_null_and_moves_arbitrary_tool_values() {
        let source = json!({
            "id":"m", "role":"assistant", "agent":null, "time_created":123.5,
            "time_completed":null, "mode":null, "model":"model", "provider":null,
            "parts":[{"type":"tool","tool":"read","state":{
                "status":"completed","input":null,"output":{"nested":[null,123.5,"text"]}
            }}]
        });
        let parsed = serde_json::from_value::<core::Message>(source.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(message(parsed).unwrap()).unwrap(),
            source
        );
    }

    #[test]
    fn unsupported_internal_closed_values_cannot_escape_on_the_wire() {
        let value = core::MessagePart::Plan {
            text: "plan".into(),
            approval_status: "unknown".into(),
            time_created: None,
        };
        assert!(part(value).is_err());
    }
}

#[cfg(test)]
mod detail_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detail_retains_metadata_that_list_heads_omit() {
        let source = json!({
            "reference":{"agentName":"codex","sessionId":"s"},
            "title":"session", "directory":"/project", "time_created":1.5,"time_updated":2.5,
            "project_identity":{"kind":"path","key":"/project","displayName":"project"},
            "stats":{"message_count":0,"total_input_tokens":0,"total_output_tokens":0,"total_cost":0},
            "smart_tags":[],"model_usage":{"model":5.5},
            "project_identity_input_signature":"signature", "project_identity_resolver_revision":"project-identity-v2",
            "smart_tags_classifier_revision":"v1", "smart_tags_source_updated_at":2.5,
            "messages":[],"detail_freshness":"fresh","file_activity":[]
        });
        let parsed: core::SessionDetail = serde_json::from_value(source.clone()).unwrap();
        let list = serde_json::to_value(head(parsed.head.clone()).unwrap()).unwrap();
        let detail = serde_json::to_value(detail(parsed).unwrap()).unwrap();
        for key in [
            "model_usage",
            "project_identity_input_signature",
            "project_identity_resolver_revision",
            "smart_tags_classifier_revision",
            "smart_tags_source_updated_at",
        ] {
            assert_eq!(detail[key], source[key]);
            assert!(list.get(key).is_none());
        }
    }
}
