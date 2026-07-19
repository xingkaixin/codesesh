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
  agent_name: string;
  session_id: string;
  project_identity_key: string;
  path: string;
  kind: FileActivityKind;
  count: number;
  latest_time: number;
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

export interface ToolPartState {
  status?: "running" | "completed" | "error";
  input?: unknown;
  arguments?: unknown;
  output?: unknown;
  result?: unknown;
  error?: unknown;
  metadata?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

export interface MessagePart {
  type: "text" | "tool" | "reasoning" | "plan" | "image";
  text?: unknown;
  data?: string;
  mime_type?: string;
  url?: string;
  tool?: string;
  title?: string;
  nickname?: string;
  subagent_id?: string;
  input?: unknown;
  output?: unknown;
  approval_status?: "success" | "fail";
  callID?: string;
  state?: ToolPartState;
  time_created?: number;
}

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

/** Full session data for detail view */
export interface SessionData {
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
