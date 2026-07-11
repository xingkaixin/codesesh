import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { DashboardData } from "../lib/api";
import { Dashboard } from "./Dashboard";

afterEach(cleanup);

const dashboardData: DashboardData = {
  totals: {
    sessions: 3,
    messages: 9,
    tokens: 1_000,
    cost: 0,
    latestActivity: Date.now(),
  },
  perAgent: [],
  dailyActivity: [{ date: "2026-07-11", sessions: 3, messages: 9 }],
  dailyTokenActivity: [
    { date: "2026-07-11", input: 400, output: 300, cache_read: 200, cache_create: 100 },
  ],
  modelDistribution: [{ model: "gpt-test", tokens: 1_000, sessions: 3 }],
  recentSessions: [],
  recentFileActivities: [],
  window: { to: Date.now() },
};

describe("Dashboard charts", () => {
  it("exposes chart data and focus details without hover", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <Dashboard
          data={dashboardData}
          bookmarkedSessions={[]}
          isBookmarked={() => false}
          onToggleBookmark={vi.fn()}
        />
      </MemoryRouter>,
    );

    const activity = screen.getByRole("region", { name: "Daily Activity" });
    expect(within(activity).getByRole("table", { name: "Daily Activity data" })).toBeTruthy();
    fireEvent.focus(
      within(activity).getByRole("button", {
        name: "2026-07-11 · 3 sessions · 9 msgs",
      }),
    );
    expect(within(activity).getByText("2026-07-11 · 3 sessions · 9 msgs")).toBeTruthy();

    const tokens = screen.getByRole("region", { name: "Daily Token Activity" });
    expect(within(tokens).getByRole("table", { name: "Daily Token Activity data" })).toBeTruthy();
    expect(
      within(tokens).getByRole("button", {
        name: /2026-07-11 · 1000 total tokens · 400 input/,
      }),
    ).toBeTruthy();

    const models = screen.getByRole("region", { name: "Model Distribution" });
    expect(within(models).getByText("1.0k · 100.0%"));
  });
});
