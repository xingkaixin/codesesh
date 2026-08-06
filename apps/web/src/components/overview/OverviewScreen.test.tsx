import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalog } from "../../lib/agents";
import type { AgentInfo, AppConfig, DashboardData } from "../../lib/api";
import * as api from "../../lib/api";
import { createQueryWrapper } from "../../test/query-wrapper";
import { OverviewScreen } from "./OverviewScreen";

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
  modelCost: [{ model: "sonnet", cost: 6, costRecorded: 1, costEstimated: 5 }],
  window: { from: 1, to: 2, days: 7 },
} as unknown as DashboardData;

function renderScreen(props: Partial<ComponentProps<typeof OverviewScreen>> = {}) {
  const { Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <MemoryRouter>
        <OverviewScreen
          window={timeWindow}
          agentCatalog={createAgentCatalog(agents)}
          rangePreset="7d"
          onRangeChange={vi.fn()}
          onSelectCustom={vi.fn()}
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

  it("renders the full card set for the global scope", async () => {
    renderScreen();

    await screen.findByRole("heading", { name: "Projects" });
    expect(screen.getByTestId("dashboard")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Daily usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Cost by Model" })).toBeTruthy();
    expect(screen.getByText("1 projects · 2 agents in scope")).toBeTruthy();
    expect(screen.getAllByTestId("overview-project-row")).toHaveLength(1);
    expect(screen.getAllByTestId("overview-agent-row")).toHaveLength(1);
  });

  it("issues exactly one new request when the agent filter changes", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "Projects" });
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

  it("ranks agents instead of projects when mounted for a project", async () => {
    renderScreen({ project: { kind: "path", key: "/repo/codesesh" } });

    await screen.findByRole("heading", { name: "Agents" });
    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
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

    await screen.findByRole("heading", { name: "Agents" });
    expect(screen.queryByRole("combobox", { name: "Filter by agent" })).toBeNull();
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      timeWindow,
      { project: { kind: "path", key: "/repo/codesesh" }, agent: "codex" },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("opens and applies the shared custom time range", async () => {
    const onSelectCustom = vi.fn();
    renderScreen({ onSelectCustom });

    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    await screen.findByRole("dialog", { name: "Custom time range" });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-07-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-07-14" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply range" }));

    expect(onSelectCustom).toHaveBeenCalledWith("2026-07-01", "2026-07-14");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
