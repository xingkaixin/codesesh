import {
  SAMPLE_DASHBOARD_DATA,
  SAMPLE_SESSION_HEAD,
  SAMPLE_SESSIONS_UPDATED_EVENT,
} from "@codesesh/core/contract";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, AppConfig, ProjectGroup } from "../lib/api";
import * as api from "../lib/api";
import { useSessionStore } from "./useSessionStore";

vi.mock("../lib/api", () => ({
  fetchAgents: vi.fn(),
  fetchConfig: vi.fn(),
  fetchDashboard: vi.fn(),
  fetchProjects: vi.fn(),
  fetchSessions: vi.fn(),
}));

const config = { window: { from: 1, to: 2, days: 7 } } as AppConfig;
const agents = [
  { name: "ClaudeCode", displayName: "Claude Code", count: 1 },
  { name: "Codex", displayName: "Codex", count: 0 },
] as unknown as AgentInfo[];
const projects = [{ identityKind: "path", identityKey: "p1" }] as unknown as ProjectGroup[];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(api.fetchConfig).mockResolvedValue(config);
  vi.mocked(api.fetchAgents).mockResolvedValue(agents);
  vi.mocked(api.fetchSessions).mockResolvedValue({ sessions: [SAMPLE_SESSION_HEAD] });
  vi.mocked(api.fetchProjects).mockResolvedValue({ projects });
  vi.mocked(api.fetchDashboard).mockResolvedValue(SAMPLE_DASHBOARD_DATA);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderStore() {
  const hook = renderHook(() => useSessionStore());
  await waitFor(() => expect(hook.result.current.config).toEqual(config));
  return hook;
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
    vi.mocked(api.fetchConfig).mockRejectedValueOnce(error);
    const { result } = renderHook(() => useSessionStore());

    await waitFor(() => expect(result.current.error).toContain("Failed to load data"));

    expect(result.current.loading).toBe(false);
    expect(console.error).toHaveBeenCalledWith("Failed to load config:", error);
  });

  it("ignores live events until a window has loaded", async () => {
    const { result } = await renderStore();
    let snapshot: Awaited<ReturnType<typeof result.current.applyLiveEvent>> | undefined;

    await act(async () => {
      snapshot = await result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });

    expect(snapshot).toBeNull();
    expect(api.fetchAgents).not.toHaveBeenCalled();
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
    expect(result.current.version).toBe(1);
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
    expect(result.current.version).toBe(1);
  });

  it("applies an incremental live session diff without re-fetching sessions", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchSessions).mockClear();
    const changedSession = { ...SAMPLE_SESSION_HEAD, display_title: "Renamed" };

    await act(() =>
      result.current.applyLiveEvent({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        changedSessionHeads: [{ agentName: "claudecode", session: changedSession }],
      }),
    );

    expect(result.current.sessions).toEqual([changedSession]);
    expect(api.fetchSessions).not.toHaveBeenCalled();
    expect(result.current.version).toBe(2);
  });

  it("falls back to a full reload for reconnect events without a diff", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchSessions).mockClear();

    await act(() =>
      result.current.applyLiveEvent({
        type: "sessions-updated",
        changedAgents: [],
        newSessions: 0,
        updatedSessions: 0,
        removedSessions: 0,
        totalSessions: 0,
        timestamp: Date.now(),
      }),
    );

    expect(api.fetchSessions).toHaveBeenCalledOnce();
    expect(result.current.version).toBe(2);
  });

  it("uses a full reload when live events overlap", async () => {
    const { result } = await renderStore();
    await act(() => result.current.reload(config.window));
    vi.mocked(api.fetchSessions).mockClear();
    const firstAgents = deferred<AgentInfo[]>();
    vi.mocked(api.fetchAgents).mockReturnValueOnce(firstAgents.promise).mockResolvedValue(agents);

    let firstUpdate!: ReturnType<typeof result.current.applyLiveEvent>;
    act(() => {
      firstUpdate = result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT);
    });
    await act(() => result.current.applyLiveEvent(SAMPLE_SESSIONS_UPDATED_EVENT));
    firstAgents.resolve(agents);
    await act(() => firstUpdate);

    expect(api.fetchSessions).toHaveBeenCalledOnce();
    expect(result.current.version).toBe(2);
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

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toContain("Failed to load data");
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
    expect(result.current.error).toContain("Failed to load data");
    expect(result.current.version).toBe(1);
  });
});
