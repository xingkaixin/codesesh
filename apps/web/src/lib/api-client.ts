import { sessionRoutePath } from "@codesesh/core/contract";
import type {
  AgentInfo,
  ApiProjectGroup,
  ApiProjectPage,
  AppConfig,
  BookmarkRecord,
  BookmarkView,
  DashboardData,
  ProjectIdentityKind,
  ProjectIdentityRef,
  ScanStatusEvent,
  SearchResult,
  SessionDetail,
  SessionHead,
  SessionListPage,
  SessionReference,
} from "@codesesh/core/contract";
import type {
  DashboardFilters,
  FetchOptions,
  ProjectPageOptions,
  SearchRequestOptions,
  SessionDetailFetchOptions,
  SessionFetchProgress,
} from "./api-contract";
import type { RemoteAccess } from "./remote-access";

const SESSION_PAGE_SIZE = 250;
const SESSION_STALE_RETRY_LIMIT = 2;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function appendTimeWindow(params: URLSearchParams, window?: AppConfig["window"]): void {
  if (window?.from != null) params.set("from", new Date(window.from).toISOString());
  if (window?.to != null) params.set("to", new Date(window.to).toISOString());
}

export function createApiClient(access: RemoteAccess) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(path, access.authorize(init));
    if (!res.ok) {
      const method = init?.method ?? "GET";
      throw new ApiRequestError(
        `${method} ${path} failed: ${res.status} ${res.statusText}`,
        res.status,
      );
    }
    return res.json() as Promise<T>;
  }

  async function fetchConfig(options?: FetchOptions): Promise<AppConfig> {
    return fetchJson("/api/config", options);
  }

  async function fetchScanStatus(): Promise<ScanStatusEvent> {
    return fetchJson("/api/status");
  }

  async function fetchAgents(
    window?: AppConfig["window"],
    options?: FetchOptions,
  ): Promise<AgentInfo[]> {
    const params = new URLSearchParams();
    appendTimeWindow(params, window);
    return fetchJson(`/api/agents?${params}`, options);
  }

  async function fetchProjects(
    window?: AppConfig["window"],
    options?: ProjectPageOptions,
  ): Promise<ApiProjectPage> {
    const params = new URLSearchParams();
    appendTimeWindow(params, window);
    params.set("limit", options?.project ? "1" : "100");
    if (options?.cursor) params.set("cursor", options.cursor);
    if (options?.project) {
      params.set("projectKind", options.project.kind);
      params.set("projectKey", options.project.key);
    }
    return fetchJson(
      `/api/projects?${params}`,
      options?.signal ? { signal: options.signal } : undefined,
    );
  }

  async function fetchProject(
    window: AppConfig["window"],
    project: ProjectIdentityRef,
    options?: FetchOptions,
  ): Promise<ApiProjectGroup | null> {
    const page = await fetchProjects(window, { ...options, project });
    return page.projects[0] ?? null;
  }

  async function fetchSessions(
    options: {
      agent?: string;
      projectKind?: ProjectIdentityKind;
      projectKey?: string;
      from?: number;
      to?: number;
    } = {},
    fetchOptions?: FetchOptions,
    progress?: SessionFetchProgress,
  ): Promise<{ sessions: SessionHead[] }> {
    const baseParams = new URLSearchParams();
    if (options.agent) baseParams.set("agent", options.agent);
    if (options.projectKind) baseParams.set("projectKind", options.projectKind);
    if (options.projectKey) baseParams.set("projectKey", options.projectKey);
    appendTimeWindow(baseParams, options);

    let staleRetries = 0;
    while (true) {
      try {
        const sessions: SessionHead[] = [];
        let cursor: string | undefined;
        do {
          const params = new URLSearchParams(baseParams);
          params.set("limit", String(SESSION_PAGE_SIZE));
          if (cursor) params.set("cursor", cursor);
          const page = await fetchJson<SessionListPage>(`/api/sessions?${params}`, fetchOptions);
          sessions.push(...page.sessions);
          if (!cursor) progress?.onFirstPage?.([...sessions]);
          cursor = page.nextCursor;
        } while (cursor);
        return { sessions };
      } catch (error) {
        if (
          !(error instanceof ApiRequestError) ||
          error.status !== 409 ||
          staleRetries >= SESSION_STALE_RETRY_LIMIT
        ) {
          throw error;
        }
        staleRetries += 1;
      }
    }
  }

  async function fetchSessionData(
    agent: string,
    sessionId: string,
    options?: SessionDetailFetchOptions,
  ): Promise<SessionDetail> {
    const path = `/api/sessions${sessionRoutePath({ agentName: agent, sessionId })}`;
    const fetchOptions: FetchOptions | undefined = options ? { signal: options.signal } : undefined;
    if (!options?.messageCursor) return fetchJson(path, fetchOptions);

    const params = new URLSearchParams({ messageCursor: options.messageCursor });
    return fetchJson(`${path}?${params}`, fetchOptions);
  }

  async function fetchDashboard(
    window: AppConfig["window"] | undefined,
    filters: DashboardFilters,
    options?: FetchOptions,
  ): Promise<DashboardData> {
    const params = new URLSearchParams();
    if (window?.days === 0) {
      params.set("days", "0");
    } else if (window?.from != null) {
      appendTimeWindow(params, window);
    } else {
      if (window?.to != null) params.set("to", String(window.to));
      if (window?.days != null) params.set("days", String(window.days));
    }
    if (filters.project) {
      params.set("projectKind", filters.project.kind);
      params.set("projectKey", filters.project.key);
    }
    if (filters.agent) params.set("agent", filters.agent);
    const suffix = params.toString();
    return fetchJson(suffix ? `/api/dashboard?${suffix}` : "/api/dashboard", options);
  }

  async function fetchSearchResults(
    query: string,
    options: SearchRequestOptions = {},
    fetchOptions?: FetchOptions,
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
    appendTimeWindow(params, options);
    return fetchJson(`/api/search?${params}`, fetchOptions);
  }

  async function fetchBookmarks(options?: FetchOptions): Promise<{ bookmarks: BookmarkView[] }> {
    return fetchJson("/api/bookmarks", options);
  }

  async function upsertBookmark(
    reference: SessionReference,
  ): Promise<{ bookmark: BookmarkRecord }> {
    return fetchJson("/api/bookmarks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reference }),
    });
  }

  async function importBookmarks(
    bookmarks: BookmarkRecord[],
  ): Promise<{ bookmarks: BookmarkView[] }> {
    return fetchJson("/api/bookmarks/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bookmarks),
    });
  }

  async function deleteBookmark(reference: SessionReference): Promise<void> {
    await fetchJson(`/api/bookmarks${sessionRoutePath(reference)}`, { method: "DELETE" });
  }

  async function upsertSessionAlias(
    agentKey: string,
    sessionId: string,
    alias: string,
  ): Promise<void> {
    await fetchJson(`/api/session-aliases${sessionRoutePath({ agentName: agentKey, sessionId })}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias }),
    });
  }

  async function deleteSessionAlias(agentKey: string, sessionId: string): Promise<void> {
    await fetchJson(`/api/session-aliases${sessionRoutePath({ agentName: agentKey, sessionId })}`, {
      method: "DELETE",
    });
  }

  return Object.freeze({
    fetchConfig,
    fetchScanStatus,
    fetchAgents,
    fetchProjects,
    fetchProject,
    fetchSessions,
    fetchSessionData,
    fetchDashboard,
    fetchSearchResults,
    fetchBookmarks,
    upsertBookmark,
    importBookmarks,
    deleteBookmark,
    upsertSessionAlias,
    deleteSessionAlias,
  });
}

export type ApiClient = ReturnType<typeof createApiClient>;
