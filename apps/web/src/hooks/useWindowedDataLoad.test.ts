import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, FetchOptions } from "../lib/api";
import { useWindowedDataLoad } from "./useWindowedDataLoad";

vi.mock("../lib/api", () => ({ logClientEvent: vi.fn() }));

const appConfig = { window: { from: 1, to: 2 } } as AppConfig;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useWindowedDataLoad", () => {
  it("loads config then base data with one abort signal", async () => {
    const refreshAppConfig = vi.fn().mockResolvedValue(appConfig);
    const refreshAgents = vi.fn().mockResolvedValue([]);
    const refreshSessions = vi.fn().mockResolvedValue([]);
    const refreshProjects = vi.fn().mockResolvedValue([]);
    const resolveSelectedWindow = (window: AppConfig["window"]) => window;
    const { result } = renderHook(() =>
      useWindowedDataLoad({
        refreshAppConfig,
        refreshAgents,
        refreshSessions,
        refreshProjects,
        resolveSelectedWindow,
      }),
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));

    const fetchOptions = refreshAppConfig.mock.calls[0]?.[0] as FetchOptions;
    expect(fetchOptions.signal).toBeInstanceOf(AbortSignal);
    expect(refreshSessions).toHaveBeenCalledWith(appConfig.window, fetchOptions);
    expect(result.current.error).toBeNull();
  });

  it("aborts the previous load when the selected window changes", async () => {
    const refreshAppConfig = vi.fn().mockResolvedValue(appConfig);
    const refreshAgents = vi.fn().mockResolvedValue([]);
    const refreshProjects = vi.fn().mockResolvedValue([]);
    const refreshSessions = vi
      .fn()
      .mockImplementationOnce((_window: AppConfig["window"], options?: FetchOptions) => {
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      })
      .mockResolvedValueOnce([]);
    const firstWindow = () => ({ from: 1 });
    const secondWindow = () => ({ from: 2 });
    const { result, rerender } = renderHook(
      ({ resolveSelectedWindow }) =>
        useWindowedDataLoad({
          refreshAppConfig,
          refreshAgents,
          refreshSessions,
          refreshProjects,
          resolveSelectedWindow,
        }),
      { initialProps: { resolveSelectedWindow: firstWindow } },
    );

    await waitFor(() => expect(refreshSessions).toHaveBeenCalledTimes(1));
    const firstOptions = refreshSessions.mock.calls[0]?.[1] as FetchOptions;

    rerender({ resolveSelectedWindow: secondWindow });

    await waitFor(() => expect(refreshSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(firstOptions.signal?.aborted).toBe(true);
    expect(refreshSessions.mock.calls[1]?.[0]).toEqual({ from: 2 });
    expect(result.current.error).toBeNull();
  });

  it("sets error when a current base fetch fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resolveSelectedWindow = (window: AppConfig["window"]) => window;
    const { result } = renderHook(() =>
      useWindowedDataLoad({
        refreshAppConfig: vi.fn().mockResolvedValue(appConfig),
        refreshAgents: vi.fn().mockRejectedValue(new Error("boom")),
        refreshSessions: vi.fn().mockResolvedValue([]),
        refreshProjects: vi.fn().mockResolvedValue([]),
        resolveSelectedWindow,
      }),
    );

    await waitFor(() => expect(result.current.error).toContain("Failed to load"));
    expect(result.current.loading).toBe(false);
    errorSpy.mockRestore();
  });
});
