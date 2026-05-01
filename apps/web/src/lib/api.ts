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

export interface SessionHead {
  id: string;
  slug: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated?: number;
  stats: {
    message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    total_tokens?: number;
  };
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
}

export interface MessageTokens {
  input?: number;
  output?: number;
  reasoning?: number;
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
  parts: MessagePart[];
  subagent_id?: string;
  nickname?: string;
}

export interface SessionData {
  id: string;
  title: string;
  slug?: string | null;
  directory: string;
  version?: string | null;
  time_created: number;
  time_updated?: number;
  summary_files?: unknown;
  stats: {
    message_count: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost: number;
    total_tokens?: number;
  };
  messages: Message[];
  smart_tags?: SmartTag[];
  smart_tags_source_updated_at?: number;
}

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
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

export interface DashboardTagStat {
  tag: SmartTag;
  sessions: number;
  messages: number;
  tokens: number;
}

export interface DashboardTotals {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
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
  tagDistribution: DashboardTagStat[];
  recentSessions: DashboardRecentSession[];
  window: { from: number; to: number; days: number };
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

export async function fetchConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Failed to fetch config");
  return res.json();
}

export async function fetchAgents(): Promise<AgentInfo[]> {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function fetchSessions(agent?: string): Promise<{ sessions: SessionHead[] }> {
  const params = new URLSearchParams();
  if (agent) params.set("agent", agent);
  const res = await fetch(`/api/sessions?${params}`);
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function fetchSessionData(agent: string, sessionId: string): Promise<SessionData> {
  const res = await fetch(`/api/sessions/${agent}/${sessionId}`);
  if (!res.ok) throw new Error("Failed to fetch session data");
  return res.json();
}

export async function fetchDashboard(days?: number): Promise<DashboardData> {
  const params = new URLSearchParams();
  if (days != null && days > 0) params.set("days", String(days));
  const suffix = params.toString();
  const res = await fetch(suffix ? `/api/dashboard?${suffix}` : "/api/dashboard");
  if (!res.ok) throw new Error("Failed to fetch dashboard");
  return res.json();
}

export async function fetchSearchResults(query: string): Promise<{ results: SearchResult[] }> {
  const params = new URLSearchParams();
  params.set("q", query);
  const res = await fetch(`/api/search?${params}`);
  if (!res.ok) throw new Error("Failed to fetch search results");
  return res.json();
}

export async function fetchBookmarks(): Promise<{ bookmarks: BookmarkedSessionSnapshot[] }> {
  const res = await fetch("/api/bookmarks");
  if (!res.ok) throw new Error("Failed to fetch bookmarks");
  return res.json();
}

export async function upsertBookmark(
  bookmark: Omit<BookmarkedSessionSnapshot, "bookmarked_at">,
): Promise<{ bookmark: BookmarkedSessionSnapshot }> {
  const res = await fetch("/api/bookmarks", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bookmark),
  });
  if (!res.ok) throw new Error("Failed to save bookmark");
  return res.json();
}

export async function importBookmarks(
  bookmarks: Omit<BookmarkedSessionSnapshot, "bookmarked_at">[],
): Promise<{ bookmarks: BookmarkedSessionSnapshot[] }> {
  const res = await fetch("/api/bookmarks/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bookmarks),
  });
  if (!res.ok) throw new Error("Failed to import bookmarks");
  return res.json();
}

export async function deleteBookmark(agentKey: string, sessionId: string): Promise<void> {
  const res = await fetch(`/api/bookmarks/${agentKey}/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete bookmark");
}

export function subscribeSessionUpdates(
  onUpdate: (event: SessionsUpdatedEvent) => void,
): () => void {
  const source = new EventSource("/api/events");

  source.addEventListener("sessions-updated", (event) => {
    try {
      onUpdate(JSON.parse(event.data) as SessionsUpdatedEvent);
    } catch (error) {
      console.error("Failed to parse session update event:", error);
    }
  });

  source.onerror = () => {
    console.error("Session update stream disconnected");
  };

  return () => {
    source.close();
  };
}
