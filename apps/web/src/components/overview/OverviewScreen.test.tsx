import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalog } from "../../lib/agents";
import type { AgentInfo, AppConfig, DashboardData } from "../../lib/api";
import * as api from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { OverviewScreen } from "./OverviewScreen";

// oxlint-disable-next-line anti-slop/no-module-mocking -- Control API response ordering and failures while testing client state transitions.
vi.mock("../../lib/api", () => ({ fetchDashboard: vi.fn() }));

const timeWindow = { from: 1, to: 2, days: 7 } as AppConfig["window"];

const agents: AgentInfo[] = [
  {
    name: "codex",
    displayName: "Codex",
    count: 3,
    icon: "/icon/agent/codex.svg",
    resumeCommandPrefix: null,
  },
  {
    name: "claudecode",
    displayName: "Claude Code",
    count: 2,
    icon: "/icon/agent/claudecode.svg",
    resumeCommandPrefix: null,
  },
];

const dashboard = {
  totals: {
    sessions: 5,
    messages: 50,
    tokens: 5000,
    cost: 6,
    costRecorded: 1,
    costEstimated: 5,
    cacheReadTokens: 1000,
  },
  scopeCounts: { projects: 1, agents: 2 },
  perAgent: [
    {
      name: "codex",
      displayName: "Codex",
      icon: "/icon/agent/codex.svg",
      sessions: 3,
      messages: 30,
      tokens: 3000,
      cost: 4,
    },
  ],
  dailyActivity: [
    {
      date: "2026-01-01",
      sessions: 5,
      messages: 50,
      cost: 6,
      input: 1000,
      output: 2000,
      cache_read: 1000,
      cache_create: 1000,
    },
  ],
  modelDistribution: [{ model: "sonnet", tokens: 5000, sessions: 5 }],
  perProject: [
    {
      identityKind: "path",
      identityKey: "/repo/codesesh",
      displayName: "codesesh",
      sessions: 3,
      messages: 30,
      tokens: 3000,
      cost: 4,
      agents: ["codex"],
      sparkline: Array.from({ length: 14 }, () => 0),
    },
  ],
  projectRollup: { projects: 0, sessions: 0, tokens: 0, cost: 0 },
  recentSessions: [],
  recentFileActivities: [],
  activeHours: null,
  modelCost: [{ model: "sonnet", cost: 6, costRecorded: 1, costEstimated: 5 }],
  window: { from: 1, to: 2, days: 7 },
} as DashboardData;

function renderScreen(props: Partial<ComponentProps<typeof OverviewScreen>> = {}) {
  const { Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <MemoryRouter>
        <OverviewScreen
          window={timeWindow}
          agentCatalog={createAgentCatalog(agents)}
          rangePreset="7d"
          {...props}
        />
      </MemoryRouter>
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.mocked(api.fetchDashboard).mockResolvedValue(dashboard);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OverviewScreen", () => {
  it("shows the skeleton until the first response arrives", async () => {
    renderScreen();

    expect(screen.getByTestId("overview-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId("overview-skeleton")).toBeNull());
  });

  it("shows a dashboard failure and retries it in place", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(api.fetchDashboard).mockRejectedValueOnce(new Error("dashboard unavailable"));
    renderScreen();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't load the dashboard.");
    expect(alert.textContent).toContain("dashboard unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByRole("heading", { name: "By agent" });
    expect(api.fetchDashboard).toHaveBeenCalledTimes(2);
  });

  it("renders the full card set for the global scope", async () => {
    renderScreen();

    await screen.findByRole("heading", { name: "By agent" });
    expect(screen.getByTestId("dashboard")).toBeTruthy();
    for (const name of ["Tokens", "API value", "Sessions", "Token composition", "Daily tokens"])
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "By model" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active hours" })).toBeTruthy();
    expect(screen.getByText("Estimated")).toBeTruthy();
    expect(screen.getByText(/2 agents · 1 projects/)).toBeTruthy();
    expect(screen.getAllByTestId("overview-agent-row")).toHaveLength(1);
    expect(screen.getAllByTestId("overview-daily-column")).toHaveLength(1);

    const daily = screen.getByRole("region", { name: "Daily tokens" });
    expect(
      daily.querySelector('[role="listbox"] [role="option"]')?.getAttribute("aria-label"),
    ).toBe("01-01: 5.0k tokens, API value $6.00, 5 sessions");
    fireEvent.click(screen.getByRole("radio", { name: "Excluding cache reads" }));
    expect(
      daily.querySelector('[role="listbox"] [role="option"]')?.getAttribute("aria-label"),
    ).toBe("01-01: 4.0k tokens, API value $6.00, 5 sessions");
  });

  it("issues exactly one new request when the agent filter changes", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "By agent" });
    expect(api.fetchDashboard).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByRole("combobox", { name: "Filter by agent" }), {
      target: { value: "codex" },
    });

    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledTimes(2));
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      timeWindow,
      { project: undefined, agent: "codex" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps the same cards when mounted for a project", async () => {
    renderScreen({ project: { kind: "path", key: "/repo/codesesh" } });

    await screen.findByRole("heading", { name: "By agent" });
    expect(screen.getByRole("heading", { name: "By model" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active hours" })).toBeTruthy();
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      timeWindow,
      { project: { kind: "path", key: "/repo/codesesh" }, agent: undefined },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("hides its own agent picker when the page drives the filter", async () => {
    renderScreen({
      project: { kind: "path", key: "/repo/codesesh" },
      agent: "codex",
      onAgentChange: vi.fn(),
    });

    await screen.findByRole("heading", { name: "By agent" });
    expect(screen.queryByRole("combobox", { name: "Filter by agent" })).toBeNull();
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      timeWindow,
      { project: { kind: "path", key: "/repo/codesesh" }, agent: "codex" },
      { signal: expect.any(AbortSignal) },
    );
  });
});
