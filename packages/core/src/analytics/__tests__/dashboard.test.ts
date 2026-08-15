import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDashboard,
  DASHBOARD_PROJECT_LIMIT,
  getSessionActivityTime,
  getSessionAgentName,
  getTotalTokens,
  PROJECT_SPARKLINE_DAYS,
} from "../dashboard.js";
import {
  addCalendarDays,
  startOfCalendarDay,
  toCalendarDayKey,
} from "../../contract/calendar-day.js";
import type { SessionHead } from "../../types/session.js";
import type { DashboardCostFacts } from "../cost-facts.js";

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  const timeCreated = overrides?.time_created ?? 1_000_000_000_000;
  return {
    id,
    slug: `claudecode/${id}`,
    title: id,
    directory: "/home/user/project",
    time_created: timeCreated,
    time_updated: overrides?.time_updated ?? timeCreated,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function opts(overrides?: Partial<Parameters<typeof buildDashboard>[1]>) {
  return {
    byAgentNames: ["claudecode"],
    scope: {},
    to: Date.now() + 86400000,
    ...overrides,
  };
}

describe("getTotalTokens / getSessionAgentName / getSessionActivityTime", () => {
  it("getTotalTokens prefers total_tokens when present", () => {
    expect(
      getTotalTokens({
        message_count: 1,
        total_cost: 0,
        total_tokens: 99,
        total_input_tokens: 1,
        total_output_tokens: 2,
      }),
    ).toBe(99);
  });

  it("getTotalTokens falls back to input + output", () => {
    expect(
      getTotalTokens({
        message_count: 1,
        total_cost: 0,
        total_input_tokens: 10,
        total_output_tokens: 5,
      }),
    ).toBe(15);
  });

  it("getSessionAgentName extracts agent from slug", () => {
    expect(getSessionAgentName(makeSession("a", { slug: "codex/abc" }))).toBe("codex");
    expect(getSessionAgentName({ ...makeSession("x"), slug: "" })).toBe("unknown");
  });

  it("getSessionActivityTime prefers time_updated", () => {
    expect(getSessionActivityTime(makeSession("a", { time_created: 100, time_updated: 200 }))).toBe(
      200,
    );
    expect(getSessionActivityTime(makeSession("a", { time_created: 100 }))).toBe(100);
  });
});

describe("buildDashboard", () => {
  it("aggregates totals across sessions", () => {
    const result = buildDashboard(
      [
        makeSession("a", {
          stats: {
            message_count: 3,
            total_input_tokens: 10,
            total_output_tokens: 5,
            total_cost: 0.1,
          },
        }),
        makeSession("b", {
          stats: {
            message_count: 2,
            total_input_tokens: 4,
            total_output_tokens: 1,
            total_cost: 0.05,
            total_tokens: 12,
          },
        }),
      ],
      opts(),
    );
    expect(result.totals.sessions).toBe(2);
    expect(result.totals.messages).toBe(5);
    expect(result.totals.tokens).toBe(27);
    expect(result.totals.cost).toBeCloseTo(0.15);
    expect(result.totals.cost_source).toBe("recorded");
  });

  it("marks cost as estimated when any session uses estimated cost", () => {
    const result = buildDashboard(
      [
        makeSession("a", {
          stats: {
            message_count: 1,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 0.1,
          },
        }),
        makeSession("b", {
          stats: {
            message_count: 1,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 0.2,
            cost_source: "estimated",
          },
        }),
      ],
      opts(),
    );
    expect(result.totals.cost_source).toBe("estimated");
  });

  it("tracks latest activity time", () => {
    const result = buildDashboard(
      [
        makeSession("a", { time_created: 1000, time_updated: 1000 }),
        makeSession("b", { time_created: 500, time_updated: 5000 }),
      ],
      opts(),
    );
    expect(result.totals.latestActivity).toBe(5000);
  });

  it("aggregates per-agent metrics", () => {
    const result = buildDashboard(
      [
        makeSession("a", {
          slug: "claudecode/a",
          stats: { message_count: 2, total_input_tokens: 5, total_output_tokens: 5, total_cost: 0 },
        }),
        makeSession("b", {
          slug: "claudecode/b",
          stats: { message_count: 1, total_input_tokens: 3, total_output_tokens: 2, total_cost: 0 },
        }),
      ],
      opts({ byAgentNames: ["claudecode"] }),
    );
    expect(result.perAgent).toHaveLength(1);
    expect(result.perAgent[0]).toMatchObject({ name: "claudecode", sessions: 2, messages: 3 });
  });

  it("filters by scope.agent", () => {
    const result = buildDashboard(
      [makeSession("a", { slug: "claudecode/a" }), makeSession("b", { slug: "codex/b" })],
      opts({ byAgentNames: ["claudecode", "codex"], scope: { agent: "codex" } }),
    );
    expect(result.totals.sessions).toBe(1);
    expect(result.perAgent.map((p) => p.name)).toEqual(["codex"]);
  });

  it("filters by complete project identity", () => {
    const result = buildDashboard(
      [
        makeSession("a", {
          project_identity: { kind: "git_remote", key: "proj-a", displayName: "A" },
        }),
        makeSession("b", {
          project_identity: { kind: "git_remote", key: "proj-b", displayName: "B" },
        }),
        makeSession("same-key-path", {
          project_identity: { kind: "path", key: "proj-a", displayName: "A path" },
        }),
      ],
      opts({ scope: { projectKind: "git_remote", projectKey: "proj-a" } }),
    );
    expect(result.totals.sessions).toBe(1);
  });

  it("applies time window (from/to)", () => {
    const result = buildDashboard(
      [
        makeSession("old", { time_created: 1000, time_updated: 1000 }),
        makeSession("new", { time_created: 9000, time_updated: 9000 }),
      ],
      opts({ from: 5000, to: 10000 }),
    );
    expect(result.totals.sessions).toBe(1);
  });

  it("attributes reconciled message costs to their message days", () => {
    const day1 = startOfCalendarDay(Date.now());
    const day2 = addCalendarDays(day1, 1);
    const day3 = addCalendarDays(day1, 2);
    const session = makeSession("long-lived", {
      time_created: day1,
      time_updated: day3,
      stats: {
        message_count: 3,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 6,
        cost_source: "estimated",
      },
    });
    const costFacts: DashboardCostFacts = {
      sessions: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          messageCost: 6,
          untimedMessageCost: 0,
          modelCosts: [{ model: "sonnet", cost: 6, costRecorded: 0 }],
        },
      ],
      messages: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: day1 + 1_000,
          model: "sonnet",
          cost: 1,
          costSource: "estimated",
        },
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: day2 + 1_000,
          model: "sonnet",
          cost: 2,
          costSource: "estimated",
        },
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: day3 + 1_000,
          model: "sonnet",
          cost: 3,
          costSource: "estimated",
        },
      ],
    };

    const result = buildDashboard([session], opts({ from: day2, to: day3 - 1, costFacts }));

    expect(result.totals).toMatchObject({ sessions: 0, cost: 2, costEstimated: 2 });
    expect(result.dailyActivity).toEqual([
      {
        date: toCalendarDayKey(day2),
        sessions: 0,
        messages: 0,
        cost: 2,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_create: 0,
      },
    ]);
    expect(result.perAgent[0]).toMatchObject({ name: "claudecode", sessions: 0, cost: 2 });
    expect(result.modelCost).toEqual([
      { model: "sonnet", cost: 2, costRecorded: 0, costEstimated: 2 },
    ]);
  });

  it("keeps the whole session cost on its activity day when details cannot be segmented", () => {
    const day1 = startOfCalendarDay(Date.now());
    const day2 = addCalendarDays(day1, 1);
    const session = makeSession("untimed", {
      time_created: day1,
      time_updated: day2,
      stats: {
        message_count: 2,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 6,
        cost_source: "estimated",
      },
    });
    const costFacts: DashboardCostFacts = {
      sessions: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          messageCost: 6,
          untimedMessageCost: 3,
          modelCosts: [{ model: "sonnet", cost: 6, costRecorded: 0 }],
        },
      ],
      messages: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: day1 + 1_000,
          model: "sonnet",
          cost: 3,
          costSource: "estimated",
        },
      ],
    };

    const beforeActivity = buildDashboard([session], opts({ from: day1, to: day2 - 1, costFacts }));
    const onActivity = buildDashboard(
      [session],
      opts({ from: day2, to: addCalendarDays(day2, 1) - 1, costFacts }),
    );

    expect(beforeActivity.totals.cost).toBe(0);
    expect(onActivity.totals.cost).toBe(6);
    expect(onActivity.modelCost).toEqual([
      { model: "sonnet", cost: 6, costRecorded: 0, costEstimated: 6 },
    ]);
  });

  it("keeps session-level-only cost on the session activity day", () => {
    const session = makeSession("summary-only", {
      time_created: 100,
      time_updated: 200,
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 4,
        cost_source: "recorded",
      },
    });

    const result = buildDashboard(
      [session],
      opts({ from: 150, to: 250, costFacts: { sessions: [], messages: [] } }),
    );

    expect(result.totals).toMatchObject({ cost: 4, costRecorded: 4, costEstimated: 0 });
    expect(result.modelCost).toEqual([]);
  });

  it("rolls child stats into the parent entry without counting it as a session", () => {
    const result = buildDashboard(
      [
        makeSession("parent", {
          time_created: 1000,
          time_updated: 1000,
          stats: {
            message_count: 1,
            total_input_tokens: 50,
            total_output_tokens: 0,
            total_cost: 0.1,
          },
        }),
        makeSession("child", {
          time_created: 1,
          time_updated: 1,
          parent_reference: { agentName: "claudecode", sessionId: "parent" },
          stats: {
            message_count: 3,
            total_input_tokens: 20,
            total_output_tokens: 0,
            total_cost: 0.2,
          },
        }),
      ],
      opts({ from: 900, to: 1100 }),
    );

    expect(result.totals).toMatchObject({ sessions: 1, messages: 4, tokens: 70 });
    expect(result.totals.cost).toBeCloseTo(0.3);
  });

  it("counts an orphaned sub-session as a top-level entry", () => {
    const result = buildDashboard(
      [
        makeSession("root", { time_created: 1000, time_updated: 1000 }),
        makeSession("orphan", {
          time_created: 1000,
          time_updated: 1000,
          parent_reference: { agentName: "claudecode", sessionId: "missing" },
        }),
      ],
      opts({ from: 900, to: 1100 }),
    );

    expect(result.totals).toMatchObject({ sessions: 2, messages: 2 });
  });

  it("splits cost into recorded and estimated buckets that sum to the total", () => {
    const result = buildDashboard(
      [
        makeSession("recorded", {
          stats: {
            message_count: 1,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 1,
            cost_source: "recorded",
          },
        }),
        makeSession("estimated", {
          stats: {
            message_count: 1,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 3,
            cost_source: "estimated",
          },
        }),
      ],
      opts(),
    );

    expect(result.totals.costRecorded).toBeCloseTo(1);
    expect(result.totals.costEstimated).toBeCloseTo(3);
    expect(result.totals.costRecorded + result.totals.costEstimated).toBeCloseTo(
      result.totals.cost,
    );
  });

  it("sums cache reads and reports the latest entry's project and agent", () => {
    const result = buildDashboard(
      [
        makeSession("old", { time_created: 1000, time_updated: 1000 }),
        makeSession("latest", {
          slug: "codex/latest",
          time_created: 5000,
          time_updated: 5000,
          project_identity: { kind: "git_remote", key: "repo-a", displayName: "Repo A" },
          stats: {
            message_count: 1,
            total_input_tokens: 100,
            total_output_tokens: 0,
            total_cache_read_tokens: 40,
            total_cost: 0,
          },
        }),
      ],
      opts({ byAgentNames: ["claudecode", "codex"] }),
    );

    expect(result.totals.cacheReadTokens).toBe(40);
    expect(result.totals.latestActivityProject).toBe("Repo A");
    expect(result.totals.latestActivityAgent).toBe("codex");
    expect(result.scopeCounts).toEqual({ projects: 1, agents: 2 });
  });

  it("buckets token activity including cache split", () => {
    const ts = startOfCalendarDay(Date.now());
    const result = buildDashboard(
      [
        makeSession("a", {
          time_created: ts,
          time_updated: ts,
          stats: {
            message_count: 1,
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cache_read_tokens: 20,
            total_cache_create_tokens: 10,
            total_cost: 0,
          },
        }),
      ],
      opts({ from: ts, to: ts + 86400000 }),
    );
    expect(result.dailyActivity.length).toBeGreaterThan(0);
    expect(result.dailyActivity[0]).toMatchObject({
      sessions: 1,
      messages: 1,
      cost: 0,
      // pure input = 100 - 20 - 10 = 70
      input: 70,
      output: 50,
      cache_read: 20,
      cache_create: 10,
    });
  });

  it("aggregates model distribution sorted by tokens desc", () => {
    const result = buildDashboard(
      [
        makeSession("a", { model_usage: { "gpt-4": 100, "gpt-3.5": 50 } }),
        makeSession("b", { model_usage: { "gpt-4": 200 } }),
      ],
      opts(),
    );
    expect(result.modelDistribution[0]).toMatchObject({ model: "gpt-4", tokens: 300, sessions: 2 });
    expect(result.modelDistribution[1]).toMatchObject({
      model: "gpt-3.5",
      tokens: 50,
      sessions: 1,
    });
  });

  it("keeps the ten most recent sessions", () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      makeSession(`s${i}`, { time_created: 1000 + i, time_updated: 1000 + i }),
    );
    const result = buildDashboard(sessions, opts());
    expect(result.recentSessions).toHaveLength(10);
    // Most recent first (activity desc).
    expect(result.recentSessions[0]!.reference.sessionId).toBe("s14");
  });

  it("returns empty aggregates for no sessions", () => {
    const result = buildDashboard([], opts());
    expect(result.totals.sessions).toBe(0);
    expect(result.perAgent).toEqual([]);
    expect(result.recentSessions).toEqual([]);
  });
});

