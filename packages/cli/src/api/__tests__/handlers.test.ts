import { describe, it, expect, vi } from "vitest";
import {
  handleGetAgents,
  handleGetConfig,
  handleGetDashboard,
  handleGetSessions,
  handleGetSessionData,
  type ScanResultSource,
} from "../handlers.js";
import type { ScanResult, SessionHead, SessionData } from "@codesesh/core";
import { BaseAgent } from "@codesesh/core";

// --- Helpers ---

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    time_created: Date.now(),
    time_updated: Date.now(),
    directory: "/home/user/project",
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function makeMockContext(
  overrides: {
    query?: Record<string, string>;
    param?: Record<string, string>;
  } = {},
) {
  const jsonFn = vi.fn().mockReturnValue({ status: 200 });
  return {
    req: {
      query: (key: string) => overrides.query?.[key] ?? "",
      param: (key: string) => overrides.param?.[key] ?? "",
    },
    json: jsonFn,
  } as any;
}

class MockAgent extends BaseAgent {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";

  isAvailable() {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(_sessionId: string): SessionData {
    return {
      id: "s1",
      slug: "claudecode/s1",
      title: "Test Session",
      time_created: 1000,
      time_updated: 1000,
      messages: [],
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    };
  }
}

function makeScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const agent = new MockAgent();
  return {
    sessions: [makeSession("s1"), makeSession("s2")],
    byAgent: { claudecode: [makeSession("s1"), makeSession("s2")] },
    agents: [agent],
    ...overrides,
  };
}

function makeScanSource(overrides?: Partial<ScanResult>): ScanResultSource {
  const result = makeScanResult(overrides);
  return {
    getSnapshot() {
      return result;
    },
  };
}

// --- Tests ---

describe("handleGetAgents", () => {
  it("returns agent info list", () => {
    const c = makeMockContext();
    handleGetAgents(c, makeScanSource());
    expect(c.json).toHaveBeenCalled();
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response)).toBe(true);
  });

  it("applies default time window to agent counts", () => {
    const c = makeMockContext();
    const from = Date.now() - 7 * 86400000;
    const sessions = [
      makeSession("old", {
        time_created: Date.now() - 30 * 86400000,
        time_updated: Date.now() - 30 * 86400000,
      }),
      makeSession("recent", {
        time_created: Date.now() - 30 * 86400000,
        time_updated: Date.now() - 1 * 86400000,
      }),
    ];
    handleGetAgents(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }), { from });
    const response = c.json.mock.calls[0]![0];
    const claudecode = response.find((a: { name: string }) => a.name === "claudecode");
    expect(claudecode.count).toBe(1);
  });
});

describe("handleGetConfig", () => {
  it("echoes window defaults", () => {
    const c = makeMockContext();
    handleGetConfig(c, { from: 1000, to: 2000, days: 7 });
    const response = c.json.mock.calls[0]![0];
    expect(response.window).toEqual({ from: 1000, to: 2000, days: 7 });
  });
});

