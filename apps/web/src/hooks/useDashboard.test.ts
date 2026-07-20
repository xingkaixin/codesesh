import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, DashboardData, ProjectIdentityKind } from "../lib/api";
import * as api from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
import { useDashboard } from "./useDashboard";

vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const window = { from: 1, to: 2 } as AppConfig["window"];
const data = { totals: { sessions: 3 }, perAgent: [] } as unknown as DashboardData;
const projectKind = "path" as ProjectIdentityKind;

beforeEach(() => {
  vi.mocked(api.fetchDashboard).mockResolvedValue(data);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDashboard", () => {
  it("stays idle without a window", () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDashboard(null), { wrapper: Wrapper });
    expect(result.current.dashboard).toBeNull();
    expect(api.fetchDashboard).not.toHaveBeenCalled();
  });

  it("loads an unfiltered dashboard", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDashboard(window), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.dashboard).toEqual(data));
    expect(api.fetchDashboard).toHaveBeenCalledWith(
      window,
      {
        projectKind: undefined,
        projectKey: undefined,
        agent: undefined,
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("loads a project dashboard and refetches for its selected agent", async () => {
    const filters = { projectKind, projectKey: "pk", identityKey: "path:pk" };
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDashboard(window, filters), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.dashboard).toEqual(data));

    act(() => result.current.setSelectedAgent("codex"));

    await waitFor(() =>
      expect(api.fetchDashboard).toHaveBeenLastCalledWith(
        window,
        {
          projectKind: "path",
          projectKey: "pk",
          agent: "codex",
        },
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  it("resets the selected agent when the project changes", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result, rerender } = renderHook(
      ({ identityKey }) => useDashboard(window, { projectKind, projectKey: "pk", identityKey }),
      { initialProps: { identityKey: "path:pk" }, wrapper: Wrapper },
    );
    act(() => result.current.setSelectedAgent("codex"));
    expect(result.current.selectedAgent).toBe("codex");

    rerender({ identityKey: "path:other" });

    await waitFor(() => expect(result.current.selectedAgent).toBeUndefined());
  });

  it("ignores an earlier response after the dashboard scope changes", async () => {
    let resolveFirst!: (value: DashboardData) => void;
    const first = new Promise<DashboardData>((resolve) => {
      resolveFirst = resolve;
    });
    const latest = { totals: { sessions: 9 }, perAgent: [] } as unknown as DashboardData;
    vi.mocked(api.fetchDashboard).mockReturnValueOnce(first).mockResolvedValueOnce(latest);
    const { Wrapper } = createQueryWrapper();
    const { result, rerender } = renderHook(
      ({ projectKey }) =>
        useDashboard(window, { projectKind, projectKey, identityKey: `path:${projectKey}` }),
      { initialProps: { projectKey: "first" }, wrapper: Wrapper },
    );

    rerender({ projectKey: "second" });
    await waitFor(() => expect(result.current.dashboard).toBe(latest));
    resolveFirst(data);
    await first;

    expect(result.current.dashboard).toBe(latest);
    expect(result.current.loading).toBe(false);
  });

  it("surfaces dashboard load failures", async () => {
    const error = new Error("dashboard unavailable");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(error);
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDashboard(window), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBe("Failed to load dashboard"));

    expect(result.current.dashboard).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(console.error).toHaveBeenCalledWith("Failed to load dashboard:", error);
  });
});
