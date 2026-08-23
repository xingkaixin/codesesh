import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../lib/api";
import * as api from "../lib/api";
import { useWindowLoadTelemetry } from "./useWindowLoadTelemetry";

vi.mock("../lib/api", () => ({ logClientEvent: vi.fn() }));

const window = { from: 1, to: 2 } as AppConfig["window"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useWindowLoadTelemetry", () => {
  it("stays idle until a selected window is available", () => {
    renderHook(() =>
      useWindowLoadTelemetry({
        window: null,
        pending: true,
        error: null,
        agentCount: 0,
        sessionCount: 0,
      }),
    );

    expect(api.logClientEvent).not.toHaveBeenCalled();
  });

  it("records a completed window load", async () => {
    const { rerender } = renderHook((state) => useWindowLoadTelemetry(state), {
      initialProps: {
        window,
        pending: true,
        error: null as string | null,
        agentCount: 0,
        sessionCount: 0,
      },
    });

    rerender({ window, pending: false, error: null, agentCount: 2, sessionCount: 10 });

    await waitFor(() =>
      expect(api.logClientEvent).toHaveBeenCalledWith("app.load.done", {
        duration_ms: expect.any(Number),
        agents: 2,
        sessions: 10,
      }),
    );
  });

  it("records a failed window load", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = renderHook((state) => useWindowLoadTelemetry(state), {
      initialProps: {
        window,
        pending: true,
        error: null as string | null,
        agentCount: 0,
        sessionCount: 0,
      },
    });

    rerender({ window, pending: false, error: "reload failed", agentCount: 0, sessionCount: 0 });

    await waitFor(() =>
      expect(api.logClientEvent).toHaveBeenCalledWith("app.load.error", {
        duration_ms: expect.any(Number),
        error: "reload failed",
      }),
    );
    expect(console.error).toHaveBeenCalledWith("Failed to load data:", "reload failed");
  });
});
