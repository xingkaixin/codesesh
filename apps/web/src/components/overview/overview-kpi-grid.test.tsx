import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardTotals } from "../../lib/api";
import { OverviewKpiGrid } from "./overview-kpi-grid";

function totals(overrides: Partial<DashboardTotals> = {}): DashboardTotals {
  return {
    sessions: 20,
    messages: 400,
    tokens: 1_000_000,
    cost: 12,
    costRecorded: 4,
    costEstimated: 8,
    cacheReadTokens: 250_000,
    ...overrides,
  };
}

afterEach(cleanup);

describe("OverviewKpiGrid", () => {
  it("renders the five headline numbers", () => {
    render(<OverviewKpiGrid totals={totals()} rangeDays={10} />);

    expect(screen.getByText("20")).toBeTruthy();
    expect(screen.getByText("400")).toBeTruthy();
    expect(screen.getByText("1.0M")).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();
    expect(screen.getByText("Cache 命中 25%")).toBeTruthy();
    expect(screen.getByText("日均 2.0")).toBeTruthy();
    expect(screen.getByText("均 20.0 / 会话")).toBeTruthy();
  });

  it("omits every trend when there is no previous period", () => {
    render(<OverviewKpiGrid totals={totals()} rangeDays={10} />);

    expect(screen.queryAllByTestId("overview-kpi-trend")).toHaveLength(0);
  });

  it("omits a trend whose baseline is zero but keeps the comparable ones", () => {
    render(
      <OverviewKpiGrid
        totals={totals({
          previous: { sessions: 10, messages: 0, tokens: 500_000, cost: 6 },
        })}
        rangeDays={10}
      />,
    );

    const trends = screen.getAllByTestId("overview-kpi-trend");
    expect(trends.map((node) => node.textContent)).toEqual(["▲ 100%", "▲ 100%", "▲ 100%"]);
  });

  it("omits the daily average when the range is unbounded", () => {
    render(<OverviewKpiGrid totals={totals()} />);

    expect(screen.queryByText(/日均/)).toBeNull();
  });

  it("omits the per-session average when there are no sessions", () => {
    render(<OverviewKpiGrid totals={totals({ sessions: 0, messages: 0 })} rangeDays={10} />);

    expect(screen.queryByText(/\/ 会话/)).toBeNull();
  });

  it("reports no activity without a latest timestamp", () => {
    render(
      <OverviewKpiGrid
        totals={totals({ latestActivityProject: "codesesh", latestActivityAgent: "codex" })}
        rangeDays={10}
      />,
    );

    expect(screen.getByText("暂无活动")).toBeTruthy();
    expect(screen.queryByText(/codesesh/)).toBeNull();
  });

  it("names the latest activity project and agent", () => {
    render(
      <OverviewKpiGrid
        totals={totals({
          latestActivity: Date.now(),
          latestActivityProject: "codesesh",
          latestActivityAgent: "codex",
        })}
        rangeDays={10}
      />,
    );

    expect(screen.getByText("刚刚")).toBeTruthy();
    expect(screen.getByText("codesesh · codex")).toBeTruthy();
  });

  it.each([
    [{ costEstimated: 0, costRecorded: 12 }, "全部来自 agent 记录"],
    [{ costEstimated: 12, costRecorded: 0 }, "全部为单价估算"],
    [{ costEstimated: 8, costRecorded: 4 }, "含 $8.00 估算"],
  ])("describes the cost split as %o", (split, hint) => {
    render(<OverviewKpiGrid totals={totals(split)} rangeDays={10} />);

    expect(screen.getByText(hint)).toBeTruthy();
  });
});
