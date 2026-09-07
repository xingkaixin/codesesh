import { SAMPLE_SESSIONS_UPDATED_EVENT } from "@codesesh/core/test-fixtures";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsUpdatedEvent } from "../lib/api";
import * as api from "../lib/api";
import { useLiveSync } from "./useLiveSync";

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
      visibleNewSessions,
    }),
    resyncLiveState: vi.fn().mockResolvedValue(undefined),
    setScanStatus: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
      sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.liveNotice).toContain("3");
  });

  it("does not surface a notice when global additions stay outside the active window", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useLiveSync(makeDeps()));

    await act(async () => {
      sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(result.current.liveNotice).toBeNull();
  });

  it("merges burst updates into one store refresh", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));
    const first = { agentName: "claudecode", sessionId: "first" };
    const second = { agentName: "claudecode", sessionId: "second" };
    const third = { agentName: "claudecode", sessionId: "third" };

    await act(async () => {
      sessionsCallback?.({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [first],
        changedSessionHeads: [],
      });
      sessionsCallback?.({
        ...SAMPLE_SESSIONS_UPDATED_EVENT,
        newSessionRefs: [second, third],
        changedSessionHeads: [],
        timestamp: SAMPLE_SESSIONS_UPDATED_EVENT.timestamp + 1,
      });
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(deps.applyLiveEvent).toHaveBeenCalledOnce();
    expect(deps.applyLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        newSessionRefs: [first, second, third],
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
  it.each(["reconnect", "event-failure"])(
    "retries a failed resync after %s until recovery succeeds",
    async (trigger) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = makeDeps();
      let finishRecovery!: () => void;
      deps.resyncLiveState
        .mockRejectedValueOnce(new Error("HTTP unavailable"))
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishRecovery = resolve;
            }),
        );
      const { result } = renderHook(() => useLiveSync(deps));

      await act(async () => {
        if (trigger === "reconnect") reconnectCallback?.();
        else {
          deps.applyLiveEvent.mockRejectedValueOnce(new Error("Event apply failed"));
          sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
          await vi.advanceTimersByTimeAsync(500);
        }
      });
      expect(result.current.liveNotice).toBe("Live data may be out of date; synchronizing…");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(deps.resyncLiveState).toHaveBeenCalledTimes(2);
      expect(result.current.liveNotice).toBe("Live data may be out of date; synchronizing…");

      await act(async () => finishRecovery());
      expect(result.current.liveNotice).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(deps.resyncLiveState).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["disconnect", "unmount"] as const)(
    "cancels scheduled recovery on %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = makeDeps();
      deps.resyncLiveState.mockRejectedValue(new Error("HTTP unavailable"));
      const { unmount } = renderHook(() => useLiveSync(deps));
      await act(async () => reconnectCallback?.());

      if (reason === "unmount") unmount();
      else act(() => disconnectCallback?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(deps.resyncLiveState).toHaveBeenCalledOnce();
    },
  );

  it("does not let an older recovery clear a later disconnect", async () => {
    const deps = makeDeps();
    let finishRecovery!: () => void;
    deps.resyncLiveState.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRecovery = resolve;
        }),
    );
    const { result } = renderHook(() => useLiveSync(deps));
    await act(async () => reconnectCallback?.());
    act(() => disconnectCallback?.());
    await act(async () => finishRecovery());
    expect(result.current.liveNotice).toBe("Live updates disconnected; reconnecting…");
  });
  it.each(["disconnect", "unmount"] as const)(
    "does not start recovery when an in-flight event fails after %s",
    async (reason) => {
      vi.useFakeTimers();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const deps = makeDeps();
      let failEvent!: (error: Error) => void;
      deps.applyLiveEvent.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failEvent = reject;
          }),
      );
      const { result, unmount } = renderHook(() => useLiveSync(deps));
      await act(async () => {
        sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
        await vi.advanceTimersByTimeAsync(500);
      });
      if (reason === "unmount") unmount();
      else act(() => disconnectCallback?.());
      await act(async () => {
        failEvent(new Error("Event apply failed"));
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(deps.resyncLiveState).not.toHaveBeenCalled();
      if (reason === "disconnect") {
        expect(result.current.liveNotice).toBe("Live updates disconnected; reconnecting…");
        await act(async () => reconnectCallback?.());
        expect(deps.resyncLiveState).toHaveBeenCalledOnce();
        expect(result.current.liveNotice).toBeNull();
      }
    },
  );
});
