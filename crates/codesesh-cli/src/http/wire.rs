pub use codesesh_core::wire::{activity, head, referenced};
use codesesh_core::{
    model as core,
    search::SearchResult,
    wire::{self, closed},
};

type Result<T> = std::result::Result<T, serde::de::value::Error>;
pub fn search_result(
    value: SearchResult,
    parent: Option<wire::SearchResultParent>,
) -> Result<wire::SearchResult> {
    Ok(wire::SearchResult {
        session: wire::PublicReferencedSessionHead {
            reference: value.reference,
            session: head(value.session)?,
        },
        snippet: value.snippet,
        snippet_highlights: value.snippet_highlights,
        match_type: closed(value.match_type)?,
        message_index: value.message_index,
        parent,
    })
}
pub fn detail(mut value: core::SessionDetail) -> Result<wire::WireSessionDetail> {
    Ok(wire::WireSessionDetail {
        model_usage: value.head.model_usage.take(),
        project_identity_input_signature: value.head.project_identity_input_signature.take(),
        project_identity_resolver_revision: value.head.project_identity_resolver_revision.take(),
        smart_tags_classifier_revision: value.head.smart_tags_classifier_revision.take(),
        smart_tags_source_updated_at: value.head.smart_tags_source_updated_at.take(),
        head: head(value.head)?,
        detail_freshness: Some(closed(value.detail_freshness)?),
        messages: value
            .messages
            .into_iter()
            .map(message)
            .collect::<Result<_>>()?,
        message_total: None,
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
        cost_breakdown: value.cost_breakdown,
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
            approval_status,
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
                status: state.status,
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
