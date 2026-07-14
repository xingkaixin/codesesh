import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, DashboardData, ProjectIdentityKind } from "../lib/api";
import * as api from "../lib/api";
import { useProjectDashboard } from "./useProjectDashboard";

vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const appConfig = { window: { from: 1, to: 2 } } as unknown as AppConfig;
const data = { totals: { sessions: 3 }, perAgent: [] } as unknown as DashboardData;
const kind = "path" as ProjectIdentityKind;

beforeEach(() => {
  vi.mocked(api.fetchDashboard).mockResolvedValue(data);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useProjectDashboard", () => {
  it("stays idle without an active project", () => {
    const { result } = renderHook(() => useProjectDashboard(appConfig.window, null, null, null));
    expect(result.current.projectDashboard).toBeNull();
    expect(api.fetchDashboard).not.toHaveBeenCalled();
  });

  it("fetches for the active project", async () => {
    const { result } = renderHook(() =>
      useProjectDashboard(appConfig.window, kind, "pk", "path:pk"),
    );
    await waitFor(() => expect(result.current.projectDashboard).toEqual(data));
    expect(api.fetchDashboard).toHaveBeenCalledWith(appConfig.window, {
      projectKind: "path",
      projectKey: "pk",
      agent: undefined,
    });
  });

  it("resets the agent filter when the project changes", async () => {
    const { result, rerender } = renderHook(
      ({ idKey }) => useProjectDashboard(appConfig.window, kind, "pk", idKey),
      { initialProps: { idKey: "path:pk" } },
    );
    act(() => result.current.setSelectedProjectAgent("cc"));
    expect(result.current.selectedProjectAgent).toBe("cc");

    rerender({ idKey: "path:pk2" });
    await waitFor(() => expect(result.current.selectedProjectAgent).toBeUndefined());
  });
});
