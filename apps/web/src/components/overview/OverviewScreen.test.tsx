import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentCatalog } from "../../lib/agents";
import type { AgentInfo, ApiProjectGroup, AppConfig, DashboardData } from "../../lib/api";
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

const projects: ApiProjectGroup[] = [
  {
    identityKind: "path",
    identityKey: "/repo/codesesh",
    displayName: "codesesh",
    sources: ["codex"],
    sessionCount: 3,
    lastActivity: 2,
    messages: 30,
    tokens: 3000,
    cost: 3,
    agentStats: [],
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
  dailyTokenActivity: [],
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

function renderScreen() {
  const { Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <MemoryRouter>
        <OverviewScreen
          scope={{ kind: "global" }}
          window={timeWindow}
          projects={projects}
          agentCatalog={createAgentCatalog(agents)}
          rangePreset="7d"
          onRangeChange={vi.fn()}
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

    await screen.findByRole("heading", { name: "项目排行" });
    expect(screen.getByTestId("dashboard")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "按天用量" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Agent 分布" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "花费构成" })).toBeTruthy();
    expect(screen.getByText("范围内 1 项目 · 2 agent")).toBeTruthy();
    expect(screen.getAllByTestId("overview-project-row")).toHaveLength(1);
    expect(screen.getAllByTestId("overview-agent-row")).toHaveLength(1);
  });

  it("issues exactly one new request when the scope switches to an agent", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "项目排行" });
    expect(api.fetchDashboard).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("radio", { name: "按 Agent" }));

    await waitFor(() => expect(api.fetchDashboard).toHaveBeenCalledTimes(2));
    expect(api.fetchDashboard).toHaveBeenLastCalledWith(
      timeWindow,
      { kind: "agent", agentKey: "codex" },
      { signal: expect.any(AbortSignal) },
    );
    await screen.findByRole("heading", { name: "项目排行" });
    expect(screen.getByRole("heading", { name: "Agent 分布" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "按天用量" })).toBeTruthy();
  });

  it("ranks agents instead of projects inside a project scope", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "项目排行" });

    fireEvent.click(screen.getByRole("radio", { name: "按项目" }));

    await screen.findByRole("heading", { name: "Agent 排行" });
    expect(screen.getByRole("combobox", { name: "选择项目" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "项目排行" })).toBeNull();
  });
});
