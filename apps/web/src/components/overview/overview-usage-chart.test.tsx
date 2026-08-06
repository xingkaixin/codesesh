import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

function renderChart(overrides: Partial<Parameters<typeof OverviewUsageChart>[0]> = {}) {
  const props = {
    daily,
    metric: "tokens" as const,
    onMetricChange: vi.fn(),
    hoverDayIndex: null,
    onHoverDayChange: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<OverviewUsageChart {...props} />) };
}

afterEach(cleanup);

describe("OverviewUsageChart", () => {
  it("mirrors every bucket in the accessible table", () => {
    renderChart();

    const table = screen.getByRole("table", { name: "Daily usage data" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(daily.length + 1);

    const cells = within(rows[1]!)
      .getAllByRole("cell")
      .map((cell) => cell.textContent);
    expect(cells).toEqual(["01-01", "2", "30", "1,000", "$1.50"]);
  });

  it("drops the token swatches when the metric is not tokens", () => {
    const { rerender } = renderChart();
    expect(screen.getAllByTestId("overview-legend-token")).toHaveLength(4);

    rerender(
      <OverviewUsageChart
        daily={daily}
        metric="sessions"
        onMetricChange={vi.fn()}
        hoverDayIndex={null}
        onHoverDayChange={vi.fn()}
      />,
    );

    expect(screen.queryAllByTestId("overview-legend-token")).toHaveLength(0);
  });

  it("reports the selected metric upwards", () => {
    const { props } = renderChart();

    fireEvent.click(screen.getByRole("radio", { name: "Sessions" }));

    expect(props.onMetricChange).toHaveBeenCalledWith("sessions");
  });

  it("reports the hovered day and renders its tooltip", () => {
    const { props } = renderChart();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "01-02 usage" }));
    expect(props.onHoverDayChange).toHaveBeenCalledWith(1);

    cleanup();
    renderChart({ hoverDayIndex: 1 });
    expect(screen.getByText(/In 10 · Out 20 · Read 30 · Write 40/)).toBeTruthy();
  });

  it("degrades to an empty state without buckets", () => {
    renderChart({ daily: [] });

    expect(screen.getByText("No usage data")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