describe("handleGetSessions", () => {
  it("returns all sessions without filters", () => {
    const c = makeMockContext();
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("filters by agent", () => {
    const c = makeMockContext({ query: { agent: "claudecode" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("falls back to all sessions when agent not found in byAgent", () => {
    const c = makeMockContext({ query: { agent: "nonexistent" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    // Falls back to scanResult.sessions
    expect(response.sessions).toHaveLength(2);
  });

  it("filters by q (title search)", () => {
    const c = makeMockContext({ query: { q: "s1" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe("s1");
  });

  it("filters by cwd (substring match)", () => {
    const c = makeMockContext({ query: { cwd: "project" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("filters by from date", () => {
    const c = makeMockContext({ query: { from: "2024-01-01" } });
    handleGetSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("old", {
            time_created: new Date("2023-01-01").getTime(),
            time_updated: new Date("2023-01-01").getTime(),
          }),
          makeSession("new", {
            time_created: new Date("2023-01-01").getTime(),
            time_updated: new Date("2025-01-01").getTime(),
          }),
        ],
        byAgent: {},
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe("new");
  });

  it("uses activity time instead of creation time for session filters", () => {
    const now = Date.now();
    const c = makeMockContext({ query: { from: new Date(now - 7 * 86400000).toISOString() } });
    handleGetSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("old-active", {
            time_created: now - 90 * 86400000,
            time_updated: now - 60_000,
          }),
          makeSession("old-idle", {
            time_created: now - 90 * 86400000,
            time_updated: now - 90 * 86400000,
          }),
        ],
        byAgent: {},
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe("old-active");
  });

  it("ignores invalid from date", () => {
    const c = makeMockContext({ query: { from: "not-a-date" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    // Invalid date → filter not applied
    expect(response.sessions).toHaveLength(2);
  });
});

describe("handleGetDashboard", () => {
  it("aggregates totals across all sessions", () => {
    const c = makeMockContext();
    const sessions = [
      makeSession("a", {
        time_created: Date.now() - 2 * 86400000,
        stats: {
          message_count: 3,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0.1,
        },
      }),
      makeSession("b", {
        time_created: Date.now() - 1 * 86400000,
        stats: {
          message_count: 2,
          total_input_tokens: 4,
          total_output_tokens: 1,
          total_cost: 0.05,
          total_tokens: 12,
        },
      }),
    ];
    handleGetDashboard(
      c,
      makeScanSource({
        sessions,
        byAgent: { claudecode: sessions },
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(2);
    expect(response.totals.messages).toBe(5);
    expect(response.totals.tokens).toBe(15 + 12);
    expect(response.totals.cost).toBeCloseTo(0.15);
    expect(response.dailyActivity).toHaveLength(30);
  });

  it("honors custom days query param", () => {
    const c = makeMockContext({ query: { days: "7" } });
    handleGetDashboard(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.dailyActivity).toHaveLength(7);
    expect(response.window.days).toBe(7);
  });

  it("produces per-agent breakdown sorted by session count", () => {
    const c = makeMockContext();
    handleGetDashboard(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response.perAgent)).toBe(true);
    expect(response.perAgent[0]?.name).toBe("claudecode");
  });

  it("aggregates smart tag distribution", () => {
    const c = makeMockContext();
    const sessions = [
      makeSession("a", {
        smart_tags: ["bugfix", "testing"],
        stats: {
          message_count: 2,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0,
        },
      }),
      makeSession("b", {
        smart_tags: ["bugfix"],
        stats: {
          message_count: 3,
          total_input_tokens: 1,
          total_output_tokens: 1,
          total_cost: 0,
        },
      }),
    ];

    handleGetDashboard(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];

    expect(response.tagDistribution).toEqual([
      { tag: "bugfix", sessions: 2, messages: 5, tokens: 17 },
      { tag: "testing", sessions: 1, messages: 2, tokens: 15 },
    ]);
  });

  it("uses activity time instead of creation time for dashboard windowing", () => {
    const c = makeMockContext({ query: { days: "7" } });
    const now = Date.now();
    const staleCreatedRecentlyUpdated = makeSession("old-active", {
      time_created: now - 40 * 86400000,
      time_updated: now - 60_000,
      stats: {
        message_count: 7,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0,
      },
    });
    const recentButIdle = makeSession("recent-idle", {
      time_created: now - 2 * 86400000,
      time_updated: now - 2 * 86400000,
      stats: {
        message_count: 2,
        total_input_tokens: 1,
        total_output_tokens: 1,
        total_cost: 0,
      },
    });

    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [staleCreatedRecentlyUpdated, recentButIdle],
        byAgent: { claudecode: [staleCreatedRecentlyUpdated, recentButIdle] },
      }),
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(2);
    expect(response.totals.latestActivity).toBe(staleCreatedRecentlyUpdated.time_updated);
    expect(response.recentSessions[0]?.id).toBe("old-active");

    const todayKey = new Date(now).toLocaleDateString("en-CA").replaceAll("/", "-");
    const todayBucket = response.dailyActivity.find(
      (bucket: { date: string }) => bucket.date === todayKey,
    );
    expect(todayBucket?.sessions).toBe(1);
    expect(todayBucket?.messages).toBe(7);
  });
});

describe("handleGetSessionData", () => {
  it("returns session data for valid agent and id", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalled();
    const response = c.json.mock.calls[0]![0];
    expect(response.title).toBe("Test Session");
  });

  it("returns 400 when session ID is missing", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Missing session ID" }, 400);
  });

  it("returns 404 for unknown agent", async () => {
    const c = makeMockContext({ param: { agent: "unknown", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Unknown agent: unknown" }, 404);
  });

  it("returns 500 when agent throws", async () => {
    const agent = new MockAgent();
    agent.getSessionData = () => {
      throw new Error("DB not found");
    };
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    await handleGetSessionData(c, makeScanSource({ agents: [agent] }));
    expect(c.json).toHaveBeenCalledWith({ error: "DB not found" }, 500);
  });
});
