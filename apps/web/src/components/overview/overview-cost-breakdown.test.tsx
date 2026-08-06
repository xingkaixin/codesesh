import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardTotals, ModelCostEntry, ModelDistributionEntry } from "../../lib/api";
import { OverviewCostBreakdown } from "./overview-cost-breakdown";

const modelDistribution: ModelDistributionEntry[] = [
  { model: "sonnet", tokens: 30_000, sessions: 4 },
  { model: "haiku", tokens: 10_000, sessions: 2 },
];

function totals(overrides: Partial<DashboardTotals> = {}): DashboardTotals {
  return {
    sessions: 6,
    messages: 60,
    tokens: 40_000,
    cost: 10,
    costRecorded: 4,
    costEstimated: 6,
    cacheReadTokens: 0,
    ...overrides,
  };
}

const modelCost: ModelCostEntry[] = [
  { model: "sonnet", cost: 8, costRecorded: 4, costEstimated: 4 },
  { model: "haiku", cost: 2, costRecorded: 0, costEstimated: 2 },
];

afterEach(cleanup);

describe("OverviewCostBreakdown", () => {
  it("breaks cost down by model when the cache has it", () => {
    render(
      <OverviewCostBreakdown
        modelCost={modelCost}
        modelDistribution={modelDistribution}
        totals={totals()}
      />,
    );

    expect(screen.getByRole("heading", { name: "花费构成" })).toBeTruthy();
    expect(screen.getByText("按模型")).toBeTruthy();
    expect(screen.getByText("$8.00")).toBeTruthy();
    expect(screen.getByText("$2.00")).toBeTruthy();
    expect(screen.getByText(/由模型单价推算/)).toBeTruthy();
    expect(screen.queryByText("其他")).toBeNull();
  });

  it("adds a remainder segment when the cache lags behind the snapshot", () => {
    render(
      <OverviewCostBreakdown
        modelCost={modelCost}
        modelDistribution={modelDistribution}
        totals={totals({ cost: 14 })}
      />,
    );

    expect(screen.getByText("其他")).toBeTruthy();
    expect(screen.getByText("$4.00")).toBeTruthy();
  });

  it.each([
    ["missing", null],
    ["all zero", [{ model: "sonnet", cost: 0, costRecorded: 0, costEstimated: 0 }]],
  ])("falls back to token share when per-model cost is %s", (_name, cost) => {
    render(
      <OverviewCostBreakdown
        modelCost={cost as ModelCostEntry[] | null}
        modelDistribution={modelDistribution}
        totals={totals()}
      />,
    );

    expect(screen.getByRole("heading", { name: "模型构成" })).toBeTruthy();
    expect(screen.getByText("按 Token")).toBeTruthy();
    expect(screen.getByText("30.0k")).toBeTruthy();
    expect(screen.getByText("10.0k")).toBeTruthy();
    expect(
      screen.getByText("按模型的花费需要消息缓存，当前不可用；此处按 Token 占比展示。"),
    ).toBeTruthy();
  });

  it("says so when there is nothing to break down", () => {
    render(<OverviewCostBreakdown modelCost={null} modelDistribution={[]} totals={totals()} />);

    expect(screen.getByText("暂无模型数据")).toBeTruthy();
  });
});
