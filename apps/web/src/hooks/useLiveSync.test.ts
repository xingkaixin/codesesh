import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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

function makeDeps() {
  return {
    applyLiveEvent: vi.fn().mockResolvedValue({}),
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
    const deps = makeDeps();
    renderHook(() => useLiveSync(deps));
    const event = { newSessions: 0 } as SessionsUpdatedEvent;

    await act(async () => {
      sessionsCallback?.(event);
      await Promise.resolve();
    });

    expect(deps.applyLiveEvent).toHaveBeenCalledWith(event);
  });

  it("surfaces a notice when new sessions arrive", async () => {
    const { result } = renderHook(() => useLiveSync(makeDeps()));

    await act(async () => {
      sessionsCallback?.({ newSessions: 3 } as SessionsUpdatedEvent);
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.liveNotice).toContain("3"));
  });

  it("shows a persistent connection notice on disconnect", () => {
    const { result } = renderHook(() => useLiveSync(makeDeps()));
    act(() => disconnectCallback?.());
    expect(result.current.liveNotice).toBe("实时更新已断开，重连中…");
  });

  it("clears the notice and asks the store for a full reload on reconnect", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useLiveSync(deps));
    act(() => disconnectCallback?.());

    await act(async () => {
      reconnectCallback?.();
      await Promise.resolve();
    });

    expect(result.current.liveNotice).toBeNull();
    expect(deps.applyLiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessions-updated" }),
    );
  });
});
