import {
  SAMPLE_DASHBOARD_DATA,
  SAMPLE_SESSION_HEAD,
  SAMPLE_SESSIONS_UPDATED_EVENT,
} from "@codesesh/contract/test-fixtures";
import {
  createSessionIdentity,
  type AgentInfo,
  type AppConfig,
  type ApiProjectGroup,
  type ApiProjectPage,
  type SessionHead,
  type BookmarkView,
} from "@codesesh/contract";
import { defaultScheduler, notifyManager, useQuery } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import {
  useSessionStore,
  type LiveSessionApplyResult,
  type SessionProjection,
} from "./useSessionStore";
import { useDashboard } from "./useDashboard";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", async (importOriginal) => {
  const { ApiRequestError } = await importOriginal<typeof import("../lib/api")>();
  return {
    ApiRequestError,
    fetchAgents: vi.fn(),
    fetchDashboard: vi.fn(),
    fetchProjects: vi.fn(),
    fetchSessions: vi.fn(),
  };
});

const config = {
  window: { from: 1_700_000_000_000, to: 1_700_004_000_000, days: 7 },
} as AppConfig;
const agents = [
  { name: "ClaudeCode", displayName: "Claude Code", count: 1 },
  { name: "Codex", displayName: "Codex", count: 0 },
] as AgentInfo[];
const projects = [{ identityKind: "path", identityKey: "p1" }] as ApiProjectGroup[];
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
  notifyManager.setScheduler(defaultScheduler);
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function renderStore(window: AppConfig["window"] = config.window, loadDashboard = true) {
  const { client, Wrapper } = createQueryWrapper();
  const hook = renderHook(({ selectedWindow }) => useSessionStore(selectedWindow, loadDashboard), {
    wrapper: Wrapper,
    initialProps: { selectedWindow: window },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, client };
}

describe("useSessionStore", () => {
  it.each(["live", "resync"] as const)(
    "refreshes materialized bookmark views on %s",
    async (refresh) => {
      const initial: BookmarkView = {
        reference: SAMPLE_SESSION_HEAD.reference,
        bookmarkedAt: 1,
        availability: "session-unavailable",
      };
      const updated: BookmarkView = {
        ...initial,
        availability: "available",
        session: { ...SAMPLE_SESSION_HEAD, title: "Updated title" },
      };
      const fetchBookmarks = vi.fn().mockResolvedValue({ bookmarks: [initial] });
      const { Wrapper } = createQueryWrapper();
      const { result } = renderHook(
        () => ({
          store: useSessionStore(config.window),
          bookmarks: useQuery({ queryKey: queryKeys.bookmarks, queryFn: fetchBookmarks }),
        }),
        { wrapper: Wrapper },
      );
      await waitFor(() => expect(result.current.store.loading).toBe(false));
      await waitFor(() => expect(result.current.bookmarks.data?.bookmarks).toEqual([initial]));
      fetchBookmarks.mockResolvedValue({ bookmarks: [updated] });

      await act(async () => {
        if (refresh === "resync") await result.current.store.resyncLiveState();
        else await result.current.store.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
      });

      await waitFor(() => expect(result.current.bookmarks.data?.bookmarks).toEqual([updated]));
    },
  );

  it("retains a complete projection when a refresh fails after its first page", async () => {
    const secondSession = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "second-session" }),
    };
    const completeSessions = [SAMPLE_SESSION_HEAD, secondSession];
    vi.mocked(api.fetchSessions).mockResolvedValueOnce({ sessions: completeSessions });
    const { result } = await renderStore();
    vi.mocked(api.fetchSessions).mockImplementationOnce(
      async (_options, _fetchOptions, progress) => {
        progress?.onFirstPage?.([SAMPLE_SESSION_HEAD]);
        throw new Error("second page unavailable");
      },
    );

    await act(() => result.current.retrySessions());

    await waitFor(() => expect(result.current.sessionListLoad.status).toBe("failed"));
    expect(result.current.sessions).toEqual(completeSessions);
    expect(result.current.error).toBeNull();
  });

  it("keeps a complete session list complete while it refreshes in the background", async () => {
    const { result } = await renderStore();
    const refresh = deferred<{ sessions: SessionHead[] }>();
    vi.mocked(api.fetchSessions).mockReturnValueOnce(refresh.promise);

    let retried!: Promise<void>;
    act(() => {
      retried = result.current.retrySessions();
    });

    await waitFor(() => expect(api.fetchSessions).toHaveBeenCalledTimes(2));
    expect(result.current.sessionListLoad.status).toBe("complete");
    await act(async () => {
      refresh.resolve({ sessions: [SAMPLE_SESSION_HEAD] });
      await retried;
    });
  });

  it("preserves live additions received while the first page is still loading", async () => {
    const response = deferred<{ sessions: SessionHead[] }>();
    let firstPage!: (sessions: SessionHead[]) => void;
    vi.mocked(api.fetchSessions).mockImplementationOnce((_options, _fetchOptions, progress) => {
      firstPage = progress!.onFirstPage!;
      return response.promise;
    });
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(config.window), { wrapper: Wrapper });
    await waitFor(() => expect(api.fetchSessions).toHaveBeenCalled());
    const added = {
      ...SAMPLE_SESSION_HEAD,
      ...createSessionIdentity({ agentName: "claudecode", sessionId: "live-added" }),
    };
    let applied!: ReturnType<typeof result.current.applyLiveEvent>;
    act(() => {
      applied = result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [added.reference],
        changedSessionHeads: [{ reference: added.reference, session: added }],
        projectionSessionOrder: [SAMPLE_SESSION_HEAD.reference, added.reference],
      });
    });
    act(() => firstPage([SAMPLE_SESSION_HEAD]));
    await waitFor(() => expect(result.current.sessions).toContainEqual(added));
    const changed = { ...added, title: "Updated while loading" };
    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [],
        changedSessionHeads: [{ reference: changed.reference, session: changed }],
        projectionSessionOrder: [SAMPLE_SESSION_HEAD.reference, changed.reference],
      }),
    );
    await act(async () => {
      response.resolve({ sessions: [SAMPLE_SESSION_HEAD] });
      await applied;
    });
    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.sessions).toContainEqual(changed);
  });

  it("preserves live changes and removals when an older full response finishes", async () => {
    // Query completion can precede observer delivery on a busy event loop.
    notifyManager.setScheduler((callback) => setTimeout(callback, 50));
    const { result, client } = await renderStore();
    const response = deferred<{ sessions: SessionHead[] }>();
    vi.mocked(api.fetchSessions).mockReturnValueOnce(response.promise);
    let reload!: Promise<void>;
    act(() => {
      reload = result.current.reload();
    });
    await waitFor(() => expect(api.fetchSessions).toHaveBeenCalledTimes(2));
    const changed = { ...SAMPLE_SESSION_HEAD, title: "Live title" };
    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [{ reference: changed.reference, session: changed }],
      }),
    );
    await act(async () => {
      response.resolve({ sessions: [SAMPLE_SESSION_HEAD] });
      await reload;
    });
    expect(
      client.getQueryData<SessionProjection>(queryKeys.sessionProjection(config.window))
        ?.sessions[0]?.title,
    ).toBe("Live title");
    await waitFor(() => expect(result.current.sessions[0]?.title).toBe("Live title"));

    const removedResponse = deferred<{ sessions: SessionHead[] }>();
    vi.mocked(api.fetchSessions).mockReturnValueOnce(removedResponse.promise);
    act(() => {
      reload = result.current.reload();
    });
    await waitFor(() => expect(api.fetchSessions).toHaveBeenCalledTimes(3));
    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [],
        newSessionRefs: [],
        projectionSessionOrder: [],
        removedSessionRefs: [changed.reference],
      }),
    );
    await act(async () => {
      removedResponse.resolve({ sessions: [changed] });
      await reload;
    });
    expect(
      client.getQueryData<SessionProjection>(queryKeys.sessionProjection(config.window))?.sessions,
    ).toEqual([]);
    await waitFor(() => expect(result.current.sessions).toEqual([]));
  });

  it("keeps the latest snapshot when an earlier request finishes late", async () => {
    const firstAgents = deferred<AgentInfo[]>();
    const latestAgents = [{ name: "Codex", displayName: "Codex" }] as AgentInfo[];
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

  it("refreshes the visible scoped dashboard after a live event", async () => {
    const filters = { project: { kind: "path" as const, key: "p1" }, agent: "claudecode" };
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(
      () => ({
        store: useSessionStore(config.window, false),
        scoped: useDashboard(config.window, filters),
      }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.store.loading).toBe(false));
    await waitFor(() => expect(result.current.scoped.dashboard).toEqual(SAMPLE_DASHBOARD_DATA));
    const liveDashboard = {
      ...SAMPLE_DASHBOARD_DATA,
      totals: { ...SAMPLE_DASHBOARD_DATA.totals, sessions: 50 },
    };
    vi.mocked(api.fetchDashboard).mockImplementation(async (_window, scope) =>
      scope?.project ? liveDashboard : SAMPLE_DASHBOARD_DATA,
    );

    await act(() => result.current.store.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));

    await waitFor(() => expect(result.current.scoped.dashboard).toEqual(liveDashboard));
    expect(api.fetchDashboard).toHaveBeenCalledTimes(2);
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

  it("refreshes aggregates again after an event arrives during an in-flight refresh", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload());
    vi.mocked(api.fetchSessions).mockClear();
    const firstAgents = deferred<AgentInfo[]>();
    const updatedAgents = agents.map((agent) => ({ ...agent, count: agent.count + 1 }));
    vi.mocked(api.fetchAgents)
      .mockClear()
      .mockReturnValueOnce(firstAgents.promise)
      .mockResolvedValue(updatedAgents);

    let firstUpdate!: ReturnType<typeof result.current.applyLiveEvent>;
    let secondUpdate!: ReturnType<typeof result.current.applyLiveEvent>;
    act(() => {
      firstUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
      secondUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });
    await act(() => Promise.all([firstUpdate, secondUpdate]));
    expect(api.fetchAgents).toHaveBeenCalledOnce();
    firstAgents.resolve(agents);
    await act(async () => firstAgents.promise);

    await waitFor(() => expect(result.current.agents).toEqual(updatedAgents));
    expect(api.fetchAgents).toHaveBeenCalledTimes(2);
    expect(api.fetchSessions).not.toHaveBeenCalled();
    expect(result.current.version).toBeGreaterThan(0);
  });
});
