import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, SessionsUpdatedEvent } from "../lib/api";
import type { ViewState } from "../lib/view-state";
import * as api from "../lib/api";
import { resolveTimeWindow as resolveWindowFromParams } from "../lib/time-window";
import { useLiveSync } from "./useLiveSync";

let sessionsCb: ((event: SessionsUpdatedEvent) => void) | undefined;
let reconnectCb: (() => void) | undefined;
let disconnectCb: (() => void) | undefined;

vi.mock("../lib/api", () => ({
  subscribeSessionUpdates: vi.fn(
    (
      onSessions: (event: SessionsUpdatedEvent) => void,
      _onScanStatus?: unknown,
      onReconnect?: () => void,
      onDisconnect?: () => void,
    ) => {
      sessionsCb = onSessions;
      reconnectCb = onReconnect;
      disconnectCb = onDisconnect;
      return () => {};
    },
  ),
}));

const appConfig = { window: { from: "a", to: "b" } } as unknown as AppConfig;
const rootView = { mode: "root", activeAgentKey: null, activeSessionSlug: null } as ViewState;

function makeDeps() {
  return {
    resolveTimeWindow: vi.fn(() => appConfig.window),
    viewState: rootView,
    refreshAgents: vi.fn().mockResolvedValue(undefined),
    refreshSessions: vi.fn().mockResolvedValue(undefined),
    refreshProjects: vi.fn().mockResolvedValue(undefined),
    refreshDashboard: vi.fn().mockResolvedValue(undefined),
    refreshProjectDashboard: vi.fn().mockResolvedValue(undefined),
    refreshSessionDetail: vi.fn().mockResolvedValue(undefined),
    refreshSearch: vi.fn().mockResolvedValue(undefined),
    setScanStatus: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionsCb = undefined;
  reconnectCb = undefined;
  disconnectCb = undefined;
});

describe("useLiveSync", () => {
  it("resolves the rolling preset when an update arrives after midnight", async () => {
    vi.useFakeTimers();
    const openedAt = new Date(2026, 6, 15, 12).getTime();
    vi.setSystemTime(openedAt);
    const params = new URLSearchParams("range=7d");
    const fallback = { days: 7 };
    const deps = makeDeps();
    deps.resolveTimeWindow = vi.fn(() => resolveWindowFromParams(params, fallback).window);
    renderHook(() => useLiveSync(deps));

    const refreshedAt = new Date(2026, 6, 16, 12).getTime();
    vi.setSystemTime(refreshedAt);
    await act(async () => {
      sessionsCb?.({ newSessions: 1 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    expect(deps.refreshSessions).toHaveBeenCalledWith(
      resolveWindowFromParams(params, fallback, refreshedAt).window,
    );
  });

  it("subscribes on mount", () => {
    renderHook(() => useLiveSync(makeDeps()));
    expect(api.subscribeSessionUpdates).toHaveBeenCalledOnce();
  });

  it("fans out refreshes on a session event", async () => {
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCb?.({ newSessions: 0 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    expect(deps.refreshAgents).toHaveBeenCalled();
    expect(deps.resolveTimeWindow).toHaveBeenCalled();
    expect(deps.refreshDashboard).toHaveBeenCalled();
    expect(deps.refreshSearch).toHaveBeenCalled();
  });

  it("surfaces liveNotice when new sessions arrive", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCb?.({ newSessions: 3 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.liveNotice).toContain("3"));
  });

  it("shows a persistent connection notice on disconnect", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));

    act(() => {
      disconnectCb?.();
    });

    expect(result.current.liveNotice).toBe("实时更新已断开，重连中…");
  });

  it("clears the connection notice and refreshes everything on reconnect", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));

    act(() => {
      disconnectCb?.();
    });
    expect(result.current.liveNotice).toBe("实时更新已断开，重连中…");

    await act(async () => {
      reconnectCb?.();
      await Promise.resolve();
    });

    expect(result.current.liveNotice).toBeNull();
    expect(deps.refreshAgents).toHaveBeenCalled();
    expect(deps.refreshDashboard).toHaveBeenCalled();
    expect(deps.refreshSearch).toHaveBeenCalled();
  });

  it("connection notice takes priority over a transient liveNotice", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCb?.({ newSessions: 2 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.liveNotice).toContain("2"));

    act(() => {
      disconnectCb?.();
    });

    expect(result.current.liveNotice).toBe("实时更新已断开，重连中…");
  });
});
