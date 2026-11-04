import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, DashboardData } from "@codesesh/contract";
import * as api from "../lib/api";
import { createQueryWrapper } from "../test/query-wrapper";
import { useDashboard } from "./useDashboard";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../lib/api", () => ({ fetchDashboard: vi.fn() }));

const window = { from: 1, to: 2 } as AppConfig["window"];
// oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Only response identity and the session count are observed in these query lifecycle tests.
const data = { totals: { sessions: 3 }, perAgent: [] } as unknown as DashboardData;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useDashboard", () => {
  it("ignores an earlier response after the dashboard scope changes", async () => {
    let resolveFirst!: (value: DashboardData) => void;
    const first = new Promise<DashboardData>((resolve) => {
      resolveFirst = resolve;
    });
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: Only response identity and the session count are observed in these query lifecycle tests.
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
});
