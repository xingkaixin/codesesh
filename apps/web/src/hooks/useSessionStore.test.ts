import {
  SAMPLE_DASHBOARD_DATA,
  SAMPLE_SESSION_HEAD,
  SAMPLE_SESSIONS_UPDATED_EVENT,
} from "@codesesh/core/test-fixtures";
import { createSessionIdentity } from "@codesesh/core/contract";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentInfo,
  AppConfig,
  ApiProjectGroup,
  ApiProjectPage,
  SessionHead,
} from "../lib/api";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import {
  useSessionStore,
  type LiveSessionApplyResult,
  type SessionProjection,
} from "./useSessionStore";
import { useDashboard } from "./useDashboard";

vi.mock("../lib/api", () => ({
  fetchAgents: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchProjects: vi.fn(),
  fetchSessions: vi.fn(),
}));

const config = {
  window: { from: 1_700_000_000_000, to: 1_700_004_000_000, days: 7 },
} as AppConfig;
const agents = [
  { name: "ClaudeCode", displayName: "Claude Code", count: 1 },
  { name: "Codex", displayName: "Codex", count: 0 },
] as unknown as AgentInfo[];
const projects = [{ identityKind: "path", identityKey: "p1" }] as unknown as ApiProjectGroup[];
const projectPage = {
  projects,
  summary: {
    projects: 1,
    sessions: 0,
    tokens: 0,
    cost: 0,
    latestActivity: null,
  },
} satisfies ApiProjectPage;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.mocked(api.fetchAgents).mockResolvedValue(agents);
  vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [SAMPLE_SESSION_HEAD] });
  vi.mocked(api.fetchProjects).mockResolvedValue(projectPage);
  vi.mocked(api.fetchDashboard).mockResolvedValue(SAMPLE_DASHBOARD_DATA);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function renderStore(window: AppConfig["window"] = config.window) {
  const { client, Wrapper } = createQueryWrapper();
  const hook = renderHook(({ selectedWindow }) => useSessionStore(selectedWindow), {
    wrapper: Wrapper,
    initialProps: { selectedWindow: window },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, client };
}

describe("useSessionStore", () => {
  it("stays idle until a window is selected", () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(null), { wrapper: Wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(api.fetchSessions).not.toHaveBeenCalled();
  });

  it("CS-276: resolves retryLoad even when the reload fails again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchSessions).mockRejectedValue(new Error("api down"));
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(config.window), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).not.toBeNull());

    // The server is still down; the retry must record the failure in state
    // instead of rejecting out of the button handler.
    await expect(act(() => result.current.retryLoad())).resolves.toBeUndefined();
    await waitFor(() =>
      expect(result.current.error).toBe(
        "Failed to load session data for the selected time window.",
      ),
    );
  });

  it("ignores live events until a window has been selected", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(null), { wrapper: Wrapper });
    let update: Awaited<ReturnType<typeof result.current.applyLiveEvent>> | undefined;

    await act(async () => {
      update = await result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });

    expect(update).toBeNull();
    expect(api.fetchAgents).not.toHaveBeenCalled();
  });

  it("handles a live event that arrives before the first window load completes", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(config.window), { wrapper: Wrapper });
    let liveUpdate!: ReturnType<typeof result.current.applyLiveEvent>;

    act(() => {
      liveUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });
    let liveResult!: LiveSessionApplyResult | null;
    await act(async () => {
      liveResult = await liveUpdate;
    });

    expect(liveResult).toEqual({ visibleNewSessions: 0 });
    await waitFor(() => expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]));
  });

  it("keeps projects available alongside the session snapshot", async () => {
    const { result } = await renderStore();

    await waitFor(() => expect(result.current.projects).toEqual(projects));

    expect(result.current.loading).toBe(false);
    expect(result.current.agents).toEqual(agents);
    expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]);
    expect(result.current.dashboard).toEqual(SAMPLE_DASHBOARD_DATA);
    expect(result.current.activeAgents).toEqual([agents[0]]);
    expect(result.current.agentCatalog.byKey.get("codex")).toBe(agents[1]);
    expect(result.current.validAgentKeys.has("claudecode")).toBe(true);
    expect(result.current.validAgentKeys.has("codex")).toBe(false);
    expect(result.current.agentNameMap.get("claudecode")).toBe("Claude Code");
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("shares the global dashboard query with dashboard consumers", async () => {
    const { Wrapper } = createQueryWrapper();
    const store = renderHook(() => useSessionStore(config.window), { wrapper: Wrapper });
    await waitFor(() => expect(store.result.current.loading).toBe(false));

    const dashboard = renderHook(
      () => useDashboard(config.window, { project: undefined, agent: undefined }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(dashboard.result.current.dashboard).toEqual(SAMPLE_DASHBOARD_DATA));
    expect(api.fetchDashboard).toHaveBeenCalledOnce();
  });

  it("renders the first session page while the complete window keeps loading", async () => {
    const completeSessions = deferred<{ sessions: SessionHead[] }>();
    const finalSession = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "final-session" }),
    };
    vi.mocked(api.fetchSessions).mockImplementation(async (_options, _fetchOptions, progress) => {
      progress?.onFirstPage?.([SAMPLE_SESSION_HEAD]);
      return completeSessions.promise;
    });
    const { client, Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(config.window), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]));
    expect(result.current.loading).toBe(false);
    expect(
      client.getQueryData<SessionProjection>(queryKeys.sessionProjection(config.window))?.sessions,
    ).toEqual([SAMPLE_SESSION_HEAD]);

    completeSessions.resolve({ sessions: [SAMPLE_SESSION_HEAD, finalSession] });
    await act(async () => completeSessions.promise);

    await waitFor(() =>
      expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD, finalSession]),
    );
  });

  it("keeps the latest snapshot when an earlier request finishes late", async () => {
    const firstAgents = deferred<AgentInfo[]>();
    const latestAgents = [{ name: "Codex", displayName: "Codex" }] as unknown as AgentInfo[];
    vi.mocked(api.fetchAgents)
      .mockReturnValueOnce(firstAgents.promise)
      .mockResolvedValueOnce(latestAgents);
    const firstWindow = { from: 1, to: 2 };
    const latestWindow = { from: 3, to: 4 };
    const { Wrapper } = createQueryWrapper();
    const { result, rerender } = renderHook(
      ({ selectedWindow }) => useSessionStore(selectedWindow),
      {
        wrapper: Wrapper,
        initialProps: { selectedWindow: firstWindow },
      },
    );
    await waitFor(() => expect(api.fetchAgents).toHaveBeenCalledOnce());

    rerender({ selectedWindow: latestWindow });
    await waitFor(() => {
      expect(result.current.window).toEqual(latestWindow);
      expect(result.current.agents).toEqual(latestAgents);
    });
    firstAgents.resolve(agents);
    await act(async () => firstAgents.promise);

    expect(result.current.window).toEqual(latestWindow);
    expect(result.current.agents).toEqual(latestAgents);
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("releases inactive projections and applies live events to the latest window", async () => {
    const firstWindow = { from: 1_700_000_000_000, to: 1_700_004_000_000 };
    const latestWindow = { from: 1_699_999_000_000, to: 1_700_005_000_000 };
    const { result, client, rerender } = await renderStore(firstWindow);
    rerender({ selectedWindow: latestWindow });
    await waitFor(() => expect(result.current.window).toEqual(latestWindow));
    await waitFor(() =>
      expect(
        client.getQueryCache().findAll({ queryKey: queryKeys.sessionProjections }),
      ).toHaveLength(1),
    );
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Latest window" };

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: changedSession.reference.sessionId },
            session: changedSession,
          },
        ],
      }),
    );

    expect(result.current.window).toEqual(latestWindow);
    await waitFor(() => expect(result.current.sessions).toEqual([changedSession]));
    expect(client.getQueryData(queryKeys.sessionProjection(firstWindow))).toBeUndefined();
    expect(
      client.getQueryData<SessionProjection>(queryKeys.sessionProjection(latestWindow))?.sessions,
    ).toEqual([changedSession]);
  });

  it("applies an incremental live session diff without re-fetching sessions", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchSessions).mockClear();
    vi.mocked(api.fetchAgents).mockClear();
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Renamed" };

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: changedSession.reference.sessionId },
            session: changedSession,
          },
        ],
      }),
    );

    await waitFor(() => expect(result.current.sessions).toEqual([changedSession]));
    expect(api.fetchSessions).not.toHaveBeenCalled();
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("coalesces aggregate refreshes and guarantees a trailing refresh", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchAgents).mockClear();
    vi.mocked(api.fetchProjects).mockClear();
    vi.mocked(api.fetchDashboard).mockClear();

    now += 500;
    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));
    await waitFor(() => expect(api.fetchAgents).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.fetchProjects).toHaveBeenCalledOnce());
    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledOnce());

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    now += 500;
    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));
    now += 500;
    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));

    expect(api.fetchAgents).toHaveBeenCalledOnce();
    expect(api.fetchProjects).toHaveBeenCalledOnce();
    expect(api.fetchDashboard).toHaveBeenCalledOnce();

    await act(() => vi.advanceTimersByTimeAsync(1_500));
    vi.useRealTimers();

    await waitFor(() => expect(api.fetchAgents).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.fetchProjects).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledTimes(2));
  });

  it("keeps window-external backfill sessions out of the active snapshot", async () => {
    const window = { from: 100, to: 200, days: 7 };
    const recentSession = {
      ...SAMPLE_SESSION_HEAD,
      time_created: 150,
      time_updated: 150,
    };
    const historicalSessions = Array.from({ length: 100 }, (_, index) => ({
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({
        agentName: "claudecode",
        sessionId: `historical-${index}`,
      }),
      time_created: 10,
      time_updated: 10,
    }));
    vi.mocked(api.fetchSessions).mockResolvedValueOnce({ sessions: [recentSession] });
    const { result } = await renderStore(window);
    let update!: LiveSessionApplyResult | null;

    await act(async () => {
      update = await result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: historicalSessions.map((session) => ({
          agentName: "claudecode",
          sessionId: session.reference.sessionId,
        })),
        totalSessions: historicalSessions.length + 1,
        changedSessionHeads: historicalSessions.map((session) => ({
          reference: { agentName: "claudecode", sessionId: session.reference.sessionId },
          session,
        })),
      });
    });

    expect(result.current.sessions).toEqual([recentSession]);
    expect(update?.visibleNewSessions).toBe(0);
  });

  it("reports only a newly visible session to the live notice boundary", async () => {
    const window = { from: 100, to: 200, days: 7 };
    const recentSession = {
      ...SAMPLE_SESSION_HEAD,
      time_created: 150,
      time_updated: 150,
    };
    const addedSession = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "new-visible" }),
      time_created: 160,
      time_updated: 160,
    };
    vi.mocked(api.fetchSessions).mockResolvedValueOnce({ sessions: [recentSession] });
    const { result } = await renderStore(window);
    let update!: LiveSessionApplyResult | null;

    await act(async () => {
      update = await result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [{ agentName: "claudecode", sessionId: addedSession.reference.sessionId }],
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: addedSession.reference.sessionId },
            session: addedSession,
          },
        ],
      });
    });

    expect(update?.visibleNewSessions).toBe(1);
  });

  it("invalidates project dashboards and searches without expiring unrelated windows", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, client } = await renderStore();
    await act(() => result.current.reload());
    const projectDashboardKey = queryKeys.dashboard(config.window, {
      project: { kind: "path", key: "p1" },
    });
    const searchKey = queryKeys.search("needle", {});
    const inactiveAgentCatalogKey = queryKeys.agentCatalog({ from: 10, to: 20 });
    client.setQueryData(projectDashboardKey, SAMPLE_DASHBOARD_DATA);
    client.setQueryData(searchKey, []);
    client.setQueryData(inactiveAgentCatalogKey, agents);
    now += 2_001;

    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));

    await waitFor(() =>
      expect(client.getQueryState(projectDashboardKey)?.isInvalidated).toBe(true),
    );
    await waitFor(() => expect(client.getQueryState(searchKey)?.isInvalidated).toBe(true));
    expect(client.getQueryState(inactiveAgentCatalogKey)?.isInvalidated).toBe(false);
  });

  it("invalidates only session details changed by a live event", async () => {
    const { result, client } = await renderStore();
    await act(() => result.current.reload());
    const changedDetailKey = queryKeys.sessionDetail(
      "claudecode",
      SAMPLE_SESSION_HEAD.reference.sessionId,
    );
    const unchangedDetailKey = queryKeys.sessionDetail("claudecode", "unchanged-session");
    const relatedDetailKey = queryKeys.sessionDetail("claudecode", "related-session");
    client.setQueryData(changedDetailKey, { id: SAMPLE_SESSION_HEAD.reference.sessionId });
    client.setQueryData(unchangedDetailKey, { id: "unchanged-session" });
    client.setQueryData(relatedDetailKey, { id: "related-session" });

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        projectionRelatedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: "related-session" },
            session: {
              ...SAMPLE_SESSION_HEAD,
              ...createSessionIdentity({
                agentName: "claudecode",
                sessionId: "related-session",
              }),
            },
          },
        ],
      }),
    );

    expect(client.getQueryState(changedDetailKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(unchangedDetailKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(relatedDetailKey)?.isInvalidated).toBe(false);
  });

  it("performs an explicit full reload when live state reconnects", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchSessions).mockClear();

    await act(() => result.current.resyncLiveState());

    expect(api.fetchSessions).toHaveBeenCalledOnce();
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("keeps overlapping live events on the incremental path", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchSessions).mockClear();
    const firstAgents = deferred<AgentInfo[]>();
    vi.mocked(api.fetchAgents).mockReturnValueOnce(firstAgents.promise).mockResolvedValue(agents);

    let firstUpdate!: ReturnType<typeof result.current.applyLiveEvent>;
    let secondUpdate!: ReturnType<typeof result.current.applyLiveEvent>;
    act(() => {
      firstUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
      secondUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });
    firstAgents.resolve(agents);
    await act(() => Promise.all([firstUpdate, secondUpdate]));

    expect(api.fetchSessions).not.toHaveBeenCalled();
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("keeps sessions and dashboards available when projects fail", async () => {
    const error = new Error("projects unavailable");
    vi.mocked(api.fetchProjects).mockRejectedValue(error);
    const { result } = await renderStore();
    let reloadFailure: unknown;

    await act(async () => {
      try {
        await result.current.reload();
      } catch (caught) {
        reloadFailure = caught;
      }
    });

    expect(reloadFailure).toBe(error);
    await waitFor(() => expect(result.current.projectsError).toBe("projects unavailable"));
    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]);
    expect(result.current.dashboard).toEqual(SAMPLE_DASHBOARD_DATA);

    vi.mocked(api.fetchProjects).mockResolvedValueOnce(projectPage);
    await act(() => result.current.retryProjects());

    await waitFor(() => expect(result.current.projects).toEqual(projects));
    expect(result.current.projectsError).toBeNull();
  });

  it("retains the last project list when a refresh fails", async () => {
    const error = new Error("projects unavailable");
    const { result } = await renderStore();
    await act(() => result.current.reload());
    await waitFor(() => expect(result.current.projects).toEqual(projects));
    vi.mocked(api.fetchProjects).mockRejectedValueOnce(error);

    await act(() => result.current.retryProjects());

    await waitFor(() => expect(result.current.projectsError).toBe("projects unavailable"));
    expect(result.current.projects).toEqual(projects);
  });

  it("does not surface a cancelled project request as an error", async () => {
    let firstSignal: AbortSignal | undefined;
    vi.mocked(api.fetchProjects)
      .mockImplementationOnce(
        (_window, options) =>
          new Promise((_resolve, reject) => {
            firstSignal = options?.signal;
            options?.signal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      )
      .mockResolvedValue(projectPage);
    const firstWindow = { from: 1, to: 2 };
    const nextWindow = { from: 3, to: 4 };
    const { Wrapper } = createQueryWrapper();
    const { result, rerender } = renderHook(
      ({ selectedWindow }) => useSessionStore(selectedWindow),
      {
        wrapper: Wrapper,
        initialProps: { selectedWindow: firstWindow },
      },
    );
    await waitFor(() => expect(firstSignal).toBeDefined());
    rerender({ selectedWindow: nextWindow });

    await waitFor(() => expect(result.current.projects).toEqual(projects));
    expect(firstSignal?.aborted).toBe(true);
    expect(result.current.projectsError).toBeNull();
  });

  it("surfaces initial window load failures", async () => {
    const error = new Error("agents unavailable");
    vi.mocked(api.fetchAgents).mockRejectedValueOnce(error);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(config.window), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toContain("Failed to load session data"));
    expect(result.current.error).toContain("Failed to load session data");
    expect(result.current.sessions).toEqual([]);
  });

  it("keeps the projection available when a live aggregate refresh fails", async () => {
    const error = new Error("dashboard unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchDashboard).mockClear();
    now += 2_001;
    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(error);

    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));

    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledOnce());
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("does not republish the session projection when live aggregates finish", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { result, client } = await renderStore();
    await act(() => result.current.reload());
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Renamed" };
    const liveAgents = deferred<AgentInfo[]>();
    vi.mocked(api.fetchAgents).mockClear().mockReturnValueOnce(liveAgents.promise);
    vi.mocked(api.fetchDashboard).mockClear();
    now += 2_001;

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: changedSession.reference.sessionId },
            session: changedSession,
          },
        ],
      }),
    );

    const projectionKey = queryKeys.sessionProjection(config.window);
    const projectionAfterLive = client.getQueryData<SessionProjection>(projectionKey);
    expect(projectionAfterLive?.sessions).toEqual([changedSession]);
    await waitFor(() => expect(api.fetchAgents).toHaveBeenCalledOnce());

    liveAgents.resolve(agents);
    await waitFor(() => expect(result.current.agents).toEqual(agents));
    expect(client.getQueryData<SessionProjection>(projectionKey)).toBe(projectionAfterLive);
  });
});
