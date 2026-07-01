import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, DashboardData } from "../lib/api";
import * as api from "../lib/api";
import { useDashboard } from "./useDashboard";

vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const appConfig = { window: { from: 1, to: 2 } } as unknown as AppConfig;
const data = { totals: { sessions: 5 }, perAgent: [] } as unknown as DashboardData;

beforeEach(() => {
  vi.mocked(api.fetchDashboard).mockResolvedValue(data);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDashboard", () => {
  it("does not fetch until appConfig is available", () => {
    const { result } = renderHook(() => useDashboard(null));
    expect(result.current.dashboard).toBeNull();
    expect(api.fetchDashboard).not.toHaveBeenCalled();
  });

  it("fetches once appConfig is set", async () => {
    const { result } = renderHook(() => useDashboard(appConfig));
    await waitFor(() => expect(result.current.dashboard).toEqual(data));
    expect(api.fetchDashboard).toHaveBeenCalledWith(appConfig.window);
  });

  it("refresh re-fetches the dashboard", async () => {
    const { result } = renderHook(() => useDashboard(appConfig));
    await waitFor(() => expect(result.current.dashboard).toEqual(data));

    const next = { totals: { sessions: 9 }, perAgent: [] } as unknown as DashboardData;
    vi.mocked(api.fetchDashboard).mockResolvedValue(next);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.dashboard).toEqual(next);
  });
});
