import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DashboardDailyBucket } from "../../lib/api";
import { OverviewUsageChart } from "./overview-usage-chart";

const daily: DashboardDailyBucket[] = [
  {
    date: "2026-01-01",
    sessions: 2,
    messages: 30,
    cost: 1.5,
    input: 100,
    output: 200,
    cache_read: 300,
    cache_create: 400,
  },
  {
    date: "2026-01-02",
    sessions: 3,
    messages: 45,
    cost: 2.5,
    input: 10,
    output: 20,
    cache_read: 30,
    cache_create: 40,
  },
];

afterEach(cleanup);

describe("OverviewUsageChart", () => {
  it("mirrors every bucket in the accessible table", () => {
    render(<OverviewUsageChart daily={daily} />);

    const table = screen.getByRole("table", { name: "Daily usage data" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(daily.length + 1);

    const cells = within(rows[1]!)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual(["01-01", "2", "30", "1,000", "$1.50"]);
  });

  it("legends the four token classes and the cost area", () => {
    render(<OverviewUsageChart daily={daily} />);

    expect(screen.getAllByTestId("overview-legend-token")).toHaveLength(4);
    expect(screen.getByText("Daily cost")).toBeTruthy();
    expect(screen.getByText("Peak $2.50 · Avg $2.00 · Total $4.00")).toBeTruthy();
  });

  it("drops the cost area when nothing was spent", () => {
    render(<OverviewUsageChart daily={daily.map((bucket) => ({ ...bucket, cost: 0 }))} />);

    expect(screen.queryByText("Daily cost")).toBeNull();
  });

  it("degrades to an empty state without buckets", () => {
    render(<OverviewUsageChart daily={[]} />);

    expect(screen.getByText("No usage data")).toBeTruthy();
    expect(screen.queryByText("Daily cost")).toBeNull();
  });

  it("moves the tooltip and live summary with the keyboard", () => {
    render(<OverviewUsageChart daily={daily} />);
    const chart = screen.getByRole("listbox", { name: "Daily usage chart" });
    const options = within(chart).getAllByRole("option");
    const liveSummary = screen.getByRole("status");
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1]);

    fireEvent.focus(options[0]!);
    expect(screen.getByText("2 sessions · 30 messages")).toBeTruthy();
    expect(liveSummary.textContent).toContain("01-01: 1.0k tokens");

    fireEvent.keyDown(options[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(options[1]);
    expect(options.map((option) => option.tabIndex)).toEqual([-1, 0]);
    expect(screen.getByText("3 sessions · 45 messages")).toBeTruthy();
    expect(liveSummary.textContent).toContain("01-02: 100 tokens");

    fireEvent.keyDown(options[1]!, { key: "Escape" });
    expect(screen.queryByText("3 sessions · 45 messages")).toBeNull();
    expect(liveSummary.textContent).toBe("");
  });

  it("keeps unrelated daily rows out of hover updates", () => {
    let unrelatedReads = 0;
    const observedDaily = [
      daily[0]!,
      new Proxy(daily[1]!, {
        get(target, property, receiver) {
          if (property === "sessions") unrelatedReads++;
          return Reflect.get(target, property, receiver);
        },
      }),
    ];
    render(<OverviewUsageChart daily={observedDaily} />);
    unrelatedReads = 0;

    fireEvent.focus(
      within(screen.getByRole("listbox", { name: "Daily usage chart" })).getAllByRole("option")[0]!,
    );

    expect(unrelatedReads).toBe(0);
  });
});
