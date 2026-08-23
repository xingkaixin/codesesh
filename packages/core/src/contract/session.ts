import type { ProjectIdentityKind } from "./project-identity.js";
import type { SessionIdentity, SessionReference } from "./session-reference.js";

export interface SessionStats {
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
  cost_source?: CostSource;
  total_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_create_tokens?: number;
}

export type CostSource = "recorded" | "estimated";

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
] as const;

export type SmartTag = (typeof SMART_TAGS)[number];

export function isSmartTag(value: string): value is SmartTag {
  return SMART_TAGS.some((tag) => tag === value);
}

export type FileActivityKind = "read" | "edit" | "write" | "delete";

export interface SessionFileActivity {
  reference: SessionReference;
  projectIdentityKey: string;
  path: string;
  kind: FileActivityKind;
  count: number;
  latestTime: number;
}

export interface SessionFileActivityOccurrence {
  path: string;
  kind: FileActivityKind;
  time: number;
  tool_label: string;
  message_index: number;
  tool_index: number;
}

export type { ProjectIdentityKind, ProjectIdentityRef } from "./project-identity.js";

export interface ProjectIdentity {
  kind: ProjectIdentityKind;
  key: string;
  displayName: string;
}

export interface ProjectGroup {
  identityKind: ProjectIdentityKind;
  identityKey: string;
  displayName: string;
  sources: string[];
  sessionCount: number;
  lastActivity: number | null;
}

export interface MessageTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache_read?: number;
  cache_create?: number;
}

export type ToolPartStatus = "running" | "completed" | "error";

export interface ToolPartState {
  status: ToolPartStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: unknown;
}

interface TimedMessagePart {
  time_created?: number;
}

export interface TextPart extends TimedMessagePart {
  type: "text";
  text: string;
}

export interface ReasoningPart extends TimedMessagePart {
  type: "reasoning";
  text: string;
}

export interface PlanPart extends TimedMessagePart {
  type: "plan";
  text: string;
  approval_status: "success" | "fail";
}

interface ImagePartBase extends TimedMessagePart {
  type: "image";
  mime_type?: string;
}

export interface ImageDataPart extends ImagePartBase {
  data: string;
  mime_type: string;
  url?: string;
}

export interface ImageUrlPart extends ImagePartBase {
  url: string;
  data?: string;
}

export type ImagePart = ImageDataPart | ImageUrlPart;

export interface ToolPart extends TimedMessagePart {
  type: "tool";
  tool: string;
  title?: string;
  callID?: string;
  state: ToolPartState;
}

export type MessagePart = TextPart | ToolPart | ReasoningPart | PlanPart | ImagePart;

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  agent?: string | null;
  time_created: number;
  time_completed?: number | null;
  mode?: string | null;
  model?: string | null;
  provider?: string | null;
  tokens?: MessageTokens;
  cost?: number;
  cost_source?: CostSource;
  parts: MessagePart[];
  subagent_id?: string;
  nickname?: string;
}

/** Lightweight metadata for session listing */
export interface SessionHead extends SessionIdentity {
  title: string;
  display_title?: string;
  directory: string;
  parent_reference?: SessionReference;
  project_identity?: ProjectIdentity;
  project_identity_resolver_revision?: string;
  project_identity_input_signature?: string;
  time_created: number;
  time_updated?: number;
  stats: SessionStats;
  model_usage?: Record<string, number>;
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
  smart_tags_classifier_revision?: string;
}

export interface IdentifiedSessionHead extends SessionHead {
  project_identity: ProjectIdentity;
}

type InternalSessionHeadField =
  | "model_usage"
  | "project_identity_resolver_revision"
  | "project_identity_input_signature"
  | "smart_tags_source_updated_at"
  | "smart_tags_classifier_revision";

export type PublicSessionHead = Omit<SessionHead, InternalSessionHeadField>;

export type PublicIdentifiedSessionHead = Omit<IdentifiedSessionHead, InternalSessionHeadField>;

export interface SessionListPage {
  sessions: PublicIdentifiedSessionHead[];
  nextCursor?: string;
}

export interface ReferencedSessionHead {
  reference: SessionReference;
  session: SessionHead;
}

export interface PublicReferencedSessionHead {
  reference: SessionReference;
  session: PublicSessionHead;
}

/** Complete normalized content for replaying a Session */
export interface SessionDetail extends SessionIdentity {
  title: string;
  display_title?: string;
  directory: string;
  parent_reference?: SessionReference;
  project_identity?: ProjectIdentity;
  project_identity_resolver_revision?: string;
  project_identity_input_signature?: string;
  version?: string | null;
  detail_freshness?: "fresh" | "stale";
  time_created: number;
  time_updated?: number;
  summary_files?: unknown;
  stats: SessionStats;
  messages: Message[];
  message_cursor?: string;
  message_update?: "reset" | "append";
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
  smart_tags_classifier_revision?: string;
  file_activity?: SessionFileActivity[];
}

export interface IdentifiedSessionDetail extends SessionDetail {
  project_identity: ProjectIdentity;
}

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
