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

export type ProjectIdentityKind =
  | "git_remote"
  | "git_common_dir"
  | "manifest_path"
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
}

export interface ProjectGroup {
  identityKind: ProjectIdentityKind;
  identityKey: string;
  displayName: string;
  sources: string[];
  sessionCount: number;
  lastActivity: number | null;
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
  window: { from: number; to: number; days: number };
}

export interface AppConfig {
  window: {
    from?: number;
    to?: number;
    days?: number;
  };
}

/**
 * UI-side time range used by the header dropdown. Encoded into URL search
 * params via useTimeRange and converted to the existing window-shaped
 * payload via windowFromTimeRange before being passed to fetch helpers — we
 * don't introduce a parallel API surface, the backend already accepts
 * `from`/`to`/`days` query params.
 */
export type TimeRange =
  | { kind: "preset"; days: number }
  | { kind: "custom"; from: string; to?: string }
  | { kind: "yesterday" }
  | { kind: "all" };

/**
 * End-of-day local timestamp for the same calendar day as `start` — uses
 * setDate(+1) + setMilliseconds(-1) instead of `start + 86400000 - 1` so DST
 * transitions don't shift the boundary into the previous/next day.
 */
function endOfLocalDay(start: Date): number {
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(-1);
  return end.getTime();
}

/**
 * Translate a UI-side TimeRange into the `{from?, to?, days?}` window shape
 * already understood by the backend / existing fetch helpers.
 *
 * Semantics chosen so the dropdown drives every endpoint coherently:
 *
 * - `all`        → from = 0 (epoch), to = now. Explicit wide window so the
 *                  dashboard handler doesn't fall back to its 30-day default
 *                  and the agents/sessions/search handlers also see "no
 *                  effective filter". An empty `{}` would let CLI defaults
 *                  re-assert themselves and contradict the "All time" label.
 * - `yesterday`  → from = yesterday 00:00 local, to = yesterday 23:59:59.999
 *                  via end-of-local-day (DST-safe).
 * - `preset(N)`  → returns `days: N` AND a concrete `from`/`to`. Dashboard
 *                  prefers `days` for its daily-bucket layout; sessions /
 *                  agents / search handlers don't read `days` so they need
 *                  the explicit from/to. Sending all three keeps every
 *                  endpoint consistent with the dropdown selection.
 * - `custom`     → ISO date strings → from/to in local time, with `to`
 *                  rounded to end-of-local-day for inclusive semantics.
 */
export function windowFromTimeRange(range: TimeRange | null | undefined): AppConfig["window"] {
  if (!range) return {};
  const now = Date.now();
  if (range.kind === "all") {
    return { from: 0, to: now };
  }
  if (range.kind === "preset") {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const fromTs = startOfToday.getTime() - (range.days - 1) * 86400000;
    return { days: range.days, from: fromTs, to: now };
  }
  if (range.kind === "yesterday") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - 1);
    return { from: start.getTime(), to: endOfLocalDay(start) };
  }
  // custom: ISO date strings, possibly with `to` omitted → leave `to` open.
  const fromDate = new Date(`${range.from}T00:00:00`);
  if (!Number.isFinite(fromDate.getTime())) return {};
  const window: AppConfig["window"] = { from: fromDate.getTime() };
  if (range.to) {
    const toDate = new Date(`${range.to}T00:00:00`);
    if (Number.isFinite(toDate.getTime())) window.to = endOfLocalDay(toDate);
  }
  return window;
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

function appendWindowParams(params: URLSearchParams, window?: AppConfig["window"]): void {
  if (!window) return;
  if (window.from != null) params.set("from", new Date(window.from).toISOString());
  if (window.to != null) params.set("to", new Date(window.to).toISOString());
  if (window.days != null && window.days > 0) params.set("days", String(window.days));
}

export async function fetchAgents(window?: AppConfig["window"]): Promise<AgentInfo[]> {
  const params = new URLSearchParams();
  appendWindowParams(params, window);
  const suffix = params.toString();
  const res = await fetch(suffix ? `/api/agents?${suffix}` : "/api/agents");
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function fetchProjects(): Promise<{ projects: ProjectGroup[] }> {
  const res = await fetch("/api/projects");
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function fetchSessions(
  options: {
    agent?: string;
    projectKey?: string;
    from?: number;
    to?: number;
  } = {},
): Promise<{ sessions: SessionHead[] }> {
  const params = new URLSearchParams();
  if (options.agent) params.set("agent", options.agent);
  if (options.projectKey) params.set("projectKey", options.projectKey);
  if (options.from != null) params.set("from", new Date(options.from).toISOString());
  if (options.to != null) params.set("to", new Date(options.to).toISOString());
  const res = await fetch(`/api/sessions?${params}`);
  if (!res.ok) throw new Error("Failed to fetch sessions");
  return res.json();
}

export async function fetchSessionData(agent: string, sessionId: string): Promise<SessionData> {
  const res = await fetch(`/api/sessions/${agent}/${sessionId}`);
  if (!res.ok) throw new Error("Failed to fetch session data");
  return res.json();
}

export async function fetchDashboard(window?: AppConfig["window"]): Promise<DashboardData> {
  const params = new URLSearchParams();
  if (window?.from != null) params.set("from", new Date(window.from).toISOString());
  if (window?.to != null) params.set("to", new Date(window.to).toISOString());
  if (window?.days != null && window.days > 0) params.set("days", String(window.days));
  const suffix = params.toString();
  const res = await fetch(suffix ? `/api/dashboard?${suffix}` : "/api/dashboard");
  if (!res.ok) throw new Error("Failed to fetch dashboard");
  return res.json();
}

export async function fetchSearchResults(
  query: string,
  window?: AppConfig["window"],
): Promise<{ results: SearchResult[] }> {
  const params = new URLSearchParams();
  params.set("q", query);
  appendWindowParams(params, window);
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
