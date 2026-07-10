export interface AgentInfo {
  name: string;
  displayName: string;
  count: number;
  icon: string;
}

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

export type CostSource = "recorded" | "estimated";

export interface SessionHead {
  id: string;
  slug: string;
  title: string;
  directory: string;
  project_identity?: ProjectIdentity;
  time_created: number;
  time_updated?: number;
  stats: {
    message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    cost_source?: CostSource;
    total_tokens?: number;
  };
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
}

export interface SessionFileActivity {
  agent_name: string;
  session_id: string;
  project_identity_key: string;
  path: string;
  kind: FileActivityKind;
  count: number;
  latest_time: number;
}

export interface FileActivityResult extends SessionFileActivity {
  session: SessionHead;
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
  type: "text" | "tool" | "reasoning" | "plan";
  text?: unknown;
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

export interface SessionData {
  id: string;
  title: string;
  slug?: string | null;
  directory: string;
  project_identity?: ProjectIdentity;
  version?: string | null;
  time_created: number;
  time_updated?: number;
  summary_files?: unknown;
  stats: {
    message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    cost_source?: CostSource;
    total_tokens?: number;
  };
  messages: Message[];
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
  file_activity?: SessionFileActivity[];
}

export interface ProjectGroup {
  identityKind: ProjectIdentityKind;
  identityKey: string;
  displayName: string;
  sources: string[];
  sessionCount: number;
  lastActivity: number | null;
  messages: number;
  tokens: number;
  cost: number;
  cost_source?: CostSource;
  agentStats: ProjectAgentStat[];
}

export interface ProjectAgentStat {
  name: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
  changedSessionHeads?: Array<{ agentName: string; session: SessionHead }>;
  removedSessionRefs?: Array<{ agentName: string; sessionId: string }>;
}

export interface ScanStatusEvent {
  type: "scan-status";
  active: boolean;
  phase: "idle" | "indexing" | "initializing" | "scanning";
  pendingAgents: string[];
  scanningAgents: string[];
  completedAgents: string[];
  agentStatuses: Record<string, AgentScanStatus>;
  totalAgents: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
  backfill: BackfillStatus;
}

export interface BackfillStatus {
  active: boolean;
  pendingAgents: string[];
  currentAgent?: string;
  completedAgents: string[];
}

export interface AgentScanStatus {
  agentName: string;
  status: "pending" | "scanning" | "complete";
  total?: number;
  processed?: number;
  sessions?: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export interface DashboardAgentStat {
  name: string;
  displayName: string;
  icon: string;
  sessions: number;
  messages: number;
  tokens: number;
}

export interface DashboardDailyBucket {
  date: string;
  sessions: number;
  messages: number;
}

export interface DailyTokenBucket {
  date: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface ModelDistributionEntry {
  model: string;
  tokens: number;
  sessions: number;
}

export interface DashboardTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  cost_source?: CostSource;
  latestActivity?: number;
}

export interface DashboardRecentSession extends SessionHead {
  agentName: string;
}

export interface DashboardData {
  totals: DashboardTotals;
  perAgent: DashboardAgentStat[];
  dailyActivity: DashboardDailyBucket[];
  dailyTokenActivity: DailyTokenBucket[];
  modelDistribution: ModelDistributionEntry[];
  recentSessions: DashboardRecentSession[];
  recentFileActivities: FileActivityResult[];
  window: { from?: number; to: number; days?: number };
}

export interface AppConfig {
  window: {
    from?: number;
    to?: number;
    days?: number;
  };
}

export interface SearchResult {
  agentName: string;
  session: SessionHead;
  snippet: string;
  matchType: "recent" | "title" | "user_message" | "assistant_reply" | "tool_output" | "file_path";
}

export interface SearchRequestOptions {
  agent?: string;
  projectKind?: ProjectIdentityKind;
  projectKey?: string;
  tag?: SmartTag;
  tool?: string;
  fileKind?: FileActivityKind;
  costMin?: number;
  costMax?: number;
}

export interface BookmarkedSessionSnapshot {
  agentKey: string;
  sessionId: string;
  fullPath: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated?: number;
  stats: SessionHead["stats"];
  bookmarked_at: number;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const method = init?.method ?? "GET";
    throw new Error(`${method} ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchConfig(): Promise<AppConfig> {
  return fetchJson("/api/config");
}

export async function fetchScanStatus(): Promise<ScanStatusEvent> {
  return fetchJson("/api/status");
}

export async function fetchAgents(): Promise<AgentInfo[]> {
  return fetchJson("/api/agents");
}

export async function fetchProjects(): Promise<{ projects: ProjectGroup[] }> {
  return fetchJson("/api/projects");
}

export async function fetchSessions(
  options: {
    agent?: string;
    projectKind?: ProjectIdentityKind;
    projectKey?: string;
    from?: number;
    to?: number;
  } = {},
): Promise<{ sessions: SessionHead[] }> {
  const params = new URLSearchParams();
  if (options.agent) params.set("agent", options.agent);
  if (options.projectKind) params.set("projectKind", options.projectKind);
  if (options.projectKey) params.set("projectKey", options.projectKey);
  if (options.from != null) params.set("from", new Date(options.from).toISOString());
  if (options.to != null) params.set("to", new Date(options.to).toISOString());
  return fetchJson(`/api/sessions?${params}`);
}

export async function fetchSessionData(agent: string, sessionId: string): Promise<SessionData> {
  return fetchJson(`/api/sessions/${agent}/${sessionId}`);
}

export async function fetchDashboard(
  window?: AppConfig["window"],
  filters: { projectKind?: ProjectIdentityKind; projectKey?: string; agent?: string } = {},
): Promise<DashboardData> {
  const params = new URLSearchParams();
  if (window?.from != null) params.set("from", new Date(window.from).toISOString());
  if (window?.to != null) params.set("to", new Date(window.to).toISOString());
  if (window?.days != null && window.days > 0) params.set("days", String(window.days));
  if (filters.projectKind) params.set("projectKind", filters.projectKind);
  if (filters.projectKey) params.set("projectKey", filters.projectKey);
  if (filters.agent) params.set("agent", filters.agent);
  const suffix = params.toString();
  return fetchJson(suffix ? `/api/dashboard?${suffix}` : "/api/dashboard");
}

export async function fetchSearchResults(
  query: string,
  options: SearchRequestOptions = {},
): Promise<{ results: SearchResult[] }> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (options.agent) params.set("agent", options.agent);
  if (options.projectKind) params.set("projectKind", options.projectKind);
  if (options.projectKey) params.set("projectKey", options.projectKey);
  if (options.tag) params.set("tag", options.tag);
  if (options.tool) params.set("tool", options.tool);
  if (options.fileKind) params.set("fileActivity", options.fileKind);
  if (options.costMin != null) params.set("costMin", String(options.costMin));
  if (options.costMax != null) params.set("costMax", String(options.costMax));
  return fetchJson(`/api/search?${params}`);
}

export async function fetchBookmarks(): Promise<{ bookmarks: BookmarkedSessionSnapshot[] }> {
  return fetchJson("/api/bookmarks");
}

export async function upsertBookmark(
  bookmark: Omit<BookmarkedSessionSnapshot, "bookmarked_at">,
): Promise<{ bookmark: BookmarkedSessionSnapshot }> {
  return fetchJson("/api/bookmarks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bookmark),
  });
}

export async function importBookmarks(
  bookmarks: Omit<BookmarkedSessionSnapshot, "bookmarked_at">[],
): Promise<{ bookmarks: BookmarkedSessionSnapshot[] }> {
  return fetchJson("/api/bookmarks/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bookmarks),
  });
}

export async function deleteBookmark(agentKey: string, sessionId: string): Promise<void> {
  await fetchJson(`/api/bookmarks/${agentKey}/${sessionId}`, {
    method: "DELETE",
  });
}

export function logClientEvent(event: string, data: Record<string, unknown> = {}): void {
  const body = JSON.stringify({ event, data });

  try {
    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/logs", blob)) return;
    }
  } catch {}

  void fetch("/api/logs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

const INITIAL_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

function jitter(delayMs: number): number {
  const spread = delayMs * 0.2;
  return delayMs + (Math.random() * 2 - 1) * spread;
}

export function subscribeSessionUpdates(
  onUpdate: (event: SessionsUpdatedEvent) => void,
  onScanStatus?: (event: ScanStatusEvent) => void,
  onReconnect?: () => void,
  onDisconnect?: () => void,
): () => void {
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelayMs = INITIAL_RETRY_MS;
  let hasConnectedOnce = false;
  let disconnectNotified = false;
  let currentSource: EventSource | undefined;

  const connect = () => {
    const source = new EventSource("/api/events");
    currentSource = source;

    source.addEventListener("sessions-updated", (event) => {
      try {
        onUpdate(JSON.parse(event.data) as SessionsUpdatedEvent);
      } catch (error) {
        console.error("Failed to parse session update event:", error);
      }
    });

    source.addEventListener("scan-status", (event) => {
      if (!onScanStatus) return;
      try {
        onScanStatus(JSON.parse(event.data) as ScanStatusEvent);
      } catch (error) {
        console.error("Failed to parse scan status event:", error);
      }
    });

    source.onopen = () => {
      retryDelayMs = INITIAL_RETRY_MS;
      disconnectNotified = false;
      if (hasConnectedOnce) {
        onReconnect?.();
      }
      hasConnectedOnce = true;
    };

    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      source.close();
      if (disposed) return;
      if (!disconnectNotified) {
        disconnectNotified = true;
        onDisconnect?.();
      }
      const delay = jitter(retryDelayMs);
      retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_MS);
      retryTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    disposed = true;
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
    }
    currentSource?.close();
  };
}
