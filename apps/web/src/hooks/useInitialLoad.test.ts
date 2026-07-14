import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig } from "../lib/api";
import { useInitialLoad } from "./useInitialLoad";

vi.mock("../lib/api", () => ({ logClientEvent: vi.fn() }));

const appConfig = { window: { from: "a", to: "b" } } as unknown as AppConfig;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useInitialLoad", () => {
  it("loads config then base data and clears loading", async () => {
    const refreshAppConfig = vi.fn().mockResolvedValue(appConfig);
    const refreshSessions = vi.fn().mockResolvedValue([]);
    const { result } = renderHook(() =>
      useInitialLoad({
        refreshAppConfig,
        refreshAgents: vi.fn().mockResolvedValue([]),
        refreshSessions,
        refreshProjects: vi.fn().mockResolvedValue([]),
        resolveWindow: (window) => window,
      }),
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(refreshSessions).toHaveBeenCalledWith(appConfig.window);
    expect(result.current.error).toBeNull();
  });

  it("sets error when a base fetch fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() =>
      useInitialLoad({
        refreshAppConfig: vi.fn().mockResolvedValue(appConfig),
        refreshAgents: vi.fn().mockRejectedValue(new Error("boom")),
        refreshSessions: vi.fn().mockResolvedValue([]),
        refreshProjects: vi.fn().mockResolvedValue([]),
        resolveWindow: (window) => window,
      }),
    );

    await waitFor(() => expect(result.current.error).toContain("Failed to load"));
    expect(result.current.loading).toBe(false);
    errorSpy.mockRestore();
  });
});
