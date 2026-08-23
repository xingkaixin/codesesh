import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../lib/api";
import * as api from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
import { useAppConfig } from "./useAppConfig";

vi.mock("../lib/api", () => ({ fetchConfig: vi.fn() }));

const config = {
  window: { from: 1_700_000_000_000, to: 1_700_004_000_000, days: 7 },
} as AppConfig;

beforeEach(() => {
  vi.mocked(api.fetchConfig).mockResolvedValue(config);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("useAppConfig", () => {
  it("loads the application config", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useAppConfig(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.config).toEqual(config));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(api.fetchConfig).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("surfaces config failures and retries them", async () => {
    const error = new Error("config unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchConfig).mockRejectedValue(error);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useAppConfig(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toContain("Failed to load configuration"), {
      timeout: 2_000,
    });
    expect(api.fetchConfig).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith("Failed to load config:", error);

    vi.mocked(api.fetchConfig).mockResolvedValue(config);
    await act(() => result.current.retry());

    await waitFor(() => expect(result.current.config).toEqual(config));
    expect(result.current.error).toBeNull();
    expect(api.fetchConfig).toHaveBeenCalledTimes(4);
  });

  it("recovers from a transient failure automatically", async () => {
    const error = new Error("config unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchConfig).mockRejectedValueOnce(error).mockResolvedValue(config);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useAppConfig(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.config).toEqual(config));

    expect(result.current.error).toBeNull();
    expect(api.fetchConfig).toHaveBeenCalledTimes(2);
  });
});
