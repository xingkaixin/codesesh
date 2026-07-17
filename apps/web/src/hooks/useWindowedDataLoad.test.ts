import { SAMPLE_DASHBOARD_DATA } from "@codesesh/core/contract";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../lib/api";
import * as api from "../lib/api";
import type { SessionStoreSnapshot } from "./useSessionStore";
import { useWindowedDataLoad } from "./useWindowedDataLoad";

vi.mock("../lib/api", () => ({ logClientEvent: vi.fn() }));

const window = { from: 1, to: 2 } as AppConfig["window"];
const snapshot = {
  window,
  agents: [],
  sessions: [],
  projects: [],
  dashboard: SAMPLE_DASHBOARD_DATA,
} satisfies SessionStoreSnapshot;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useWindowedDataLoad", () => {
  it("stays idle until a selected window is available", () => {
    const reload = vi.fn();
    renderHook(() => useWindowedDataLoad({ window: null, reload }));
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads the store and records the snapshot counts", async () => {
    const reload = vi.fn().mockResolvedValue(snapshot);
    renderHook(() => useWindowedDataLoad({ window, reload }));

    await waitFor(() => expect(reload).toHaveBeenCalledWith(window));
    await waitFor(() =>
      expect(api.logClientEvent).toHaveBeenCalledWith("app.load.done", {
        duration_ms: expect.any(Number),
        agents: 0,
        sessions: 0,
        projects: 0,
      }),
    );
  });

  it("reloads once for each selected window", async () => {
    const reload = vi.fn().mockResolvedValue(snapshot);
    const { rerender } = renderHook(
      ({ selectedWindow }) => useWindowedDataLoad({ window: selectedWindow, reload }),
      { initialProps: { selectedWindow: window } },
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    const nextWindow = { from: 3, to: 4 };
    rerender({ selectedWindow: nextWindow });

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
    expect(reload).toHaveBeenLastCalledWith(nextWindow);
  });
});
