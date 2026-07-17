import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type {
  BookmarkedSessionSnapshot,
  DashboardData,
  DashboardRecentSession,
  ProjectGroup,
  SessionHead,
} from "../lib/api";
import { createAgentCatalog } from "../lib/agents";
import { Dashboard } from "./Dashboard";

const agentCatalog = createAgentCatalog([
  {
    name: "codex",
    displayName: "Codex",
    icon: "/icon/agent/codex.svg",
    count: 2,
  },
]);

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

function makeSession(id: string): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: `Session ${id}`,
    directory: "/workspace",
    project_identity: { kind: "path", key: "/workspace", displayName: "CodeSesh" },
    time_created: Date.now() - 1_000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

const recentSession: DashboardRecentSession = {
  ...makeSession("recent"),
  display_title: "Recent work",
  agentName: "Codex",
  smart_tags: ["testing"],
};

const bookmarkedSession: BookmarkedSessionSnapshot = {
  agentKey: "codex",
  sessionId: "saved",
  fullPath: "codex/saved",
  title: "Saved work",
  directory: "/workspace",
  time_created: Date.now() - 2_000,
  stats: {
    message_count: 2,
    total_input_tokens: 10,
    total_output_tokens: 20,
    total_cost: 0,
  },
  bookmarked_at: Date.now(),
};

const project: ProjectGroup = {
  identityKind: "path",
  identityKey: "/workspace",
  displayName: "CodeSesh",
  sources: ["/workspace"],
  sessionCount: 2,
  lastActivity: Date.now(),
  messages: 4,
  tokens: 1_500_000,
  cost: 1.25,
  cost_source: "recorded",
  agentStats: [{ name: "codex", sessions: 2, messages: 4, tokens: 1_500_000, cost: 1.25 }],
};

describe("Dashboard charts", () => {
  it("exposes chart data and focus details without hover", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <MemoryRouter>
        <Dashboard
          data={dashboardData}
          agentCatalog={agentCatalog}
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

  it("renders empty dashboard states without optional sections", () => {
    render(
      <MemoryRouter>
        <Dashboard
          data={{
            totals: { sessions: 0, messages: 0, tokens: 0, cost: 0 },
            perAgent: [],
            dailyActivity: [],
            dailyTokenActivity: [],
            modelDistribution: [],
            recentSessions: [],
            recentFileActivities: [],
            window: { to: Date.now() },
          }}
          agentCatalog={agentCatalog}
          bookmarkedSessions={[]}
          isBookmarked={() => false}
          onToggleBookmark={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("No model data yet")).toBeTruthy();
    expect(screen.getByText("No agent data yet")).toBeTruthy();
    expect(screen.getByText("No sessions yet")).toBeTruthy();
    expect(screen.getByText("No file activity yet")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Daily Token Activity" })).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    expect(screen.queryByText("Bookmarked Sessions")).toBeNull();
  });

  it("renders populated dashboard sections and handles chart and bookmark interactions", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onToggleBookmark = vi.fn();
    const data: DashboardData = {
      totals: {
        sessions: 2,
        messages: 4,
        tokens: 1_500_000,
        cost: 1.25,
        cost_source: "estimated",
        latestActivity: Date.now(),
      },
      perAgent: [
        {
          name: "codex",
          displayName: "Codex",
          icon: "/icon/codex.svg",
          sessions: 2,
          messages: 4,
          tokens: 1_500_000,
        },
      ],
      dailyActivity: [
        { date: "2026-07-11", sessions: 0, messages: 0 },
        { date: "2026-07-12", sessions: 2, messages: 4 },
      ],
      dailyTokenActivity: [
        { date: "2026-07-11", input: 0, output: 0, cache_read: 0, cache_create: 0 },
        {
          date: "2026-07-12",
          input: 1_000_000,
          output: 500_000,
          cache_read: 0,
          cache_create: 0,
        },
      ],
      modelDistribution: [
        { model: "unused", tokens: 0, sessions: 0 },
        { model: "gpt-test", tokens: 1_500_000, sessions: 2 },
      ],
      recentSessions: [recentSession],
      recentFileActivities: [
        {
          agent_name: "codex",
          session_id: "recent",
          project_identity_key: "path:/workspace",
          path: "src/index.ts",
          kind: "edit",
          count: 3,
          latest_time: Date.now(),
          session: recentSession,
        },
      ],
      window: { to: Date.now(), days: 7 },
    };

    render(
      <MemoryRouter>
        <Dashboard
          data={data}
          agentCatalog={agentCatalog}
          projects={[project]}
          bookmarkedSessions={[bookmarkedSession]}
          isBookmarked={() => true}
          onToggleBookmark={onToggleBookmark}
        />
      </MemoryRouter>,
    );

    expect(screen.getAllByText("1.5M").length).toBeGreaterThan(0);
    expect(
      screen
        .getAllByRole("link")
        .some((link) => link.getAttribute("href") === "/projects/path/%2Fworkspace"),
    ).toBe(true);
    expect(screen.getByText("Recent work")).toBeTruthy();
    expect(screen.getByText("src/index.ts")).toBeTruthy();
    expect(screen.getByText("Saved work")).toBeTruthy();

    const activity = screen.getByRole("region", { name: "Daily Activity" });
    const activityButton = within(activity).getByRole("button", {
      name: "2026-07-12 · 2 sessions · 4 msgs",
    });
    fireEvent.pointerEnter(activityButton);
    expect(within(activity).getByText("2026-07-12 · 2 sessions · 4 msgs")).toBeTruthy();
    fireEvent.pointerLeave(activityButton.parentElement!);
    fireEvent.click(activityButton);
    fireEvent.blur(activityButton);

    const tokens = screen.getByRole("region", { name: "Daily Token Activity" });
    const tokenButton = within(tokens).getByRole("button", {
      name: /2026-07-12 · 1500000 total tokens/,
    });
    fireEvent.pointerEnter(tokenButton);
    expect(within(tokens).getByText("2026-07-12 · 1.5M total")).toBeTruthy();
    expect(within(tokens).getByText("Input: 1.0M")).toBeTruthy();
    fireEvent.pointerLeave(tokenButton.parentElement!);
    fireEvent.click(tokenButton);
    fireEvent.blur(tokenButton);

    const bookmarkButtons = screen.getAllByRole("button", { name: "Remove bookmark" });
    fireEvent.click(bookmarkButtons[0]!);
    fireEvent.click(bookmarkButtons[1]!);
    expect(onToggleBookmark).toHaveBeenNthCalledWith(1, recentSession, "codex");
    expect(onToggleBookmark).toHaveBeenNthCalledWith(2, bookmarkedSession);
  });
});