describe("buildDashboard project ranking", () => {
  const to = startOfCalendarDay(Date.now()) + 12 * 3_600_000;

  function projectSession(id: string, key: string, cost: number, activity: number): SessionHead {
    return makeSession(id, {
      time_created: activity,
      time_updated: activity,
      project_identity: { kind: "git_remote", key, displayName: key },
      stats: {
        message_count: 1,
        total_input_tokens: 10,
        total_output_tokens: 0,
        total_cost: cost,
      },
    });
  }

  it("ranks projects by cost and rolls the tail beyond the limit up", () => {
    const sessions = Array.from({ length: DASHBOARD_PROJECT_LIMIT + 2 }, (_, i) =>
      projectSession(`s${i}`, `repo-${i}`, i + 1, to),
    );
    const result = buildDashboard(sessions, opts({ from: addCalendarDays(to, -13), to }));

    expect(result.perProject).toHaveLength(DASHBOARD_PROJECT_LIMIT);
    expect(result.perProject[0]!.identityKey).toBe(`repo-${DASHBOARD_PROJECT_LIMIT + 1}`);
    const costs = result.perProject.map((project) => project.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    expect(result.scopeCounts.projects).toBe(DASHBOARD_PROJECT_LIMIT + 2);

    const ranked = result.perProject.reduce((sum, project) => sum + project.cost, 0);
    expect(result.projectRollup.projects).toBe(2);
    expect(result.projectRollup.sessions).toBe(2);
    expect(result.projectRollup.cost).toBeCloseTo(result.totals.cost - ranked);
  });

  it("aligns the sparkline to the last calendar day of the window", () => {
    const result = buildDashboard(
      [
        projectSession("today", "repo-a", 2, to),
        projectSession("recent", "repo-a", 5, addCalendarDays(to, -3) + 3_600_000),
        projectSession("older", "repo-a", 9, addCalendarDays(to, -20)),
      ],
      opts({ from: addCalendarDays(to, -30), to }),
    );

    const project = result.perProject[0]!;
    expect(project.sparkline).toHaveLength(PROJECT_SPARKLINE_DAYS);
    expect(project.sparkline[PROJECT_SPARKLINE_DAYS - 1]).toBeCloseTo(2);
    expect(project.sparkline[PROJECT_SPARKLINE_DAYS - 4]).toBeCloseTo(5);
    expect(project.sparkline.filter((value) => value > 0)).toHaveLength(2);
    expect(project.cost).toBeCloseTo(16);
  });

  it("lists a project's agents by session count desc", () => {
    const result = buildDashboard(
      [
        { ...projectSession("a", "repo-a", 0, to), slug: "codex/a" },
        { ...projectSession("b", "repo-a", 0, to), slug: "claudecode/b" },
        { ...projectSession("c", "repo-a", 0, to), slug: "claudecode/c" },
      ],
      opts({ byAgentNames: ["claudecode", "codex"], to }),
    );

    expect(result.perProject[0]!.agents).toEqual(["claudecode", "codex"]);
  });
});

describe("buildDashboard compare window", () => {
  it("reports previous totals over the compare window", () => {
    const result = buildDashboard(
      [
        makeSession("now", {
          time_created: 6000,
          time_updated: 6000,
          stats: {
            message_count: 2,
            total_input_tokens: 10,
            total_output_tokens: 0,
            total_cost: 0.5,
          },
        }),
        makeSession("before", {
          time_created: 2000,
          time_updated: 2000,
          stats: {
            message_count: 5,
            total_input_tokens: 4,
            total_output_tokens: 1,
            total_cost: 0.25,
          },
        }),
      ],
      opts({ from: 5000, to: 10000, compare: { from: 0, to: 4999 } }),
    );

    expect(result.totals).toMatchObject({ sessions: 1, messages: 2 });
    expect(result.totals.previous).toEqual({ sessions: 1, messages: 5, tokens: 5, cost: 0.25 });
  });

  it("attributes current and previous costs from the same message facts", () => {
    const session = makeSession("long-lived", {
      time_created: 100,
      time_updated: 250,
      stats: {
        message_count: 2,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 3,
        cost_source: "estimated",
      },
    });
    const costFacts: DashboardCostFacts = {
      sessions: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          messageCost: 3,
          untimedMessageCost: 0,
          modelCosts: [],
        },
      ],
      messages: [
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: 150,
          cost: 1,
          costSource: "estimated",
        },
        {
          reference: { agentName: "claudecode", sessionId: session.id },
          time: 250,
          cost: 2,
          costSource: "estimated",
        },
      ],
    };

    const result = buildDashboard(
      [session],
      opts({ from: 200, to: 299, compare: { from: 100, to: 199 }, costFacts }),
    );

    expect(result.totals.cost).toBe(2);
    expect(result.totals.previous?.cost).toBe(1);
  });

  it("omits previous totals when no compare window is given", () => {
    const result = buildDashboard([makeSession("a")], opts());
    expect(result.totals.previous).toBeUndefined();
  });
});

describe("CS-133: dashboard buckets across DST transitions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { name: "spring forward", from: [2026, 2, 7], to: [2026, 2, 9], days: 3 },
    { name: "fall back", from: [2026, 9, 31], to: [2026, 10, 2], days: 3 },
  ])("emits one bucket per local day for $name", ({ from, to, days }) => {
    vi.stubEnv("TZ", "America/New_York");
    const windowFrom = new Date(from[0]!, from[1]!, from[2]!).getTime();
    const windowTo = new Date(to[0]!, to[1]!, to[2]!, 23, 59, 59, 999).getTime();

    const result = buildDashboard([], opts({ from: windowFrom, to: windowTo }));
    const dates = result.dailyActivity.map((bucket) => bucket.date);

    expect(dates).toHaveLength(days);
    expect(new Set(dates).size).toBe(days);
    expect(dates).toEqual([...dates].sort());
  });
});
