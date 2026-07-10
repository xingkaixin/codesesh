import { describe, expect, it } from "vitest";
import {
  buildDashboard,
  getSessionActivityTime,
  getSessionAgentName,
  getTotalTokens,
  startOfLocalDay,
  toLocalDateKey,
} from "../dashboard.js";
import type { SessionHead } from "../../types/session.js";

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

describe("toLocalDateKey / startOfLocalDay", () => {
  it("toLocalDateKey formats as YYYY-MM-DD", () => {
    const key = toLocalDateKey(new Date("2026-03-05T14:30:00").getTime());
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("startOfLocalDay zeroes the time", () => {
    const ts = new Date("2026-03-05T14:30:00").getTime();
    const start = startOfLocalDay(ts);
    expect(new Date(start).getHours()).toBe(0);
    expect(new Date(start).getMinutes()).toBe(0);
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

  it("buckets token activity including cache split", () => {
    const ts = startOfLocalDay(Date.now());
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
    expect(result.dailyTokenActivity.length).toBeGreaterThan(0);
    const bucket = result.dailyTokenActivity[0]!;
    expect(bucket.cache_read).toBe(20);
    expect(bucket.cache_create).toBe(10);
    // pure input = 100 - 20 - 10 = 70
    expect(bucket.input).toBe(70);
    expect(bucket.output).toBe(50);
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
    expect(result.recentSessions[0]!.id).toBe("s14");
  });

  it("returns empty aggregates for no sessions", () => {
    const result = buildDashboard([], opts());
    expect(result.totals.sessions).toBe(0);
    expect(result.perAgent).toEqual([]);
    expect(result.recentSessions).toEqual([]);
  });
});
