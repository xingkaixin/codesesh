import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

    expect(screen.getByRole("heading", { name: "Cost by Model" })).toBeTruthy();
    expect(screen.getByText("by cost")).toBeTruthy();
    expect(screen.getByText("$8.00")).toBeTruthy();
    expect(screen.getByText("$2.00")).toBeTruthy();
    expect(screen.getByText(/from model unit price/)).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
    expect(screen.getByText("total cost")).toBeTruthy();
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Cost by Model" })).toBeTruthy();
  });

  it("browses model slices and announces their values from the keyboard", () => {
    render(
      <OverviewCostBreakdown
        modelCost={modelCost}
        modelDistribution={modelDistribution}
        totals={totals()}
      />,
    );
    const chart = screen.getByRole("listbox", { name: "Cost by Model chart" });
    const options = within(chart).getAllByRole("option");
    const liveSummary = screen.getByRole("status");

    fireEvent.focus(options[0]!);
    expect(liveSummary.textContent).toBe("sonnet: 80%, $8.00");

    fireEvent.keyDown(options[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[1]);
    expect(liveSummary.textContent).toBe("haiku: 20%, $2.00");
  });

  it("collapses a four-figure total so it fits the ring", () => {
    render(
      <OverviewCostBreakdown
        modelCost={[
          { model: "sonnet", cost: 12_878.91, costRecorded: 0, costEstimated: 12_878.91 },
        ]}
        modelDistribution={modelDistribution}
        totals={totals({ cost: 12_878.91 })}
      />,
    );

    expect(screen.getAllByText("$12.88k")).toHaveLength(2);
    expect(screen.queryByText("$12,878.91")).toBeNull();
  });

  it("adds a remainder segment when the cache lags behind the snapshot", () => {
    render(
      <OverviewCostBreakdown
        modelCost={modelCost}
        modelDistribution={modelDistribution}
        totals={totals({ cost: 14 })}
      />,
    );

    expect(screen.getByText("Other")).toBeTruthy();
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

    expect(screen.getByRole("heading", { name: "Models" })).toBeTruthy();
    expect(screen.getByText("by tokens")).toBeTruthy();
    expect(screen.getByText("30.0k")).toBeTruthy();
    expect(screen.getByText("10.0k")).toBeTruthy();
    expect(
      screen.getByText(
        "Per-model cost needs the message cache, which is unavailable here; showing token share instead.",
      ),
    ).toBeTruthy();
  });

  it("says so when there is nothing to break down", () => {
    render(<OverviewCostBreakdown modelCost={null} modelDistribution={[]} totals={totals()} />);

    expect(screen.getByText("No model data")).toBeTruthy();
  });
});
