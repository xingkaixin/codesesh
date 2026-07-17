import { afterEach, describe, it, expect, vi } from "vitest";

const coreMocks = vi.hoisted(() => ({
  loadCachedSessionData: vi.fn(),
  listFileActivity: vi.fn((): FileActivityResult[] => []),
  listSessionFileActivity: vi.fn(() => []),
  listSessionAliases: vi.fn<
    () => Array<{ agentKey: string; sessionId: string; alias: string; updated_at: number }>
  >(() => []),
  executeSessionSearch: vi.fn(
    (
      _query: string,
      _options?: unknown,
      _scanResult?: unknown,
    ): Array<{ agentName: string; session: SessionHead }> => [],
  ),
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core")>();
  return {
    ...actual,
    loadCachedSessionData: coreMocks.loadCachedSessionData,
    listFileActivity: coreMocks.listFileActivity,
    listSessionFileActivity: coreMocks.listSessionFileActivity,
    listSessionAliases: coreMocks.listSessionAliases,
    executeSessionSearch: coreMocks.executeSessionSearch,
  };
});

import {
  handleGetAgents,
  handleGetConfig,
  handleGetDashboard,
  handleGetFileActivity,
  handleGetProjects,
  handleGetSessions,
  handleGetSessionData,
  handleSearchSessions,
  type ScanResultSource,
} from "../handlers.js";
import type {
  ChangeCheckResult,
  FileActivityResult,
  ScanResult,
  SessionCacheMeta,
  SessionHead,
  SessionData,
} from "@codesesh/core";
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
  const params = new URLSearchParams(overrides.query ?? {});
  return {
    req: {
      query: (key: string) => overrides.query?.[key] ?? "",
      param: (key: string) => overrides.param?.[key] ?? "",
      url: `http://localhost/${params.size ? `?${params.toString()}` : ""}`,
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
      directory: "/home/user/project",
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

  checkForChanges(): ChangeCheckResult {
    return { hasChanges: false, timestamp: Date.now() };
  }

  incrementalScan(cachedSessions: SessionHead[]): SessionHead[] {
    return cachedSessions;
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return new Map();
  }

  setSessionMetaMap(): void {}
}

function makeScanResult(overrides?: Partial<ScanResult>): ScanResult {
  const agent = new MockAgent();
  const sessions = [
    makeSession("s1", { slug: "claudecode/s1" }),
    makeSession("s2", { slug: "claudecode/s2" }),
  ];
  return {
    sessions,
    byAgent: { claudecode: sessions },
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

function toLocalDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// --- Tests ---

afterEach(() => {
  coreMocks.loadCachedSessionData.mockReset();
  coreMocks.listFileActivity.mockReset();
  coreMocks.listFileActivity.mockReturnValue([]);
  coreMocks.listSessionFileActivity.mockReset();
  coreMocks.listSessionFileActivity.mockReturnValue([]);
  coreMocks.listSessionAliases.mockReset();
  coreMocks.listSessionAliases.mockReturnValue([]);
  coreMocks.executeSessionSearch.mockReset();
  coreMocks.executeSessionSearch.mockReturnValue([]);
  vi.useRealTimers();
});

describe("handleGetAgents", () => {
  it("returns agent info list", () => {
    const c = makeMockContext();
    handleGetAgents(c, makeScanSource());
    expect(c.json).toHaveBeenCalled();
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response)).toBe(true);
  });

  it("keeps the registered catalog while zeroing counts outside the current window", () => {
    const c = makeMockContext();
    const now = Date.now();
    const old = makeSession("old", {
      slug: "codex/old",
      time_created: now - 30 * 86400000,
      time_updated: now - 30 * 86400000,
    });
    const recent = makeSession("recent", {
      slug: "claudecode/recent",
      time_created: now - 86400000,
      time_updated: now - 86400000,
    });
    handleGetAgents(
      c,
      makeScanSource({
        sessions: [old, recent],
        byAgent: { codex: [old], claudecode: [recent] },
      }),
      { from: now - 7 * 86400000 },
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.map((agent: { name: string }) => agent.name)).toEqual([
      "claudecode",
      "opencode",
      "zcode",
      "kimi",
      "codex",
      "pi",
      "cursor",
    ]);
    expect(response.find((agent: { name: string }) => agent.name === "claudecode")?.count).toBe(1);
    expect(response.find((agent: { name: string }) => agent.name === "codex")?.count).toBe(0);
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

  it("lets request dates override the default time window", () => {
    const recent = makeSession("recent", { time_updated: 5000 });
    const old = makeSession("old", { time_updated: 1000 });
    const c = makeMockContext({ query: { from: new Date(0).toISOString() } });

    handleGetAgents(
      c,
      makeScanSource({ sessions: [recent, old], byAgent: { claudecode: [recent, old] } }),
      { from: 3000 },
    );

    expect(c.json.mock.calls[0]![0][0].count).toBe(2);
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

  it("projects a persisted alias without changing the source title", () => {
    coreMocks.listSessionAliases.mockReturnValue([
      {
        agentKey: "claudecode",
        sessionId: "s1",
        alias: "Fix session cache refresh",
        updated_at: Date.now(),
      },
    ]);
    const c = makeMockContext();

    handleGetSessions(c, makeScanSource());

    const session = c.json.mock.calls[0]![0].sessions[0];
    expect(session).toMatchObject({
      title: "Session s1",
      display_title: "Fix session cache refresh",
    });
  });

  it("filters by cwd using project scope match", () => {
    const sessions = [
      makeSession("exact", { directory: "/home/user/project" }),
      makeSession("child", { directory: "/home/user/project/src" }),
      makeSession("parent", { directory: "/home/user" }),
      makeSession("identity", {
        directory: "/elsewhere",
        project_identity: {
          kind: "path",
          key: "/home/user/project",
          displayName: "project",
        },
      }),
      makeSession("sibling", { directory: "/home/user/projectile" }),
    ];
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    handleGetSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions.map((session: SessionHead) => session.id)).toEqual([
      "exact",
      "child",
      "parent",
      "identity",
    ]);
  });

  it("filters by project identity key", () => {
    const sessions = [
      makeSession("a", {
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
      }),
      makeSession("b", {
        project_identity: { kind: "path", key: "/home/user/other", displayName: "other" },
      }),
      makeSession("same-key-path", {
        project_identity: {
          kind: "path",
          key: "github.com/acme/app",
          displayName: "app path",
        },
      }),
    ];
    const c = makeMockContext({
      query: { projectKind: "git_remote", projectKey: "github.com/acme/app" },
    });
    handleGetSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions.map((session: SessionHead) => session.id)).toEqual(["a"]);
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

describe("handleSearchSessions", () => {
  it("maps HTTP query params into a query string, SearchOptions, and the scan snapshot, then returns the module's results", () => {
    const scanSource = makeScanSource();
    const sentinelResults = [{ agentName: "claudecode", session: makeSession("s1") }];
    coreMocks.executeSessionSearch.mockReturnValue(sentinelResults);

    const c = makeMockContext({
      query: {
        q: " needle ",
        agent: "claudecode",
        tag: "bugfix",
        limit: "5",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      },
    });
    handleSearchSessions(c, scanSource);

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({
        agent: "claudecode",
        tags: ["bugfix"],
        limit: 5,
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      }),
      scanSource.getSnapshot(),
    );
    expect(c.json).toHaveBeenCalledWith({ results: sentinelResults });
  });

  it("rejects incomplete project identity filters without calling the search module", () => {
    const c = makeMockContext({ query: { q: "", projectKey: "github.com/acme/app" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      400,
    );
    expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
  });

  it("matches aliases while preserving query qualifiers", () => {
    const aliased = makeSession("s1", { slug: "claudecode/s1" });
    coreMocks.listSessionAliases.mockReturnValue([
      { agentKey: "claudecode", sessionId: "s1", alias: "Custom cache title", updated_at: 1 },
    ]);
    coreMocks.executeSessionSearch.mockImplementation((query) =>
      query ? [] : [{ agentName: "claudecode", session: aliased }],
    );
    const c = makeMockContext({ query: { q: "agent:claudecode custom cache" } });

    handleSearchSessions(c, makeScanSource());

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ agent: "claudecode", limit: 2 }),
      expect.anything(),
    );
    expect(c.json.mock.calls[0]![0].results[0].session.display_title).toBe("Custom cache title");
  });

  it("does not cap alias search candidates at one thousand sessions", () => {
    const sessions = Array.from({ length: 1001 }, (_, index) =>
      makeSession(`s${index}`, { slug: `claudecode/s${index}` }),
    );
    coreMocks.listSessionAliases.mockReturnValue([
      { agentKey: "claudecode", sessionId: "s1000", alias: "Old alias", updated_at: 1 },
    ]);
    coreMocks.executeSessionSearch.mockImplementation((query) =>
      query ? [] : [{ agentName: "claudecode", session: sessions[1000]! }],
    );
    const c = makeMockContext({ query: { q: "old alias" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "",
      expect.objectContaining({ limit: 1001 }),
      expect.anything(),
    );
    expect(c.json.mock.calls[0]![0].results[0].session.id).toBe("s1000");
  });
});

describe("handleGetFileActivity", () => {
  it("projects aliases onto nested sessions", () => {
    const session = makeSession("s1", { slug: "claudecode/s1" });
    coreMocks.listSessionAliases.mockReturnValue([
      { agentKey: "claudecode", sessionId: "s1", alias: "Activity alias", updated_at: 1 },
    ]);
    coreMocks.listFileActivity.mockReturnValue([
      {
        agent_name: "claudecode",
        session_id: "s1",
        project_identity_key: "path:/tmp",
        path: "src/index.ts",
        kind: "edit",
        count: 1,
        latest_time: 1,
        session,
      },
    ]);
    const c = makeMockContext();

    handleGetFileActivity(c);

    expect(c.json.mock.calls[0]![0].activity[0].session.display_title).toBe("Activity alias");
  });
});

describe("handleGetProjects", () => {
  it("lets request dates override the default time window", () => {
    const old = makeSession("old", {
      time_updated: 1000,
      project_identity: { kind: "path", key: "/old", displayName: "old" },
    });
    const c = makeMockContext({ query: { from: new Date(0).toISOString() } });

    handleGetProjects(c, makeScanSource({ sessions: [old], byAgent: { claudecode: [old] } }), {
      from: 3000,
    });

    expect(c.json.mock.calls[0]![0].projects[0].displayName).toBe("old");
  });

  it("returns project groups sorted by recent activity", () => {
    const sessions = [
      makeSession("a", {
        slug: "claudecode/a",
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
        time_updated: 100,
        stats: {
          message_count: 2,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0.1,
        },
      }),
      makeSession("b", {
        slug: "codex/b",
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
        time_updated: 200,
        stats: {
          message_count: 3,
          total_input_tokens: 1,
          total_output_tokens: 2,
          total_cost: 0.2,
          total_tokens: 20,
          cost_source: "estimated",
        },
      }),
    ];
    const c = makeMockContext();
    handleGetProjects(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];
    expect(response.projects).toEqual([
      {
        identityKind: "git_remote",
        identityKey: "github.com/acme/app",
        displayName: "app",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: 200,
        messages: 5,
        tokens: 35,
        cost: 0.30000000000000004,
        cost_source: "estimated",
        agentStats: [
          {
            name: "claudecode",
            sessions: 1,
            messages: 2,
            tokens: 15,
            cost: 0.1,
          },
          {
            name: "codex",
            sessions: 1,
            messages: 3,
            tokens: 20,
            cost: 0.2,
          },
        ],
      },
    ]);
  });
});

describe("handleGetDashboard", () => {
  it("projects aliases onto recent file activity sessions", () => {
    const session = makeSession("s1", { slug: "claudecode/s1" });
    coreMocks.listSessionAliases.mockReturnValue([
      { agentKey: "claudecode", sessionId: "s1", alias: "Activity alias", updated_at: 1 },
    ]);
    coreMocks.listFileActivity.mockReturnValue([
      {
        agent_name: "claudecode",
        session_id: "s1",
        project_identity_key: "path:/tmp",
        path: "src/index.ts",
        kind: "edit",
        count: 1,
        latest_time: 1,
        session,
      },
    ]);
    const c = makeMockContext();

    handleGetDashboard(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].recentFileActivities[0].session.display_title).toBe(
      "Activity alias",
    );
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
      slug: "claudecode/app-claude",
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
      slug: "codex/app-codex",
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
      slug: "codex/other-codex",
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
      slug: "codex/same-key-path-codex",
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
    expect(response.recentSessions.map((session: SessionHead) => session.id)).toEqual([
      "app-codex",
    ]);
  });

  it("scopes dashboard data by agent and keeps the ten most recent sessions", () => {
    const now = Date.now();
    const codexSessions = Array.from({ length: 12 }, (_, index) =>
      makeSession(`codex-${index}`, {
        slug: `codex/codex-${index}`,
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
      slug: "claudecode/claude",
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
        sessions: 12,
        messages: 12,
        tokens: 36,
      },
    ]);
    expect(response.recentSessions.map((session: SessionHead) => session.id)).toEqual(
      codexSessions.slice(0, 10).map((session) => session.id),
    );
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
      slug: "claudecode/old",
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
    expect(response.recentSessions[0]?.id).toBe("old");
    expect(response.dailyActivity).toEqual([
      {
        date: "2026-04-20",
        sessions: 1,
        messages: 3,
      },
    ]);
    expect(response.window.from).toBeUndefined();
    expect(response.window.days).toBe(0);
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
    expect(response.recentSessions[0].smart_tags).toEqual(["bugfix", "testing"]);
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

    const todayKey = toLocalDateKey(now);
    const todayBucket = response.dailyActivity.find(
      (bucket: { date: string }) => bucket.date === todayKey,
    );
    expect(todayBucket?.sessions).toBe(1);
    expect(todayBucket?.messages).toBe(7);
  });

  it("uses the server default rolling window for dashboard totals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00Z"));

    const now = Date.now();
    const yesterdayInRollingWindow = makeSession("yesterday-active", {
      time_created: new Date("2026-05-01T18:00:00Z").getTime(),
      time_updated: new Date("2026-05-01T18:00:00Z").getTime(),
    });
    const todayActive = makeSession("today-active", {
      time_created: new Date("2026-05-02T08:00:00Z").getTime(),
      time_updated: new Date("2026-05-02T08:00:00Z").getTime(),
    });
    const stale = makeSession("stale", {
      time_created: new Date("2026-05-01T08:00:00Z").getTime(),
      time_updated: new Date("2026-05-01T08:00:00Z").getTime(),
    });

    const c = makeMockContext();
    handleGetDashboard(
      c,
      makeScanSource({
        sessions: [yesterdayInRollingWindow, todayActive, stale],
        byAgent: { claudecode: [yesterdayInRollingWindow, todayActive, stale] },
      }),
      { from: now - 86400000, days: 1 },
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.totals.sessions).toBe(2);
    expect(
      response.dailyActivity.reduce(
        (sum: number, bucket: { sessions: number }) => sum + bucket.sessions,
        0,
      ),
    ).toBe(2);
  });
});

describe("handleGetSessionData", () => {
  it("returns session data for valid agent and id", async () => {
    coreMocks.loadCachedSessionData.mockReturnValue({
      id: "s1",
      slug: "claudecode/s1",
      title: "Test Session",
      directory: "/home/user/project",
      time_created: 1000,
      time_updated: 1000,
      messages: [],
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalled();
    const response = c.json.mock.calls[0]![0];
    expect(response.title).toBe("Test Session");
    expect(coreMocks.loadCachedSessionData).toHaveBeenCalledWith("claudecode", "s1");
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

  it("returns 404 when the SQLite session cache is missing", async () => {
    coreMocks.loadCachedSessionData.mockReturnValue(null);
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    await handleGetSessionData(
      c,
      makeScanSource({
        sessions: [],
        byAgent: { claudecode: [] },
      }),
    );
    expect(c.json).toHaveBeenCalledWith({ error: "Session cache not ready" }, 404);
  });

  it("loads session data from the current agent index when SQLite cache is empty", async () => {
    coreMocks.loadCachedSessionData.mockReturnValue(null);
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(c, makeScanSource());

    const response = c.json.mock.calls[0]![0];
    expect(response.title).toBe("Test Session");
    expect(response.project_identity).toMatchObject({
      kind: "path",
      key: "/home/user/project",
    });
    expect(response.file_activity).toEqual([]);
  });

  it("falls back to the current agent index when cached messages are missing", async () => {
    coreMocks.loadCachedSessionData.mockReturnValue({
      id: "s1",
      slug: "claudecode/s1",
      title: "Cached Session",
      directory: "/home/user/project",
      time_created: 1000,
      time_updated: 1000,
      messages: [],
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });

    class AgentWithDetail extends MockAgent {
      override getSessionData(_sessionId: string): SessionData {
        return {
          id: "s1",
          slug: "claudecode/s1",
          title: "Source Session",
          directory: "/home/user/project",
          time_created: 1000,
          time_updated: 1000,
          messages: [
            {
              id: "m1",
              role: "user",
              time_created: 1000,
              parts: [{ type: "text", text: "hello" }],
            },
          ],
          stats: {
            message_count: 1,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 0,
          },
        };
      }
    }

    const sessions = [makeSession("s1", { slug: "claudecode/s1" })];
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(
      c,
      makeScanSource({
        sessions,
        byAgent: { claudecode: sessions },
        agents: [new AgentWithDetail()],
      }),
    );

    const response = c.json.mock.calls[0]![0];
    expect(response.title).toBe("Source Session");
    expect(response.messages).toHaveLength(1);
    expect(coreMocks.listSessionFileActivity).not.toHaveBeenCalled();
  });

  it("returns 500 when SQLite cache loading throws", async () => {
    coreMocks.loadCachedSessionData.mockImplementation(() => {
      throw new Error("DB not found");
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "DB not found" }, 500);
  });
});
