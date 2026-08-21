import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, DashboardData, DashboardFilters } from "../lib/api";
import * as api from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { createQueryWrapper } from "../test/query-wrapper";
import { useDashboard } from "./useDashboard";

vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const window = { from: 1, to: 2 } as AppConfig["window"];
const data = { totals: { sessions: 3 }, perAgent: [] } as unknown as DashboardData;

const globalScope: DashboardFilters = {};
const projectScope: DashboardFilters = { project: { kind: "path", key: "pk" } };
const agentScope: DashboardFilters = { agent: "codex" };

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
    const { result } = renderHook(() => useDashboard(null, globalScope), { wrapper: Wrapper });
    expect(result.current.dashboard).toBeNull();
    expect(api.fetchDashboard).not.toHaveBeenCalled();
  });

  it.each([
    ["global", globalScope],
    ["project", projectScope],
    ["agent", agentScope],
  ])("loads the %s scope", async (_name, scope) => {
    const { Wrapper } = createQueryWrapper();
    const { result } = renderHook(() => useDashboard(window, scope), { wrapper: Wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.dashboard).toBeNull();

    await waitFor(() => expect(result.current.dashboard).toEqual(data));
    expect(result.current.loading).toBe(false);
    expect(api.fetchDashboard).toHaveBeenCalledWith(window, scope, {
      signal: expect.any(AbortSignal),
    });
  });

  it("refetches when the scope changes", async () => {
    const { Wrapper } = createQueryWrapper();
    const { result, rerender } = renderHook<
      ReturnType<typeof useDashboard>,
      { scope: DashboardFilters }
    >(({ scope }) => useDashboard(window, scope), {
      initialProps: { scope: projectScope },
      wrapper: Wrapper,
    });
    await waitFor(() => expect(result.current.dashboard).toEqual(data));

    rerender({ scope: agentScope });

    await waitFor(() =>
      expect(api.fetchDashboard).toHaveBeenLastCalledWith(window, agentScope, {
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("keys each scope separately", () => {
    const keys = [globalScope, projectScope, agentScope].map((scope) =>
      JSON.stringify(queryKeys.dashboard(window, scope)),
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(queryKeys.dashboard(window, globalScope)).toEqual(
      queryKeys.dashboard(window, { project: undefined, agent: undefined }),
    );
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
      ({ projectKey }) => useDashboard(window, { project: { kind: "path", key: projectKey } }),
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
    const { result } = renderHook(() => useDashboard(window, globalScope), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.error).toBe("dashboard unavailable"));

    expect(result.current.dashboard).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.retry).toBeTypeOf("function");
    expect(console.error).toHaveBeenCalledWith("Failed to load dashboard:", error);
  });
});
