import type { SessionHead as RuntimeSessionHead } from "./generated/SessionHead.js";
import type { WireSessionHead } from "./generated/WireSessionHead.js";
import type { WireSessionDetail } from "./generated/WireSessionDetail.js";
import type { WireSessionListPage } from "./generated/WireSessionListPage.js";
import type { WireMessagePart } from "./generated/WireMessagePart.js";
import type { WireImageDataPart } from "./generated/WireImageDataPart.js";
import type { WireImageUrlPart } from "./generated/WireImageUrlPart.js";
import type { SmartTag } from "./generated/SmartTag.js";
import type { PublicReferencedSessionHead } from "./generated/PublicReferencedSessionHead.js";

export type { SessionStats } from "./generated/SessionStats.js";

export type { CostSource } from "./generated/CostSource.js";

export type { MessageTokens } from "./generated/MessageTokens.js";

export type { SmartTag } from "./generated/SmartTag.js";

export type { FileActivityKind } from "./generated/FileActivityKind.js";

export type { WireSessionFileActivity as SessionFileActivity } from "./generated/WireSessionFileActivity.js";

export type { SessionFileActivityOccurrence } from "./generated/SessionFileActivityOccurrence.js";

export type { WireProjectIdentity as ProjectIdentity } from "./generated/WireProjectIdentity.js";

export type { ProjectGroup } from "./generated/ProjectGroup.js";

export type { ToolPartStatus } from "./generated/ToolPartStatus.js";

export type { WireToolState as ToolPartState } from "./generated/WireToolState.js";

export type { WireMessage as Message } from "./generated/WireMessage.js";

export type { PublicReferencedSessionHead } from "./generated/PublicReferencedSessionHead.js";

export type { ProjectIdentityKind, ProjectIdentityRef } from "./project-identity.js";

export const SMART_TAGS = [
  "bugfix",
  "refactoring",
  "feature-dev",
  "testing",
  "docs",
  "git-ops",
  "build-deploy",
  "exploration",
  "planning",
] as const satisfies readonly SmartTag[];

export function isSmartTag(value: string): value is SmartTag {
  return SMART_TAGS.some((tag) => tag === value);
}

export type MessagePart = WireMessagePart;

export type TextPart = Extract<MessagePart, { type: "text" }>;

export type ReasoningPart = Extract<MessagePart, { type: "reasoning" }>;

export type PlanPart = Extract<MessagePart, { type: "plan" }>;

export type ToolPart = Extract<MessagePart, { type: "tool" }>;

export type ImagePart = Extract<MessagePart, { type: "image" }>;

export type ImageDataPart = { type: "image" } & WireImageDataPart;

export type ImageUrlPart = { type: "image" } & WireImageUrlPart;

type InternalSessionHeadField =
  | "model_usage"
  | "project_identity_resolver_revision"
  | "project_identity_input_signature"
  | "smart_tags_source_updated_at"
  | "smart_tags_classifier_revision";

export type SessionHead = WireSessionHead &
  Partial<Pick<RuntimeSessionHead, InternalSessionHeadField>>;

export type IdentifiedSessionHead = SessionHead & Required<Pick<SessionHead, "project_identity">>;

export type PublicSessionHead = WireSessionHead;

export type PublicIdentifiedSessionHead = WireSessionHead &
  Required<Pick<WireSessionHead, "project_identity">>;

export type SessionListPage = Omit<WireSessionListPage, "sessions"> & {
  sessions: PublicIdentifiedSessionHead[];
};

export type ReferencedSessionHead = Omit<PublicReferencedSessionHead, "session"> & {
  session: SessionHead;
};

export type SessionDetail = WireSessionDetail;

export type IdentifiedSessionDetail = SessionDetail &
  Required<Pick<SessionDetail, "project_identity">>;

export function assertIdentifiedSessionHead(
  session: SessionHead,
): asserts session is IdentifiedSessionHead {
  if (session.project_identity) return;
  throw new Error(
    `Session ${session.reference.agentName}/${session.reference.sessionId} is missing project_identity`,
  );
}

export function toPublicSessionHead<T extends SessionHead>(
  session: T,
): Omit<T, InternalSessionHeadField> {
  const {
    model_usage: _modelUsage,
    project_identity_resolver_revision: _resolverRevision,
    project_identity_input_signature: _identityInputSignature,
    smart_tags_source_updated_at: _smartTagsSourceUpdatedAt,
    smart_tags_classifier_revision: _classifierRevision,
    ...publicSession
  } = session;
  return publicSession;
}

export function toPublicReferencedSessionHead<T extends ReferencedSessionHead>(
  item: T,
): Omit<T, "session"> & { session: PublicSessionHead } {
  return { ...item, session: toPublicSessionHead(item.session) };
}
