export type {
  AgentInfo,
  SmartTag,
  FileActivityKind,
  CostSource,
  SessionHead,
  SessionFileActivity,
  FileActivityResult,
  ProjectIdentityKind,
  ProjectIdentity,
  MessageTokens,
  ToolPartState,
  MessagePart,
  Message,
  SessionData,
  ScanStatusEvent,
  BackfillStatus,
  AgentScanStatus,
  DashboardAgentStat,
  DashboardDailyBucket,
  DailyTokenBucket,
  ModelDistributionEntry,
  DashboardTotals,
  DashboardRecentSession,
  DashboardData,
  AppConfig,
  SearchResult,
  SessionsUpdatedEvent,
  ApiProjectGroup as ProjectGroup,
  ApiProjectAgentStat as ProjectAgentStat,
  BookmarkRecord as BookmarkedSessionSnapshot,
} from "@codesesh/core/contract";

import type {
  AgentInfo,
  ApiProjectGroup,
  AppConfig,
  BookmarkRecord as BookmarkedSessionSnapshot,
  DashboardData,
  FileActivityKind,
  ProjectIdentityKind,
  ScanStatusEvent,
  SearchResult,
  SessionData,
  SessionHead,
  SessionsUpdatedEvent,
  SmartTag,
} from "@codesesh/core/contract";

const REMOTE_ACCESS_QUERY_PARAM = "access_token";
const REMOTE_ACCESS_STORAGE_KEY = "codesesh:remote-access-token";
let remoteAccessToken: string | null = null;

export function initializeRemoteAccess(): void {
  if (typeof window === "undefined") return;

  const url = new URL(window.location.href);
  const urlToken = url.searchParams.get(REMOTE_ACCESS_QUERY_PARAM);
  if (urlToken) {
    remoteAccessToken = urlToken;
    try {
      window.sessionStorage.setItem(REMOTE_ACCESS_STORAGE_KEY, urlToken);
    } catch {}
    url.searchParams.delete(REMOTE_ACCESS_QUERY_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    return;
  }

  try {
    remoteAccessToken = window.sessionStorage.getItem(REMOTE_ACCESS_STORAGE_KEY);
  } catch {
    remoteAccessToken = null;
  }
}

function withRemoteAccess(init: RequestInit = {}): RequestInit {
  if (!remoteAccessToken) return init;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${remoteAccessToken}`);
  return { ...init, headers };
}

function remoteAccessUrl(path: string): string {
  if (!remoteAccessToken) return path;
  const url = new URL(path, window.location.origin);
  url.searchParams.set(REMOTE_ACCESS_QUERY_PARAM, remoteAccessToken);
  return `${url.pathname}${url.search}`;
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

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, withRemoteAccess(init));
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

export async function fetchProjects(): Promise<{ projects: ApiProjectGroup[] }> {
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

export async function fetchSessionData(
  agent: string,
  sessionId: string,
  options: { signal?: AbortSignal } = {},
): Promise<SessionData> {
  return fetchJson(`/api/sessions/${agent}/${sessionId}`, { signal: options.signal });
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
    if (!remoteAccessToken && typeof navigator !== "undefined" && navigator.sendBeacon) {
      const blob = new Blob([body], { type: "application/json" });
      if (navigator.sendBeacon("/api/logs", blob)) return;
    }
  } catch {}

  void fetch(
    "/api/logs",
    withRemoteAccess({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }),
  ).catch(() => {});
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
    const source = new EventSource(remoteAccessUrl("/api/events"));
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
