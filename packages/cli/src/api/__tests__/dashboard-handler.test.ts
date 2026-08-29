import { describe, expect, it, vi } from "vitest";
import type { DashboardCostFacts } from "@codesesh/core/runtime/analytics";
import type { SessionHead } from "@codesesh/core/runtime/discovery";
import type { ScanResultSource } from "../scan-sources.js";
import {
  coreMocks,
  makeAlias,
  makeMockContext,
  makeScanResult,
  makeScanSource,
  makeSession,
  toLocalDateKey,
} from "./handler-test-fixtures.js";

const { handleGetDashboard } = await import("../dashboard-handler.js");

describe("handleGetDashboard", () => {
  it("rejects invalid dates instead of silently using defaults", () => {
    const c = makeMockContext({ query: { from: "invalid", to: "invalid" } });

    handleGetDashboard(c, makeScanSource(), { from: 1, to: 2, days: 5 });

    expect(c.json).toHaveBeenCalledWith({ error: "from must be a valid date" }, 400);
    expect(coreMocks.buildDashboard).not.toHaveBeenCalled();
  });

  it("reuses matching snapshot aggregates and invalidates them with the sessions array", () => {
    let snapshot = makeScanResult();
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    const query = { days: "0", to: "2026-07-26T12:00:00.000Z" };

    handleGetDashboard(makeMockContext({ query }), source);
    handleGetDashboard(makeMockContext({ query }), source);

    expect(coreMocks.buildDashboard).toHaveBeenCalledTimes(1);

    snapshot = { ...snapshot, sessions: [...snapshot.sessions] };
    handleGetDashboard(makeMockContext({ query }), source);
    handleGetDashboard(makeMockContext({ query: { ...query, agent: "codex" } }), source);

    expect(coreMocks.buildDashboard).toHaveBeenCalledTimes(3);
  });

  it("reuses an implicit current-time window within a day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 26, 12));
    const source = makeScanSource();

    handleGetDashboard(makeMockContext(), source);
    vi.setSystemTime(new Date(2026, 6, 26, 18));
    handleGetDashboard(makeMockContext(), source);

    expect(coreMocks.buildDashboard).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 6, 27, 12));
    handleGetDashboard(makeMockContext(), source);

    expect(coreMocks.buildDashboard).toHaveBeenCalledTimes(2);
  });

  it("projects aliases onto recent file activity sessions", () => {
    const session = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
    });
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "s1", "Activity alias")]);
    coreMocks.listFileActivity.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        projectIdentityKey: "path:/tmp",
        path: "src/index.ts",
        kind: "edit",
        count: 1,
        latestTime: 1,
        session,
      },
    ]);
    const c = makeMockContext();

    handleGetDashboard(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].recentFileActivities[0].session.display_title).toBe(
      "Activity alias",
    );
  });

  it("omits internal metadata from recent sessions", () => {
    const session = makeSession("private", {
      model_usage: { "gpt-5.5": 5 },
      project_identity_resolver_revision: "resolver-v2",
      project_identity_input_signature: "signature",
      smart_tags_source_updated_at: 2,
      smart_tags_classifier_revision: "classifier-v2",
    });
    const c = makeMockContext();

    handleGetDashboard(
      c,
      makeScanSource({ sessions: [session], byAgent: { claudecode: [session] } }),
    );

    const responseSession = c.json.mock.calls[0]![0].recentSessions[0].session;
    expect(responseSession).not.toHaveProperty("model_usage");
    expect(responseSession).not.toHaveProperty("project_identity_resolver_revision");
    expect(responseSession).not.toHaveProperty("project_identity_input_signature");
    expect(responseSession).not.toHaveProperty("smart_tags_source_updated_at");
    expect(responseSession).not.toHaveProperty("smart_tags_classifier_revision");
    expect(session.model_usage).toEqual({ "gpt-5.5": 5 });
  });

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
    expect(response.totals.cost_source).toBe("recorded");
    expect(response.dailyActivity).toHaveLength(30);
  });

  it("scopes dashboard data by project identity and agent", () => {
    const now = Date.now();
    const appClaude = makeSession("app-claude", {
      reference: { agentName: "claudecode", sessionId: "app-claude" },
      time_updated: now,
      project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
      stats: {
        message_count: 2,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0.1,
      },
    });
    const appCodex = makeSession("app-codex", {
      reference: { agentName: "codex", sessionId: "app-codex" },
      time_updated: now,
      project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
      stats: {
        message_count: 4,
        total_input_tokens: 30,
        total_output_tokens: 10,
        total_cost: 0.2,
      },
    });
    const otherCodex = makeSession("other-codex", {
      reference: { agentName: "codex", sessionId: "other-codex" },
      time_updated: now,
      project_identity: { kind: "path", key: "/repo/other", displayName: "other" },
      stats: {
        message_count: 9,
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cost: 0.9,
      },
    });
    const sameKeyPathCodex = makeSession("same-key-path-codex", {
      reference: { agentName: "codex", sessionId: "same-key-path-codex" },
      time_updated: now,
      project_identity: { kind: "path", key: "github.com/acme/app", displayName: "app path" },
      stats: {
        message_count: 7,
        total_input_tokens: 20,
        total_output_tokens: 10,
        total_cost: 0.7,
      },
    });
    const c = makeMockContext({
      query: { projectKind: "git_remote", projectKey: "github.com/acme/app", agent: "codex" },
    });

    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [appClaude, appCodex, otherCodex, sameKeyPathCodex],
        byAgent: {
          claudecode: [appClaude],
          codex: [appCodex, otherCodex, sameKeyPathCodex],
        },
      }),
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(1);
    expect(response.totals.messages).toBe(4);
    expect(response.totals.tokens).toBe(40);
    expect(response.totals.cost).toBeCloseTo(0.2);
    expect(response.perAgent).toHaveLength(1);
    expect(response.perAgent[0]?.name).toBe("codex");
    expect(
      response.recentSessions.map(
        (item: { session: SessionHead }) => item.session.reference.sessionId,
      ),
    ).toEqual(["app-codex"]);
  });

  it("scopes dashboard data by agent and keeps the ten most recent sessions", () => {
    const now = Date.now();
    const codexSessions = Array.from({ length: 12 }, (_, index) =>
      makeSession(`codex-${index}`, {
        reference: { agentName: "codex", sessionId: `codex-${index}` },
        time_created: now - index * 1000,
        time_updated: now - index * 1000,
        stats: {
          message_count: 1,
          total_input_tokens: 2,
          total_output_tokens: 1,
          total_cost: 0,
        },
      }),
    );
    const claudeSession = makeSession("claude", {
      reference: { agentName: "claudecode", sessionId: "claude" },
      time_created: now,
      time_updated: now,
    });
    const c = makeMockContext({ query: { agent: "codex" } });

    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [claudeSession, ...codexSessions],
        byAgent: {
          claudecode: [claudeSession],
          codex: codexSessions,
        },
      }),
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(12);
    expect(response.perAgent).toEqual([
      {
        name: "codex",
        displayName: "Codex",
        icon: "/icon/agent/codex.svg",
        iconColored: undefined,
        sessions: 12,
        messages: 12,
        tokens: 36,
        cost: 0,
      },
    ]);
    expect(
      response.recentSessions.map(
        (item: { session: SessionHead }) => item.session.reference.sessionId,
      ),
    ).toEqual(codexSessions.slice(0, 10).map((session) => session.reference.sessionId));
  });

  it("marks dashboard totals as estimated when any session uses estimated cost", () => {
    const c = makeMockContext();
    const sessions = [
      makeSession("a", {
        time_created: Date.now() - 2 * 86400000,
        stats: {
          message_count: 3,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0.1,
          cost_source: "estimated",
        },
      }),
    ];

    handleGetDashboard(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];

    expect(response.totals.cost_source).toBe("estimated");
  });

  it("honors custom days query param", () => {
    const c = makeMockContext({ query: { days: "7" } });
    handleGetDashboard(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.dailyActivity).toHaveLength(7);
    expect(response.window.days).toBe(7);
  });

  it("honors days 0 as an all-time dashboard window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T12:00:00Z"));

    const oldSession = makeSession("old", {
      reference: { agentName: "claudecode", sessionId: "old" },
      time_created: new Date("2026-04-20T10:00:00Z").getTime(),
      time_updated: new Date("2026-04-20T10:00:00Z").getTime(),
      stats: {
        message_count: 3,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0,
      },
    });
    const c = makeMockContext();

    handleGetDashboard(
      c,
      makeScanSource({ sessions: [oldSession], byAgent: { claudecode: [oldSession] } }),
      { days: 0 },
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(1);
    expect(response.recentSessions[0]?.session.reference.sessionId).toBe("old");
    expect(response.dailyActivity).toEqual([
      {
        date: "2026-04-20",
        sessions: 1,
        messages: 3,
        cost: 0,
        input: 10,
        output: 5,
        cache_read: 0,
        cache_create: 0,
      },
    ]);
    expect(response.window.from).toBeUndefined();
    expect(response.window.days).toBe(0);
    expect(response.window.compareFrom).toBeUndefined();
    expect(response.window.compareTo).toBeUndefined();
    expect(response.totals.previous).toBeUndefined();
  });

  it("produces per-agent breakdown sorted by session count", () => {
    const c = makeMockContext();
    handleGetDashboard(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response.perAgent)).toBe(true);
    expect(response.perAgent[0]?.name).toBe("claudecode");
  });

  it("keeps smart tags on recent sessions", () => {
    const c = makeMockContext();
    const sessions = [
      makeSession("a", {
        time_updated: Date.now(),
        smart_tags: ["bugfix", "testing"],
        stats: {
          message_count: 2,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0,
        },
      }),
      makeSession("b", {
        time_updated: Date.now() - 1000,
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

    expect(response.tagDistribution).toBeUndefined();
    expect(response.recentSessions[0].session.smart_tags).toEqual(["bugfix", "testing"]);
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
    expect(response.recentSessions[0]?.session.reference.sessionId).toBe("old-active");

    const todayKey = toLocalDateKey(now);
    const todayBucket = response.dailyActivity.find(
      (bucket: { date: string }) => bucket.date === todayKey,
    );
    expect(todayBucket?.sessions).toBe(1);
    expect(todayBucket?.messages).toBe(7);
  });

  it("normalizes the server default to calendar-day dashboard totals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 2, 12));

    const now = Date.now();
    const yesterdayActive = makeSession("yesterday-active", {
      time_created: new Date(2026, 4, 1, 18).getTime(),
      time_updated: new Date(2026, 4, 1, 18).getTime(),
    });
    const todayActive = makeSession("today-active", {
      time_created: new Date(2026, 4, 2, 8).getTime(),
      time_updated: new Date(2026, 4, 2, 8).getTime(),
    });
    const stale = makeSession("stale", {
      time_created: new Date(2026, 4, 1, 8).getTime(),
      time_updated: new Date(2026, 4, 1, 8).getTime(),
    });

    const c = makeMockContext();
    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [yesterdayActive, todayActive, stale],
        byAgent: { claudecode: [yesterdayActive, todayActive, stale] },
      }),
      { from: now - 86400000, days: 1 },
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(1);
    expect(
      response.dailyActivity.reduce(
        (sum: number, bucket: { sessions: number }) => sum + bucket.sessions,
        0,
      ),
    ).toBe(1);
  });

  it("reports the preceding equal-length window as the compare baseline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 20, 12));

    const inWindow = makeSession("current", {
      time_created: new Date(2026, 4, 19, 9).getTime(),
      time_updated: new Date(2026, 4, 19, 9).getTime(),
      stats: {
        message_count: 4,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 0.4,
      },
    });
    const inPreviousWindow = makeSession("previous", {
      time_created: new Date(2026, 4, 9, 9).getTime(),
      time_updated: new Date(2026, 4, 9, 9).getTime(),
      stats: {
        message_count: 3,
        total_input_tokens: 2,
        total_output_tokens: 1,
        total_cost: 0.1,
      },
    });
    const c = makeMockContext({ query: { days: "7" } });

    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [inWindow, inPreviousWindow],
        byAgent: { claudecode: [inWindow, inPreviousWindow] },
      }),
    );

    const response = c.json.mock.calls[0]![0];
    const from = new Date(2026, 4, 14).getTime();
    expect(response.window.from).toBe(from);
    expect(response.window.compareFrom).toBe(new Date(2026, 4, 7).getTime());
    expect(response.window.compareTo).toBe(from - 1);
    expect(response.totals.sessions).toBe(1);
    expect(response.totals.previous).toEqual({
      sessions: 1,
      messages: 3,
      tokens: 3,
      cost: 0.1,
    });
  });

  it("does not fragment the aggregate cache on redundant days", () => {
    const source = makeScanSource();
    const to = "2026-07-26T12:00:00.000Z";

    handleGetDashboard(makeMockContext({ query: { from: "2026-07-20", to } }), source);
    handleGetDashboard(makeMockContext({ query: { from: "2026-07-20", to, days: "3" } }), source);

    expect(coreMocks.buildDashboard).toHaveBeenCalledTimes(1);
  });

  it("reuses storage aggregations until the analytics revision changes", () => {
    const source = makeScanSource();
    coreMocks.getAnalyticsRevision.mockReturnValue("1");

    handleGetDashboard(makeMockContext(), source);
    handleGetDashboard(makeMockContext(), source);

    expect(coreMocks.listFileActivity).toHaveBeenCalledTimes(1);
    expect(coreMocks.listDashboardCostFacts).toHaveBeenCalledTimes(1);

    coreMocks.getAnalyticsRevision.mockReturnValue("2");
    handleGetDashboard(makeMockContext(), source);

    expect(coreMocks.listFileActivity).toHaveBeenCalledTimes(2);
    expect(coreMocks.listDashboardCostFacts).toHaveBeenCalledTimes(2);
  });

  it("propagates unavailable cost facts instead of substituting model-cost zeros", () => {
    const c = makeMockContext();

    handleGetDashboard(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].modelCost).toBeNull();
  });

  it("passes the combined dashboard windows to the cost-fact producer", () => {
    const costFacts: DashboardCostFacts = { messages: [], sessions: [] };
    coreMocks.listDashboardCostFacts.mockReturnValue(costFacts);
    const c = makeMockContext({
      query: {
        agent: "codex",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        days: "7",
      },
    });

    handleGetDashboard(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];

    expect(coreMocks.listDashboardCostFacts).toHaveBeenCalledWith({
      from: response.window.compareFrom,
      to: response.window.to,
    });
    expect(coreMocks.buildDashboard).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ costFacts }),
    );
    expect(response.modelCost).toEqual([]);
  });
});
