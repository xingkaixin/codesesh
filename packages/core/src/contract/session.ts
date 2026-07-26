import type { SessionReference } from "./session-reference.js";

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

export type SmartTag =
  | "bugfix"
  | "refactoring"
  | "feature-dev"
  | "testing"
  | "docs"
  | "git-ops"
  | "build-deploy"
  | "exploration"
  | "planning";

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

export type ProjectIdentityKind =
  | "git_remote"
  | "git_common_dir"
  | "manifest_path"
  | "synthetic"
  | "path"
  | "loose";

export interface ProjectIdentity {
  kind: ProjectIdentityKind;
  key: string;
  displayName: string;
}

export type ProjectIdentityRef = Pick<ProjectIdentity, "kind" | "key">;

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
export interface SessionHead {
  id: string;
  slug: string;
  title: string;
  display_title?: string;
  directory: string;
  project_identity?: ProjectIdentity;
  time_created: number;
  time_updated?: number;
  stats: SessionStats;
  model_usage?: Record<string, number>;
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
}

export interface ReferencedSessionHead {
  reference: SessionReference;
  session: SessionHead;
}

/** Full session data for detail view */
export interface SessionData {
  reference: SessionReference;
  id: string;
  title: string;
  display_title?: string;
  slug?: string | null;
  directory: string;
  project_identity?: ProjectIdentity;
  version?: string | null;
  time_created: number;
  time_updated?: number;
  summary_files?: unknown;
  stats: SessionStats;
  messages: Message[];
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
  file_activity?: SessionFileActivity[];
}
