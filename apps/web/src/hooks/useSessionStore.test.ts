import {
  SAMPLE_DASHBOARD_DATA,
  SAMPLE_SESSION_HEAD,
  SAMPLE_SESSIONS_UPDATED_EVENT,
} from "@codesesh/core/contract";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, AppConfig, ApiProjectGroup, SessionHead } from "../lib/api";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import {
  useSessionStore,
  type LiveSessionApplyResult,
  type SessionStoreSnapshot,
} from "./useSessionStore";

vi.mock("../lib/api", () => ({
  fetchAgents: vi.fn(),
  fetchConfig: vi.fn(),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => undefined);
  vi.mocked(api.fetchConfig).mockResolvedValue(config);
  vi.mocked(api.fetchAgents).mockResolvedValue(agents);
  vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [SAMPLE_SESSION_HEAD] });
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects });
  vi.mocked(api.fetchDashboard).mockResolvedValue(SAMPLE_DASHBOARD_DATA);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

async function renderStore() {
  const { client, Wrapper } = createQueryWrapper();
  const hook = renderHook(() => useSessionStore(), { wrapper: Wrapper });
  await waitFor(() => expect(hook.result.current.config).toEqual(config));
  return { ...hook, client };
}

describe("useSessionStore", () => {
  it("loads config before a window snapshot is requested", async () => {
    const { result } = await renderStore();

    expect(result.current.loading).toBe(true);
    expect(result.current.sessions).toEqual([]);
    expect(api.fetchConfig).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(api.fetchSessions).not.toHaveBeenCalled();
  });

  it("surfaces config failures", async () => {
    const error = new Error("config unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchConfig).mockRejectedValue(error);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toContain("Failed to load configuration"), {
      timeout: 2_000,
    });

    expect(result.current.loading).toBe(false);
    expect(api.fetchConfig).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith("Failed to load config:", error);

    vi.mocked(api.fetchConfig).mockResolvedValue(config);
    await act(() => result.current.retryLoad());

    await waitFor(() => expect(result.current.config).toEqual(config));
    expect(result.current.error).toBeNull();
    expect(api.fetchConfig).toHaveBeenCalledTimes(4);
  });

  it("recovers from a transient config failure automatically", async () => {
    const error = new Error("config unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchConfig).mockRejectedValueOnce(error).mockResolvedValue(config);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useSessionStore(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.config).toEqual(config));

    expect(result.current.error).toBeNull();
    expect(api.fetchConfig).toHaveBeenCalledTimes(2);
  });

  it("ignores live events until a window has been selected", async () => {
    const { result } = await renderStore();
    let snapshot: Awaited<ReturnType<typeof result.current.applyLiveEvent>> | undefined;

    await act(async () => {
      snapshot = await result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });

    expect(snapshot).toBeNull();
    expect(api.fetchAgents).not.toHaveBeenCalled();
  });

  it("handles a live event that arrives before the first window load completes", async () => {
    const { result } = await renderStore();
    let initialLoad!: ReturnType<typeof result.current.reload>;
    let liveUpdate!: ReturnType<typeof result.current.applyLiveEvent>;

    act(() => {
      initialLoad = result.current.reload(config.window);
      liveUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });
    let snapshots!: [LiveSessionApplyResult | null, SessionStoreSnapshot | null];
    await act(async () => {
      snapshots = await Promise.all([liveUpdate, initialLoad]);
    });
    const [liveSnapshot] = snapshots;

    expect(liveSnapshot?.snapshot.window).toEqual(config.window);
    await waitFor(() => expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]));
  });

  it("commits all window data as one snapshot", async () => {
    const { result } = await renderStore();

    await act(() => result.current.reload(config.window));

    expect(result.current.loading).toBe(false);
    expect(result.current.agents).toEqual(agents);
    expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]);
    expect(result.current.projects).toEqual(projects);
    expect(result.current.dashboard).toEqual(SAMPLE_DASHBOARD_DATA);
    expect(result.current.activeAgents).toEqual([agents[0]]);
    expect(result.current.agentCatalog.byKey.get("codex")).toBe(agents[1]);
    expect(result.current.validAgentKeys.has("claudecode")).toBe(true);
    expect(result.current.validAgentKeys.has("codex")).toBe(false);
    expect(result.current.agentNameMap.get("claudecode")).toBe("Claude Code");
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("renders the first session page while the complete window keeps loading", async () => {
    const completeSessions = deferred<{ sessions: SessionHead[] }>();
    const finalSession = {
      ...SAMPLE_SESSION_HEAD,
      id: "final-session",
      slug: "claudecode/final-session",
    };
    vi.mocked(api.fetchSessions).mockImplementation(async (_options, _fetchOptions, progress) => {
      progress?.onFirstPage?.([SAMPLE_SESSION_HEAD]);
      return completeSessions.promise;
    });
    const { result } = await renderStore();

    let load!: ReturnType<typeof result.current.reload>;
    act(() => {
      load = result.current.reload(config.window);
    });

    await waitFor(() => expect(result.current.sessions).toEqual([SAMPLE_SESSION_HEAD]));
    expect(result.current.loading).toBe(false);

    completeSessions.resolve({ sessions: [SAMPLE_SESSION_HEAD, finalSession] });
    await act(() => load);

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
    const { result } = await renderStore();
    const firstWindow = { from: 1, to: 2 };
    const latestWindow = { from: 3, to: 4 };

    let firstReload!: ReturnType<typeof result.current.reload>;
    act(() => {
      firstReload = result.current.reload(firstWindow);
    });
    await act(() => result.current.reload(latestWindow));
    firstAgents.resolve(agents);
    await act(() => firstReload);

    expect(result.current.window).toEqual(latestWindow);
    expect(result.current.agents).toEqual(latestAgents);
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("applies live events to the latest window after a rapid switch", async () => {
    const { result, client } = await renderStore();
    const firstWindow = { from: 1_700_000_000_000, to: 1_700_004_000_000 };
    const latestWindow = { from: 1_699_999_000_000, to: 1_700_005_000_000 };
    await act(() => result.current.reload(firstWindow));
    await act(() => result.current.reload(latestWindow));
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Latest window" };

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: changedSession.id },
            session: changedSession,
          },
        ],
      }),
    );

    expect(result.current.window).toEqual(latestWindow);
    await waitFor(() => expect(result.current.sessions).toEqual([changedSession]));
    expect(
      client.getQueryData<SessionStoreSnapshot>(queryKeys.sessionSnapshot(firstWindow))?.sessions,
    ).toEqual([SAMPLE_SESSION_HEAD]);
  });

  it("applies an incremental live session diff without re-fetching sessions", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchSessions).mockClear();
    vi.mocked(api.fetchAgents).mockClear();
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Renamed" };

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: changedSession.id },
            session: changedSession,
          },
        ],
      }),
    );

    await waitFor(() => expect(result.current.sessions).toEqual([changedSession]));
    expect(api.fetchSessions).not.toHaveBeenCalled();
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
      id: `historical-${index}`,
      slug: `claudecode/historical-${index}`,
      time_created: 10,
      time_updated: 10,
    }));
    vi.mocked(api.fetchSessions).mockResolvedValueOnce({ sessions: [recentSession] });
    const { result } = await renderStore();
    await act(() => result.current.reload(window));
    let update!: LiveSessionApplyResult | null;

    await act(async () => {
      update = await result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessions: historicalSessions.length,
        newSessionRefs: historicalSessions.map((session) => ({
          agentName: "claudecode",
          sessionId: session.id,
        })),
        totalSessions: historicalSessions.length + 1,
        changedSessionHeads: historicalSessions.map((session) => ({
          reference: { agentName: "claudecode", sessionId: session.id },
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
      id: "new-visible",
      slug: "claudecode/new-visible",
      time_created: 160,
      time_updated: 160,
    };
    vi.mocked(api.fetchSessions).mockResolvedValueOnce({ sessions: [recentSession] });
    const { result } = await renderStore();
    await act(() => result.current.reload(window));
    let update!: LiveSessionApplyResult | null;

    await act(async () => {
      update = await result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [{ agentName: "claudecode", sessionId: addedSession.id }],
        changedSessionHeads: [
          {
            reference: { agentName: "claudecode", sessionId: addedSession.id },
            session: addedSession,
          },
        ],
      });
    });

    expect(update?.visibleNewSessions).toBe(1);
  });

  it("invalidates project dashboards, server searches, and inactive aggregate caches", async () => {
    const { result, client } = await renderStore();
    await act(() => result.current.reload(config.window));
    const projectDashboardKey = queryKeys.dashboard(config.window, {
      project: { kind: "path", key: "p1" },
    });
    const searchKey = queryKeys.search("needle", {});
    const inactiveAggregateKey = queryKeys.sessionSnapshotAggregates({ from: 10, to: 20 });
    client.setQueryData(projectDashboardKey, SAMPLE_DASHBOARD_DATA);
    client.setQueryData(searchKey, []);
    client.setQueryData(inactiveAggregateKey, {
      agents,
      projects,
      dashboard: SAMPLE_DASHBOARD_DATA,
    });

    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));

    expect(client.getQueryState(projectDashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(searchKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(inactiveAggregateKey)?.isInvalidated).toBe(true);
  });

  it("invalidates only session details changed by a live event", async () => {
    const { result, client } = await renderStore();
    await act(() => result.current.reload(config.window));
    const changedDetailKey = queryKeys.sessionDetail("claudecode", SAMPLE_SESSION_HEAD.id);
    const unchangedDetailKey = queryKeys.sessionDetail("claudecode", "unchanged-session");
    const relatedDetailKey = queryKeys.sessionDetail("claudecode", "related-session");
    client.setQueryData(changedDetailKey, { id: SAMPLE_SESSION_HEAD.id });
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
              id: "related-session",
              slug: "claudecode/related-session",
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
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchSessions).mockClear();

    await act(() => result.current.resyncLiveState());

    expect(api.fetchSessions).toHaveBeenCalledOnce();
    expect(result.current.version).toBeGreaterThan(0);
  });

  it("keeps overlapping live events on the incremental path", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
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

  it("keeps the snapshot usable when projects fail to load", async () => {
    const error = new Error("projects unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchProjects).mockRejectedValue(error);
    const { result } = await renderStore();

    await act(() => result.current.reload(config.window));

    expect(result.current.projects).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(console.error).toHaveBeenCalledWith("Failed to load projects:", error);
  });

  it("surfaces full reload failures without replacing the snapshot", async () => {
    const error = new Error("agents unavailable");
    vi.mocked(api.fetchAgents).mockRejectedValueOnce(error);
    const { result } = await renderStore();

    await act(async () => {
      await expect(result.current.reload(config.window)).rejects.toBe(error);
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("Failed to load session data");
    expect(result.current.sessions).toEqual([]);
  });

  it("surfaces live refresh failures without replacing the snapshot", async () => {
    const error = new Error("dashboard unavailable");
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(error);

    await act(async () => {
      await expect(result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT)).rejects.toBe(
        error,
      );
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.version).toBeGreaterThan(0);
  });
});
