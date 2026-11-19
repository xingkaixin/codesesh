import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "@codesesh/contract";
import { SAMPLE_DASHBOARD_DATA } from "@codesesh/contract/test-fixtures";
import { createAgentCatalog } from "../../lib/agents";
import { createQueryWrapper } from "../../test/query-wrapper";
import { OverviewScreen } from "./OverviewScreen";

const richDashboard: DashboardData = {
  ...SAMPLE_DASHBOARD_DATA,
  totals: {
    ...SAMPLE_DASHBOARD_DATA.totals,
    sessions: 6,
    tokens: 20_000,
    cost: 0.5,
  },
  perAgent: [
    {
      name: "claudecode",
      displayName: "Claude Code",
      icon: "claude",
      sessions: 4,
      messages: 20,
      tokens: 14_000,
      cost: 0.35,
    },
    {
      name: "codex",
      displayName: "Codex",
      icon: "codex",
      sessions: 2,
      messages: 10,
      tokens: 6_000,
      cost: 0.15,
    },
  ],
  dailyActivity: [
    {
      date: "2026-09-01",
      sessions: 2,
      messages: 10,
      cost: 0.15,
      input: 2_000,
      output: 3_000,
      cache_read: 1_000,
      cache_create: 0,
    },
    {
      date: "2026-09-02",
      sessions: 4,
      messages: 20,
      cost: 0.35,
      input: 4_000,
      output: 6_000,
      cache_read: 4_000,
      cache_create: 0,
    },
  ],
  modelDistribution: [
    { model: "claude-sonnet-4-5", tokens: 12_000, sessions: 4 },
    { model: "gpt-5-codex", tokens: 5_000, sessions: 2 },
  ],
  modelCost: [
    { model: "claude-sonnet-4-5", cost: 0.35, costRecorded: 0.35, costEstimated: 0 },
    { model: "gpt-5-codex", cost: 0.15, costRecorded: 0.15, costEstimated: 0 },
  ],
};

function LocationSearch() {
  const location = useLocation();
  return <span data-testid="location-search">{location.search}</span>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OverviewScreen chart drill-down", () => {
  it("narrows the time window on day click/keyboard, toggles agent filter, and searches models with active scope", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        requestedUrls.push(url);
        return Promise.resolve(
          new Response(JSON.stringify(richDashboard), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );

    const onSelectModel = vi.fn();
    const { Wrapper } = createQueryWrapper();

    render(
      <Wrapper>
        <MemoryRouter initialEntries={["/?range=7d"]}>
          <LocationSearch />
          <OverviewScreen
            window={{ from: 1, to: 2, days: 7 }}
            agentCatalog={createAgentCatalog([
              {
                name: "claudecode",
                displayName: "Claude Code",
                count: 4,
                resumeCommandPrefix: null,
              },
              {
                name: "codex",
                displayName: "Codex",
                count: 2,
                resumeCommandPrefix: null,
              },
            ])}
            rangePreset="7d"
            onSelectModel={onSelectModel}
          />
        </MemoryRouter>
      </Wrapper>,
    );

    const columns = await screen.findAllByTestId("overview-daily-column");
    fireEvent.click(columns[1]!);
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?range=custom&from=2026-09-02&to=2026-09-02",
    );

    // Keyboard activation on the first day option also narrows the range.
    const chartListbox = screen.getByRole("listbox", { name: "Daily tokens chart" });
    const dayOptions = within(chartListbox).getAllByRole("option");
    fireEvent.keyDown(dayOptions[0]!, { key: "Enter" });
    expect(screen.getByTestId("location-search").textContent).toBe(
      "?range=custom&from=2026-09-01&to=2026-09-01",
    );

    // Clicking an agent row filters the dashboard request by that agent; clicking again clears it.
    fireEvent.click(screen.getByRole("button", { name: "Filter by Codex" }));
    const activeCodexButton = await screen.findByRole("button", { name: "Filter by Codex" });
    await waitFor(() =>
      expect(requestedUrls.some((url) => url.includes("agent=codex"))).toBe(true),
    );
    expect(activeCodexButton.getAttribute("aria-pressed")).toBe("true");

    // Clicking a model row forwards the model and active agent scope to search.
    fireEvent.click(
      screen.getByRole("button", { name: "Search sessions using claude-sonnet-4-5" }),
    );
    expect(onSelectModel).toHaveBeenCalledWith("claude-sonnet-4-5", {
      project: undefined,
      agent: "codex",
      sourceNodeId: undefined,
    });

    // Synthetic "Other" model row is not interactive.
    expect(screen.queryByRole("button", { name: /Other/ })).toBeNull();

    // Toggling the active agent row clears the agent filter.
    fireEvent.click(activeCodexButton);
    const clearedCodexButton = await screen.findByRole("button", { name: "Filter by Codex" });
    expect(clearedCodexButton.getAttribute("aria-pressed")).toBe("false");
  });
});
