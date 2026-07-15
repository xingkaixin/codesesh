import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppConfig, DashboardData, ProjectIdentityKind } from "../lib/api";
import * as api from "../lib/api";
import { useProjectDashboard } from "./useProjectDashboard";

vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const appConfig = { window: { from: 1, to: 2 } } as unknown as AppConfig;
const data = { totals: { sessions: 3 }, perAgent: [] } as unknown as DashboardData;
const kind = "path" as ProjectIdentityKind;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("exposes load failures and clears the loading state", async () => {
    const error = new Error("offline");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(error);

    const { result } = renderHook(() =>
      useProjectDashboard(appConfig.window, kind, "pk", "path:pk"),
    );

    await waitFor(() =>
      expect(result.current.projectDashboardError).toBe("Failed to load project dashboard"),
    );
    expect(result.current.projectDashboard).toBeNull();
    expect(result.current.projectDashboardLoading).toBe(false);
    expect(console.error).toHaveBeenCalledWith("Failed to load project dashboard:", error);
  });

  it("keeps the latest project response when an earlier request finishes late", async () => {
    const first = deferred<DashboardData>();
    const secondData = { totals: { sessions: 4 }, perAgent: [] } as unknown as DashboardData;
    vi.mocked(api.fetchDashboard)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(secondData);
    const { result, rerender } = renderHook(
      ({ projectKey }) =>
        useProjectDashboard(appConfig.window, kind, projectKey, `path:${projectKey}`),
      { initialProps: { projectKey: "first" } },
    );

    rerender({ projectKey: "second" });
    await waitFor(() => expect(result.current.projectDashboard).toBe(secondData));
    first.resolve(data);
    await first.promise;

    expect(result.current.projectDashboard).toBe(secondData);
    expect(result.current.projectDashboardLoading).toBe(false);
  });

  it("refetches when the selected agent changes", async () => {
    const { result } = renderHook(() =>
      useProjectDashboard(appConfig.window, null, "pk", "path:pk"),
    );
    await waitFor(() => expect(result.current.projectDashboard).toEqual(data));
    vi.mocked(api.fetchDashboard).mockClear();

    act(() => result.current.setSelectedProjectAgent("codex"));

    await waitFor(() =>
      expect(api.fetchDashboard).toHaveBeenCalledWith(appConfig.window, {
        projectKind: undefined,
        projectKey: "pk",
        agent: "codex",
      }),
    );
  });

  it("refreshes the active dashboard and reports refresh failures", async () => {
    const error = new Error("refresh failed");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const refreshed = { totals: { sessions: 9 }, perAgent: [] } as unknown as DashboardData;
    const { result } = renderHook(() =>
      useProjectDashboard(appConfig.window, kind, "pk", "path:pk"),
    );
    await waitFor(() => expect(result.current.projectDashboard).toEqual(data));

    vi.mocked(api.fetchDashboard).mockResolvedValueOnce(refreshed);
    await act(() => result.current.refresh());
    expect(result.current.projectDashboard).toBe(refreshed);

    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(error);
    await act(() => result.current.refresh());
    expect(console.error).toHaveBeenCalledWith("Failed to refresh project dashboard:", error);
  });

  it("does not refresh without both a project and a window", async () => {
    const { result } = renderHook(() => useProjectDashboard(null, kind, "pk", "path:pk"));
    vi.mocked(api.fetchDashboard).mockClear();

    await act(() => result.current.refresh());

    expect(api.fetchDashboard).not.toHaveBeenCalled();
  });
});
