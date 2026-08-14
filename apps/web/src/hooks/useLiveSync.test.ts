import { SAMPLE_SESSIONS_UPDATED_EVENT } from "@codesesh/core/test-fixtures";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsUpdatedEvent } from "../lib/api";
import * as api from "../lib/api";
import { useLiveSync } from "./useLiveSync";
import type { SessionStoreSnapshot } from "./useSessionStore";

let sessionsCallback: ((event: SessionsUpdatedEvent) => void) | undefined;
let reconnectCallback: (() => void) | undefined;
let disconnectCallback: (() => void) | undefined;

vi.mock("../lib/api", () => ({
  subscribeSessionUpdates: vi.fn(
    (
      onSessions: (event: SessionsUpdatedEvent) => void,
      _onScanStatus?: unknown,
      onReconnect?: () => void,
      onDisconnect?: () => void,
    ) => {
      sessionsCallback = onSessions;
      reconnectCallback = onReconnect;
      disconnectCallback = onDisconnect;
      return () => {};
    },
  ),
}));

function makeDeps(visibleNewSessions = 0) {
  return {
    applyLiveEvent: vi.fn().mockResolvedValue({
      snapshot: {} as SessionStoreSnapshot,
      visibleNewSessions,
    }),
    resyncLiveState: vi.fn().mockResolvedValue({}),
    setScanStatus: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  sessionsCallback = undefined;
  reconnectCallback = undefined;
  disconnectCallback = undefined;
});

describe("useLiveSync", () => {
  it("subscribes on mount", () => {
    renderHook(() => useLiveSync(makeDeps()));
    expect(api.subscribeSessionUpdates).toHaveBeenCalledOnce();
  });

  it("forwards session events to the store", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));
    const event = SAMPLE_SESSIONS_UPDATED_EVENT;

    await act(async () => {
      sessionsCallback?.(event);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(deps.applyLiveEvent).toHaveBeenCalledWith(event);
  });

  it("surfaces a notice when new sessions arrive", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveSync(makeDeps(3)));

    await act(async () => {
      sessionsCallback?.({ ...SAMPLE_SESSIONS_UPDATED_EVENT, newSessions: 3 });
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.liveNotice).toContain("3");
  });

  it("does not surface a notice when global additions stay outside the active window", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveSync(makeDeps()));

    await act(async () => {
      sessionsCallback?.({ ...SAMPLE_SESSIONS_UPDATED_EVENT, newSessions: 3 });
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.liveNotice).toBeNull();
  });

  it("merges burst updates into one store refresh", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCallback?.({ ...SAMPLE_SESSIONS_UPDATED_EVENT, newSessions: 1 });
      sessionsCallback?.({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessions: 2,
        timestamp: SAMPLE_SESSIONS_UPDATED_EVENT.timestamp + 1,
      });
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(deps.applyLiveEvent).toHaveBeenCalledOnce();
    expect(deps.applyLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        newSessions: 3,
        timestamp: SAMPLE_SESSIONS_UPDATED_EVENT.timestamp + 1,
      }),
    );
  });

  it("shows a persistent connection notice on disconnect", () => {
    const { result } = renderHook(() => useLiveSync(makeDeps()));
    act(() => disconnectCallback?.());
    expect(result.current.liveNotice).toBe("Live updates disconnected; reconnecting…");
  });

  it("clears the notice and explicitly resyncs the store on reconnect", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));
    act(() => disconnectCallback?.());

    await act(async () => {
      reconnectCallback?.();
      await Promise.resolve();
    });

    expect(result.current.liveNotice).toBeNull();
    expect(deps.resyncLiveState).toHaveBeenCalledOnce();
    expect(deps.applyLiveEvent).not.toHaveBeenCalled();
  });
});
