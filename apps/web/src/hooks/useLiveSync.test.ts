import { SAMPLE_SESSIONS_UPDATED_EVENT } from "@codesesh/contract/test-fixtures";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionsUpdatedEvent } from "@codesesh/contract";
import { useLiveSync } from "./useLiveSync";

let sessionsCallback: ((event: SessionsUpdatedEvent) => void) | undefined;
let reconnectCallback: (() => void) | undefined;
let disconnectCallback: (() => void) | undefined;

// oxlint-disable-next-line anti-slop/no-module-mocking -- Drive subscription events and observe telemetry without a live SSE server.
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
  it("holds session events while the page is hidden and applies them once visible", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));

    await act(async () => {
      sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
      sessionsCallback?.(SAMPLE_SESSIONS_UPDATED_EVENT);
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(deps.applyLiveEvent).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(deps.applyLiveEvent).toHaveBeenCalledOnce();
  });

  it("merges events that arrive during a slow update into one follow-up", async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    let finishUpdate!: () => void;
    deps.applyLiveEvent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpdate = () => resolve({ visibleNewSessions: 0 });
        }),
    );
    renderHook(() => useLiveSync(deps));
    const refs = ["first", "second", "third"].map((sessionId) => ({
      agentName: "claudecode",
      sessionId,
    }));

    for (const [index, reference] of refs.entries()) {
      await act(async () => {
        sessionsCallback?.({
          ...SAMPLE_SESSIONS_UPDATED_EVENT,
          newSessionRefs: [reference],
          changedSessionHeads: [],
          timestamp: SAMPLE_SESSIONS_UPDATED_EVENT.timestamp + index,
        });
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    expect(deps.applyLiveEvent).toHaveBeenCalledOnce();

    await act(async () => {
      finishUpdate();
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(deps.applyLiveEvent).toHaveBeenCalledTimes(2);
    expect(deps.applyLiveEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ newSessionRefs: refs.slice(1) }),
    );
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
});
