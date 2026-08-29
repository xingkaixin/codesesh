import { afterEach, describe, it, expect, vi } from "vitest";
import { AGENT_CATALOG, createSessionIdentity } from "@codesesh/core/contract";

const coreMocks = vi.hoisted(() => {
  return {
    attachProjectMetrics: vi.fn(),
    buildSessionTree: vi.fn(),
    buildDashboard: vi.fn(),
    filterSessionSearchCandidates: vi.fn(),
    getAnalyticsRevision: vi.fn(() => "0"),
    materializeSessionDetailResponse: vi.fn(),
    listDashboardCostFacts: vi.fn((): DashboardCostFacts | null => null),
    listFileActivity: vi.fn((): FileActivityResult[] => []),
    matchesProjectIdentity: vi.fn(),
    listSessionAliases: vi.fn<
      () => Array<{
        reference: { agentName: string; sessionId: string };
        alias: string;
        updatedAt: number;
      }>
    >(() => []),
    executeSessionSearch: vi.fn(
      (
        _query: string,
        _options?: unknown,
        _scanResult?: unknown,
        _context?: unknown,
      ): Array<{
        reference: { agentName: string; sessionId: string };
        session: SessionHead;
      }> => [],
    ),
  };
});

vi.mock("@codesesh/core/runtime/projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/projects")>();
  return {
    ...actual,
    attachProjectMetrics: (...args: Parameters<typeof actual.attachProjectMetrics>) => {
      coreMocks.attachProjectMetrics(...args);
      return actual.attachProjectMetrics(...args);
    },
    attachProjectMetricsFromTree: (
      ...args: Parameters<typeof actual.attachProjectMetricsFromTree>
    ) => {
      coreMocks.attachProjectMetrics(...args);
      return actual.attachProjectMetricsFromTree(...args);
    },
    matchesProjectIdentity: (...args: Parameters<typeof actual.matchesProjectIdentity>) => {
      coreMocks.matchesProjectIdentity(...args);
      return actual.matchesProjectIdentity(...args);
    },
  };
});

vi.mock("@codesesh/core/runtime/analytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/analytics")>();
  return {
    ...actual,
    buildDashboard: (...args: Parameters<typeof actual.buildDashboard>) => {
      coreMocks.buildDashboard(...args);
      return actual.buildDashboard(...args);
    },
  };
});

vi.mock("@codesesh/core/runtime/search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime/search")>();
  return {
    ...actual,
    filterSessionSearchCandidates: (
      ...args: Parameters<typeof actual.filterSessionSearchCandidates>
    ) => {
      coreMocks.filterSessionSearchCandidates(...args);
      return actual.filterSessionSearchCandidates(...args);
    },
    executeSessionSearch: coreMocks.executeSessionSearch,
  };
});

vi.mock("@codesesh/core/runtime/discovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime/discovery")>()),
  getAnalyticsRevision: coreMocks.getAnalyticsRevision,
  listDashboardCostFacts: coreMocks.listDashboardCostFacts,
  materializeSessionDetailResponse: coreMocks.materializeSessionDetailResponse,
  listFileActivity: coreMocks.listFileActivity,
}));

vi.mock("@codesesh/core/runtime/state", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime/state")>()),
  listSessionAliases: coreMocks.listSessionAliases,
}));

vi.mock("@codesesh/core/contract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/contract")>();
  return {
    ...actual,
    buildSessionTree: (...args: Parameters<typeof actual.buildSessionTree>) => {
      coreMocks.buildSessionTree(...args);
      return actual.buildSessionTree(...args);
    },
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
import { invalidateAliasView } from "../session-aliases-view.js";
import {
  ProjectIdentityQueueFullError,
  ProjectIdentityRequestAbortedError,
  type ProjectIdentityResolver,
} from "../../project-identity-resolver.js";
import type { ChangeCheckResult, SessionCacheMeta } from "@codesesh/core/runtime/agents";
import type { DashboardCostFacts } from "@codesesh/core/runtime/analytics";
import type {
  FileActivityResult,
  IdentifiedSessionHead,
  LiveSnapshot,
  SessionHead,
  SessionDetail,
} from "@codesesh/core/runtime/discovery";
import type { SearchResult } from "@codesesh/core/contract";
import { BaseAgent } from "@codesesh/core/runtime/agents";
import { appLogger } from "../../logging.js";
import { SessionDetailBusyError } from "../../session-detail-loader.js";

// --- Helpers ---

function makeSession(
  id: string,
  overrides?: Partial<IdentifiedSessionHead>,
): IdentifiedSessionHead {
  const identity = createSessionIdentity(
    overrides?.reference ?? { agentName: "agent", sessionId: id },
  );
  const directory = overrides?.directory ?? "/home/user/project";
  return {
    ...identity,
    title: `Session ${id}`,
    time_created: Date.now(),
    time_updated: Date.now(),
    directory,
    project_identity: {
      kind: "path",
      key: directory,
      displayName: "project",
    },
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
    ...identity,
  };
}

function makeAlias(agentName: string, sessionId: string, alias: string) {
  return {
    reference: { agentName, sessionId },
    alias,
    updatedAt: 1,
  };
}

function makeMockContext(
  overrides: {
    query?: Record<string, string>;
    param?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) {
  const jsonFn = vi.fn().mockReturnValue({ status: 200 });
  const params = new URLSearchParams(overrides.query ?? {});
  const url = `http://localhost/${params.size ? `?${params.toString()}` : ""}`;
  return {
    req: {
      query: (key: string) => overrides.query?.[key] ?? "",
      param: (key: string) => overrides.param?.[key] ?? "",
      url,
      raw: new Request(url, { signal: overrides.signal }),
    },
    json: jsonFn,
  } as any;
}

class MockAgent extends BaseAgent {
  readonly name = "claudecode";
  readonly displayName = "Claude Code";
  readonly sessionSourceAccess = {
    kind: "aggregate" as const,
    checkForChanges: () => this.checkForChanges(),
    commitChangeCheck: () => {},
    incrementalScan: (sessions: SessionHead[]) => this.incrementalScan(sessions),
  };

  isAvailable() {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(_sessionId: string): SessionDetail {
    return {
      reference: { agentName: "claudecode", sessionId: "s1" },
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

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "API test adapter" };
  }

  checkForChanges(): ChangeCheckResult {
    return { hasChanges: false, timestamp: Date.now() };
  }

  incrementalScan(cachedSessions: SessionHead[]): SessionHead[] {
    return cachedSessions;
  }

  getSessionCacheMeta(): SessionCacheMeta | undefined {
    return undefined;
  }

  snapshotSessionCacheMeta(): Record<string, SessionCacheMeta> {
    return {};
  }

  restoreSessionCacheMeta(): void {}

  removeSessionCacheMeta(): void {}
}

function makeScanResult(overrides?: Partial<LiveSnapshot>): LiveSnapshot {
  const agent = new MockAgent();
  const sessions = [
    makeSession("s1", { reference: { agentName: "claudecode", sessionId: "s1" } }),
    makeSession("s2", { reference: { agentName: "claudecode", sessionId: "s2" } }),
  ];
  return {
    sessions,
    byAgent: { claudecode: sessions },
    agents: [agent],
    ...overrides,
  };
}

function makeScanSource(overrides?: Partial<LiveSnapshot>): ScanResultSource {
  const result = makeScanResult(overrides);
  return {
    getSnapshot() {
      return result;
    },
  };
}

function makeProjectIdentityResolver(): ProjectIdentityResolver {
  return {
    resolve: vi.fn(async (cwd: string) => ({
      identity: { kind: "path" as const, key: cwd, displayName: "project" },
      resolverRevision: "project-identity-v2",
      inputSignature: "test",
    })),
    shutdown: vi.fn(async () => {}),
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
  coreMocks.attachProjectMetrics.mockClear();
  coreMocks.buildSessionTree.mockClear();
  coreMocks.buildDashboard.mockClear();
  coreMocks.filterSessionSearchCandidates.mockClear();
  coreMocks.getAnalyticsRevision.mockReset();
  coreMocks.getAnalyticsRevision.mockReturnValue("0");
  coreMocks.listDashboardCostFacts.mockReset();
  coreMocks.listDashboardCostFacts.mockReturnValue(null);
  coreMocks.materializeSessionDetailResponse.mockReset();
  coreMocks.listFileActivity.mockReset();
  coreMocks.listFileActivity.mockReturnValue([]);
  coreMocks.matchesProjectIdentity.mockClear();
  coreMocks.listSessionAliases.mockReset();
  coreMocks.listSessionAliases.mockReturnValue([]);
  // Successful alias reads are cached for the process lifetime; tests stub
  // listSessionAliases per case and need a fresh load each time.
  invalidateAliasView();
  coreMocks.executeSessionSearch.mockReset();
  coreMocks.executeSessionSearch.mockReturnValue([]);
  vi.useRealTimers();
});

describe("handleGetAgents", () => {
  it("returns agent info list", () => {
    const c = makeMockContext();
    handleGetAgents(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response)).toBe(true);
    expect(response.find((agent: { name: string }) => agent.name === "claudecode")).toMatchObject({
      resumeCommandPrefix: "claude --resume",
    });
    expect(response.find((agent: { name: string }) => agent.name === "cursor")).toMatchObject({
      resumeCommandPrefix: null,
    });
  });

  it("keeps the registered catalog while zeroing counts outside the current window", () => {
    const c = makeMockContext();
    const now = Date.now();
    const old = makeSession("old", {
      reference: { agentName: "codex", sessionId: "old" },
      time_created: now - 30 * 86400000,
      time_updated: now - 30 * 86400000,
    });
    const recent = makeSession("recent", {
      reference: { agentName: "claudecode", sessionId: "recent" },
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
    expect(response.map((agent: { name: string }) => agent.name)).toEqual(
      AGENT_CATALOG.map(({ name }) => name),
    );
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

  it("reuses agent counts for the same snapshot and window", () => {
    const source = makeScanSource();
    const first = makeMockContext();
    const second = makeMockContext();

    handleGetAgents(first, source);
    handleGetAgents(second, source);

    expect(second.json.mock.calls[0]![0]).toBe(first.json.mock.calls[0]![0]);
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

  it("omits server-only metadata from list responses", () => {
    const session = makeSession("usage", {
      model_usage: { "gpt-5.5": 120 },
      project_identity_resolver_revision: "resolver-v2",
      project_identity_input_signature: "signature",
      smart_tags_source_updated_at: 123,
      smart_tags_classifier_revision: "classifier-v2",
    });
    const source = makeScanSource({
      sessions: [session],
      byAgent: { claudecode: [session] },
    });
    const c = makeMockContext();

    handleGetSessions(c, source);

    const response = c.json.mock.calls[0]![0].sessions[0];
    expect(response).not.toHaveProperty("model_usage");
    expect(response).not.toHaveProperty("project_identity_resolver_revision");
    expect(response).not.toHaveProperty("project_identity_input_signature");
    expect(response).not.toHaveProperty("smart_tags_source_updated_at");
    expect(response).not.toHaveProperty("smart_tags_classifier_revision");
    expect(session.model_usage).toEqual({ "gpt-5.5": 120 });
  });

  it("returns cursor pages without changing legacy unpaged requests", () => {
    const sessions = [makeSession("first"), makeSession("second"), makeSession("third")];
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext({ query: { limit: "2" } });

    handleGetSessions(firstContext, source);

    const firstPage = firstContext.json.mock.calls[0]![0];
    expect(firstPage.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "first",
      "second",
    ]);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondContext = makeMockContext({
      query: { limit: "2", cursor: firstPage.nextCursor },
    });
    handleGetSessions(secondContext, source);

    expect(secondContext.json.mock.calls[0]![0]).toEqual({ sessions: [sessions[2]] });

    const legacyContext = makeMockContext();
    handleGetSessions(legacyContext, source);
    expect(legacyContext.json.mock.calls[0]![0].sessions).toHaveLength(3);
  });

  it("rejects a cursor after the scan snapshot changes", () => {
    const initialSessions = [makeSession("first"), makeSession("second")];
    let snapshot = makeScanResult({
      sessions: initialSessions,
      byAgent: { claudecode: initialSessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    const firstContext = makeMockContext({ query: { limit: "1" } });
    handleGetSessions(firstContext, source);
    const cursor = firstContext.json.mock.calls[0]![0].nextCursor;

    const updatedSessions = [makeSession("new"), ...initialSessions];
    snapshot = makeScanResult({
      sessions: updatedSessions,
      byAgent: { claudecode: updatedSessions },
    });
    const nextContext = makeMockContext({ query: { limit: "1", cursor } });
    handleGetSessions(nextContext, source);

    expect(nextContext.json).toHaveBeenCalledWith(
      { error: "session snapshot changed; restart pagination" },
      409,
    );
  });

  it("rejects invalid pagination parameters", () => {
    const invalidLimit = makeMockContext({ query: { limit: "many" } });
    handleGetSessions(invalidLimit, makeScanSource());
    expect(invalidLimit.json).toHaveBeenCalledWith(
      { error: "limit must be a positive integer" },
      400,
    );

    const invalidCursor = makeMockContext({ query: { cursor: "not-a-cursor" } });
    handleGetSessions(invalidCursor, makeScanSource());
    expect(invalidCursor.json).toHaveBeenCalledWith(
      { error: "cursor is invalid for this request" },
      400,
    );
  });

  it("reuses filtered candidates across pages from the same snapshot", () => {
    const sessions = [
      makeSession("first", {
        project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
      }),
      makeSession("second", {
        project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
      }),
    ];
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext({
      query: { limit: "1", projectKind: "path", projectKey: "/workspace" },
    });
    handleGetSessions(firstContext, source);

    const nextContext = makeMockContext({
      query: {
        limit: "1",
        cursor: firstContext.json.mock.calls[0]![0].nextCursor,
        projectKind: "path",
        projectKey: "/workspace",
      },
    });
    handleGetSessions(nextContext, source);

    expect(coreMocks.matchesProjectIdentity).toHaveBeenCalledTimes(sessions.length);
  });

  it("filters by agent", () => {
    const c = makeMockContext({ query: { agent: "claudecode" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(2);
  });

  it("returns no sessions when the requested agent is unknown", () => {
    const c = makeMockContext({ query: { agent: "nonexistent" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toEqual([]);
  });

  it("normalizes the requested agent case", () => {
    const c = makeMockContext({ query: { agent: "ClaudeCode" } });

    handleGetSessions(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].sessions).toHaveLength(2);
  });

  it("filters by q (title search)", () => {
    const c = makeMockContext({ query: { q: "s1" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].reference.sessionId).toBe("s1");
  });

  it("projects a persisted alias without changing the source title", () => {
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        alias: "Fix session cache refresh",
        updatedAt: Date.now(),
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

  it("uses the structured reference to resolve aliases", () => {
    const session = {
      ...makeSession("legacy", {
        reference: { agentName: "unknown", sessionId: "legacy" },
      }),
    };
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "unknown", sessionId: "legacy" },
        alias: "Legacy alias",
        updatedAt: 1,
      },
    ]);
    const c = makeMockContext();

    handleGetSessions(
      c,
      makeScanSource({ sessions: [session], byAgent: { claudecode: [session] } }),
    );

    expect(c.json.mock.calls[0]![0].sessions[0].display_title).toBe("Legacy alias");
  });

  it("filters by cwd using project scope match", async () => {
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
    const resolver = makeProjectIdentityResolver();
    await handleGetSessions(
      c,
      makeScanSource({ sessions, byAgent: { claudecode: sessions } }),
      {},
      resolver,
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "exact",
      "child",
      "parent",
      "identity",
    ]);
    expect(resolver.resolve).toHaveBeenCalledWith("/home/user/project", expect.any(AbortSignal));
  });

  it("returns 429 when project identity capacity is exhausted", async () => {
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockRejectedValue(new ProjectIdentityQueueFullError());

    await handleGetSessions(c, makeScanSource(), {}, resolver);

    expect(c.json).toHaveBeenCalledWith({ error: "Project scope busy; retry later" }, 429);
  });

  it("returns 503 when project identity resolution fails", async () => {
    const c = makeMockContext({ query: { cwd: "/home/user/project" } });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockRejectedValue(new Error("worker failed"));

    await handleGetSessions(c, makeScanSource(), {}, resolver);

    expect(c.json).toHaveBeenCalledWith({ error: "Project scope unavailable" }, 503);
  });

  it("propagates request cancellation into project identity resolution", async () => {
    const controller = new AbortController();
    const c = makeMockContext({
      query: { cwd: "/home/user/project" },
      signal: controller.signal,
    });
    const resolver = makeProjectIdentityResolver();
    vi.mocked(resolver.resolve).mockImplementation(
      async (_cwd, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new ProjectIdentityRequestAbortedError()),
            { once: true },
          );
        }),
    );

    const response = handleGetSessions(c, makeScanSource(), {}, resolver);
    controller.abort();

    await expect(response).rejects.toBeInstanceOf(ProjectIdentityRequestAbortedError);
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
    expect(response.sessions.map((session: SessionHead) => session.reference.sessionId)).toEqual([
      "a",
    ]);
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
    expect(response.sessions[0].reference.sessionId).toBe("new");
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
    expect(response.sessions[0].reference.sessionId).toBe("old-active");
  });

  it("rejects an invalid from date", () => {
    const c = makeMockContext({ query: { from: "not-a-date" } });
    handleGetSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "from must be a valid date" }, 400);
  });

  it("rejects a date window whose start is after its end", () => {
    const c = makeMockContext({ query: { from: "2026-08-13", to: "2026-08-12" } });
    handleGetSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "from must not be after to" }, 400);
  });
});

describe("handleSearchSessions", () => {
  it("maps HTTP query params into a query string, SearchOptions, and the scan snapshot, then returns the module's results", () => {
    const scanSource = makeScanSource();
    const sentinelResults = [
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        session: makeSession("s1"),
      },
    ];
    coreMocks.executeSessionSearch.mockReturnValue(sentinelResults);

    const c = makeMockContext({
      query: {
        q: " needle ",
        agent: "ClaudeCode",
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

  it("resolves a cwd qualifier before delegating the search", async () => {
    const scanSource = makeScanSource();
    const c = makeMockContext({ query: { q: "cwd:/home/user/project needle" } });
    const resolver = makeProjectIdentityResolver();

    await handleSearchSessions(c, scanSource, {}, resolver);

    expect(resolver.resolve).toHaveBeenCalledWith("/home/user/project", expect.any(AbortSignal));
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "cwd:/home/user/project needle",
      expect.objectContaining({
        projectScope: {
          identity: { kind: "path", key: "/home/user/project" },
          path: "/home/user/project",
        },
      }),
      scanSource.getSnapshot(),
    );
  });

  it("keeps ranked search hits when alias matches fill the limit", () => {
    const rankedSessions = ["ranked-1", "ranked-2", "ranked-3"].map((id) =>
      makeSession(id, { reference: { agentName: "claudecode", sessionId: id } }),
    );
    const aliasSessions = ["alias-1", "alias-2", "alias-3"].map((id, index) =>
      makeSession(id, {
        reference: { agentName: "claudecode", sessionId: id },
        time_updated: 3_000 - index,
      }),
    );
    coreMocks.executeSessionSearch.mockReturnValue(
      rankedSessions.map((session) => ({
        reference: { agentName: "claudecode", sessionId: session.reference.sessionId },
        session,
      })),
    );
    coreMocks.listSessionAliases.mockReturnValue(
      aliasSessions.map((session) =>
        makeAlias(
          "claudecode",
          session.reference.sessionId,
          `Needle ${session.reference.sessionId}`,
        ),
      ),
    );
    const sessions = [...rankedSessions, ...aliasSessions];
    const c = makeMockContext({ query: { q: "needle", limit: "3" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    expect(
      c.json.mock.calls[0]![0].results.map(
        (result: SearchResult) => result.session.reference.sessionId,
      ),
    ).toEqual(["ranked-1", "ranked-2", "alias-1"]);
  });

  it("keeps ranked order and value when an alias hit overlaps", () => {
    const rankedSessions = ["ranked-1", "ranked-2", "ranked-3"].map((id) =>
      makeSession(id, { reference: { agentName: "claudecode", sessionId: id } }),
    );
    const aliasOnly = makeSession("alias-1", {
      reference: { agentName: "claudecode", sessionId: "alias-1" },
      time_updated: 1,
    });
    coreMocks.executeSessionSearch.mockReturnValue(
      rankedSessions.map((session) => ({
        reference: { agentName: "claudecode", sessionId: session.reference.sessionId },
        session,
        snippet: "Ranked match",
        snippetHighlights: [],
        matchType: "assistant_reply" as const,
      })),
    );
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "ranked-2", "Needle overlap"),
      makeAlias("claudecode", "alias-1", "Needle alias"),
    ]);
    const sessions = [...rankedSessions, aliasOnly];
    const c = makeMockContext({ query: { q: "needle", limit: "3" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    const results = c.json.mock.calls[0]![0].results as SearchResult[];
    expect(results.map((result) => result.session.reference.sessionId)).toEqual([
      "ranked-1",
      "ranked-2",
      "alias-1",
    ]);
    expect(results[1]?.matchType).toBe("assistant_reply");
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

  it.each(["1.5", "0", "-1", "", "Infinity", "invalid"])(
    "rejects invalid search limit %j before executing search",
    (limit) => {
      const c = makeMockContext({ query: { q: "needle", limit } });

      handleSearchSessions(c, makeScanSource());

      expect(c.json).toHaveBeenCalledWith({ error: "limit must be a positive integer" }, 400);
      expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
    },
  );

  it("caps an oversized integer search limit", () => {
    const c = makeMockContext({ query: { q: "needle", limit: "999999999999999999999" } });

    handleSearchSessions(c, makeScanSource());

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
    );
  });

  it("returns no search results for an unknown agent without executing search", () => {
    const c = makeMockContext({ query: { q: "needle", agent: "nonexistent" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ results: [] });
    expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
  });

  it("matches aliases while preserving an agent: qualifier embedded in q, calling the search module only once", () => {
    const cursorSession = makeSession("c1", {
      reference: { agentName: "cursor", sessionId: "c1" },
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
      makeAlias("cursor", "c1", "Custom cache from cursor"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "agent:claudecode custom cache" } });

    handleSearchSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("s1", {
            reference: { agentName: "claudecode", sessionId: "s1" },
          }),
          cursorSession,
        ],
        byAgent: {
          claudecode: [
            makeSession("s1", {
              reference: { agentName: "claudecode", sessionId: "s1" },
            }),
          ],
          cursor: [cursorSession],
        },
      }),
    );

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledTimes(1);
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "agent:claudecode custom cache",
      expect.anything(),
      expect.anything(),
    );
    const results = c.json.mock.calls[0]![0].results;
    expect(results).toHaveLength(1);
    expect(results[0].session.display_title).toBe("Custom cache title");
    expect(results[0].matchType).toBe("title");
  });

  it("finds alias matches by scanning the alias map, not the full session list", () => {
    const sessions = Array.from({ length: 1001 }, (_, index) =>
      makeSession(`s${index}`, {
        reference: { agentName: "claudecode", sessionId: `s${index}` },
      }),
    );
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "s1000", "Old alias")]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "old alias" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    // Only one search call regardless of how many sessions exist -- alias
    // matching no longer re-runs executeSessionSearch with limit = session count.
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledTimes(1);
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "old alias",
      expect.objectContaining({ limit: 50 }),
      expect.anything(),
    );
    expect(c.json.mock.calls[0]![0].results[0].session.reference.sessionId).toBe("s1000");
  });

  it("excludes alias hits outside the requested time window", () => {
    const now = Date.now();
    const oldSession = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      time_created: now - 30 * 86400000,
      time_updated: now - 30 * 86400000,
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({
      query: {
        q: "custom cache",
        from: new Date(now - 86400000).toISOString(),
        to: new Date(now).toISOString(),
      },
    });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [oldSession], byAgent: { claudecode: [oldSession] } }),
    );

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("excludes alias hits from an agent other than the requested agent filter", () => {
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "custom cache", agent: "cursor" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("excludes alias hits outside the requested project identity", () => {
    const session = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({
      query: {
        q: "custom cache",
        projectKind: "git_remote",
        projectKey: "github.com/other/app",
      },
    });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [session], byAgent: { claudecode: [session] } }),
    );

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("attaches the parent title to a sub-session hit and omits it when the parent is missing", () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    const mounted = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
    });
    const orphan = makeSession("c2", {
      reference: { agentName: "claudecode", sessionId: "c2" },
      parent_reference: { agentName: "claudecode", sessionId: "gone" },
    });
    coreMocks.executeSessionSearch.mockReturnValue([
      { reference: { agentName: "claudecode", sessionId: "c1" }, session: mounted },
      { reference: { agentName: "claudecode", sessionId: "c2" }, session: orphan },
    ]);
    const c = makeMockContext({ query: { q: "needle" } });

    handleSearchSessions(
      c,
      makeScanSource({
        sessions: [parent, mounted, orphan],
        byAgent: { claudecode: [parent, mounted, orphan] },
      }),
    );

    const results = c.json.mock.calls[0]![0].results;
    expect(results[0].parent).toEqual({
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    expect(results[1]).not.toHaveProperty("parent");
  });

  it("uses the parent's alias as its parent-context title", () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    const child = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
    });
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "p1", "Renamed parent")]);
    coreMocks.executeSessionSearch.mockReturnValue([
      { reference: { agentName: "claudecode", sessionId: "c1" }, session: child },
    ]);
    const c = makeMockContext({ query: { q: "needle" } });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [parent, child], byAgent: { claudecode: [parent, child] } }),
    );

    expect(c.json.mock.calls[0]![0].results[0].parent.title).toBe("Renamed parent");
  });

  it("reuses one snapshot tree for cost, alias, and parent context", async () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });
    const child = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 2,
      },
    });
    const sessions = [parent, child];
    let snapshot = makeScanResult({
      sessions,
      byAgent: { claudecode: sessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "p1", "Needle parent")]);
    coreMocks.executeSessionSearch.mockImplementation((_query, _options, _scanResult, context) => {
      expect((context as { sessionTree?: unknown } | undefined)?.sessionTree).toBeDefined();
      return [{ reference: { agentName: "claudecode", sessionId: "c1" }, session: child }];
    });

    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);
    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);

    expect(coreMocks.buildSessionTree).toHaveBeenCalledTimes(1);
    const searchContext = coreMocks.executeSessionSearch.mock.calls[0]![3] as {
      sessionTree: unknown;
    };
    expect(coreMocks.filterSessionSearchCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        sessionSnapshot: sessions,
        sessionTree: searchContext.sessionTree,
      }),
    );

    const replacementSessions = [...sessions];
    snapshot = makeScanResult({
      sessions: replacementSessions,
      byAgent: { claudecode: replacementSessions },
    });
    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);

    expect(coreMocks.buildSessionTree).toHaveBeenCalledTimes(2);
  });
});

describe("handleGetFileActivity", () => {
  it("projects aliases onto nested sessions", () => {
    const session = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      model_usage: { "gpt-5.5": 5 },
      smart_tags_source_updated_at: 2,
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

    handleGetFileActivity(c);

    const responseSession = c.json.mock.calls[0]![0].activity[0].session;
    expect(responseSession.display_title).toBe("Activity alias");
    expect(responseSession).not.toHaveProperty("model_usage");
    expect(responseSession).not.toHaveProperty("smart_tags_source_updated_at");
  });
});

describe("handleGetProjects", () => {
  it("bounds every response and keeps catalog totals outside the page", () => {
    const sessions = Array.from({ length: 101 }, (_, index) =>
      makeSession(`project-${index}`, {
        time_updated: 1_000 - index,
        project_identity: {
          kind: "path",
          key: `/workspace/${index}`,
          displayName: `project-${index}`,
        },
      }),
    );
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext();

    handleGetProjects(firstContext, source);

    const firstPage = firstContext.json.mock.calls[0]![0];
    expect(firstPage.projects).toHaveLength(100);
    expect(firstPage.summary).toMatchObject({ projects: 101, sessions: 101 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondContext = makeMockContext({ query: { cursor: firstPage.nextCursor } });
    handleGetProjects(secondContext, source);

    expect(secondContext.json.mock.calls[0]![0]).toEqual({
      projects: [expect.objectContaining({ identityKey: "/workspace/100" })],
      summary: expect.objectContaining({ projects: 101, sessions: 101 }),
    });
  });

  it("rejects a project cursor after the scan snapshot changes", () => {
    const initialSessions = [
      makeSession("one", {
        project_identity: { kind: "path", key: "/workspace/one", displayName: "one" },
      }),
      makeSession("two", {
        project_identity: { kind: "path", key: "/workspace/two", displayName: "two" },
      }),
    ];
    let snapshot = makeScanResult({
      sessions: initialSessions,
      byAgent: { claudecode: initialSessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    const firstContext = makeMockContext({ query: { limit: "1" } });
    handleGetProjects(firstContext, source);
    const cursor = firstContext.json.mock.calls[0]![0].nextCursor;

    const updatedSessions = [
      makeSession("new", {
        project_identity: { kind: "path", key: "/workspace/new", displayName: "new" },
      }),
      ...initialSessions,
    ];
    snapshot = makeScanResult({
      sessions: updatedSessions,
      byAgent: { claudecode: updatedSessions },
    });
    const nextContext = makeMockContext({ query: { limit: "1", cursor } });

    handleGetProjects(nextContext, source);

    expect(nextContext.json).toHaveBeenCalledWith(
      { error: "project snapshot changed; restart pagination" },
      409,
    );
  });

  it("looks up one project without expanding the catalog page", () => {
    const sessions = [
      makeSession("one", {
        project_identity: { kind: "path", key: "/workspace/one", displayName: "one" },
      }),
      makeSession("two", {
        project_identity: { kind: "path", key: "/workspace/two", displayName: "two" },
      }),
    ];
    const c = makeMockContext({
      query: { projectKind: "path", projectKey: "/workspace/two" },
    });

    handleGetProjects(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    expect(c.json.mock.calls[0]![0]).toEqual({
      projects: [expect.objectContaining({ identityKey: "/workspace/two" })],
      summary: expect.objectContaining({ projects: 1, sessions: 1 }),
    });
  });

  it("rejects invalid project pagination parameters", () => {
    const invalidLimit = makeMockContext({ query: { limit: "many" } });
    handleGetProjects(invalidLimit, makeScanSource());
    expect(invalidLimit.json).toHaveBeenCalledWith(
      { error: "limit must be a positive integer" },
      400,
    );

    const invalidCursor = makeMockContext({ query: { cursor: "not-a-cursor" } });
    handleGetProjects(invalidCursor, makeScanSource());
    expect(invalidCursor.json).toHaveBeenCalledWith(
      { error: "cursor is invalid for this request" },
      400,
    );
  });

  it("reuses project aggregation for the same snapshot and window", () => {
    const source = makeScanSource();

    handleGetProjects(makeMockContext(), source);
    handleGetProjects(makeMockContext(), source);

    expect(coreMocks.attachProjectMetrics).toHaveBeenCalledTimes(1);
  });

  it("retains a recently used aggregation when the cache reaches capacity", () => {
    const source = makeScanSource();
    const queryFor = (day: number) => ({
      from: new Date(0).toISOString(),
      to: new Date((day + 1) * 86400000).toISOString(),
    });

    for (let day = 0; day < 64; day += 1) {
      handleGetProjects(makeMockContext({ query: queryFor(day) }), source);
    }
    handleGetProjects(makeMockContext({ query: queryFor(0) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(64) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(0) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(1) }), source);

    expect(coreMocks.attachProjectMetrics).toHaveBeenCalledTimes(66);
  });

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

  it("includes a project whose message cost falls inside the window", () => {
    const session = makeSession("long-lived", {
      time_created: 100,
      time_updated: 300,
      project_identity: { kind: "git_remote", key: "repo-a", displayName: "Repo A" },
      stats: {
        message_count: 1,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 2,
        cost_source: "estimated",
      },
    });
    coreMocks.listDashboardCostFacts.mockReturnValue({
      sessions: [
        {
          reference: { agentName: "agent", sessionId: session.reference.sessionId },
          messageCount: 1,
          untimedMessageCount: 0,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          untimedInputTokens: 0,
          untimedOutputTokens: 0,
          untimedReasoningTokens: 0,
          untimedCacheReadTokens: 0,
          untimedCacheCreateTokens: 0,
          messageCost: 2,
          untimedMessageCost: 0,
          modelCosts: [],
        },
      ],
      messages: [
        {
          reference: { agentName: "agent", sessionId: session.reference.sessionId },
          time: 150,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          cost: 2,
          costSource: "estimated",
        },
      ],
    });
    const c = makeMockContext({
      query: { from: new Date(100).toISOString(), to: new Date(200).toISOString() },
    });

    handleGetProjects(c, makeScanSource({ sessions: [session], byAgent: { agent: [session] } }));

    expect(c.json.mock.calls[0]![0].projects).toEqual([
      expect.objectContaining({
        identityKey: "repo-a",
        sessionCount: 0,
        messages: 1,
        tokens: 15,
        cost: 2,
      }),
    ]);
  });

  it("returns project groups sorted by recent activity", () => {
    const sessions = [
      makeSession("a", {
        reference: { agentName: "claudecode", sessionId: "a" },
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
        reference: { agentName: "codex", sessionId: "b" },
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

describe("handleGetSessionData", () => {
  it("returns a retryable response when detail workers are at capacity", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });
    const header = vi.fn();
    Object.assign(c, { header });
    await handleGetSessionData(c, makeScanSource(), async () => {
      throw new SessionDetailBusyError();
    });
    expect(c.json).toHaveBeenCalledWith({ error: "Session details busy; retry later" }, 503);
    expect(header).toHaveBeenCalledWith("Retry-After", "1");
  });

  const detail: SessionDetail = {
    reference: { agentName: "claudecode", sessionId: "s1" },
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
    project_identity: {
      kind: "path",
      key: "/home/user/project",
      displayName: "project",
    },
    smart_tags: [],
    smart_tags_source_updated_at: 1000,
    file_activity: [],
  };

  it("maps materialized session data to JSON", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "found", data: detail });
    const scanSource = makeScanSource();
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(c, scanSource);

    expect(coreMocks.materializeSessionDetailResponse).toHaveBeenCalledWith(
      scanSource.getSnapshot(),
      {
        agentName: "claudecode",
        sessionId: "s1",
      },
      {},
      c.req.raw.signal,
    );
    expect(c.json).toHaveBeenCalledWith(detail);
  });

  it("forwards an incremental message cursor to detail materialization", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "found", data: detail });
    const scanSource = makeScanSource();
    const c = makeMockContext({
      param: { agent: "claudecode", id: "s1" },
      query: { messageCursor: "known-prefix" },
    });

    await handleGetSessionData(c, scanSource);

    expect(coreMocks.materializeSessionDetailResponse).toHaveBeenCalledWith(
      scanSource.getSnapshot(),
      { agentName: "claudecode", sessionId: "s1" },
      { messageCursor: "known-prefix" },
      c.req.raw.signal,
    );
  });

  it("streams cached message JSON lazily while preserving aliases", async () => {
    const { messages: _messages, ...detailHeader } = detail;
    let serializedMessages = 0;
    function* messages() {
      for (let index = 0; index < 200; index += 1) {
        serializedMessages += 1;
        yield JSON.stringify({
          id: `m${index}`,
          role: "assistant",
          agent: null,
          time_created: 1000,
          time_completed: null,
          mode: null,
          model: null,
          provider: null,
          parts: [{ type: "text", text: "cached".repeat(100) }],
        });
      }
    }
    coreMocks.listSessionAliases.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        alias: "Local Alias",
        updatedAt: 1000,
      },
    ]);
    coreMocks.materializeSessionDetailResponse.mockReturnValue({
      status: "found-json",
      data: detailHeader,
      messages: messages(),
      messageCount: 200,
      sentMessageCount: 200,
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    const response = await handleGetSessionData(c, makeScanSource());

    expect(response).toBeInstanceOf(Response);
    expect(serializedMessages).toBe(0);
    expect(c.json).not.toHaveBeenCalled();
    const reader = (response as Response).body!.getReader();
    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let json = "";
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      json += decoder.decode(result.value, { stream: true });
    }
    json += decoder.decode();
    const payload = JSON.parse(json);
    expect(payload.reference).toEqual({ agentName: "claudecode", sessionId: "s1" });
    expect(payload.display_title).toBe("Local Alias");
    expect(payload.messages[0].id).toBe("m0");
    expect(payload.messages).toHaveLength(200);
    expect(chunks.length).toBeLessThan(10);
    expect(serializedMessages).toBe(200);
  });

  it("errors the response body and closes iteration when cached message reads fail", async () => {
    const { messages: _messages, ...detailHeader } = detail;
    const iterator = {
      next: vi
        .fn()
        .mockReturnValueOnce({ done: false, value: JSON.stringify({ id: "m1" }) })
        .mockImplementationOnce(() => {
          throw new Error("cached message read failed");
        }),
      return: vi.fn(() => ({ done: true, value: undefined })),
    };
    coreMocks.materializeSessionDetailResponse.mockReturnValue({
      status: "found-json",
      data: detailHeader,
      messages: { [Symbol.iterator]: () => iterator },
      messageCount: 2,
      sentMessageCount: 2,
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    const response = (await handleGetSessionData(c, makeScanSource())) as Response;

    await expect(response.text()).rejects.toThrow("cached message read failed");
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it("returns 400 when agent name is missing", async () => {
    const c = makeMockContext({ param: { agent: "", id: "s1" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Missing agent name" }, 400);
    expect(coreMocks.materializeSessionDetailResponse).not.toHaveBeenCalled();
  });

  it("returns 400 when session ID is missing", async () => {
    const c = makeMockContext({ param: { agent: "claudecode", id: "" } });
    await handleGetSessionData(c, makeScanSource());
    expect(c.json).toHaveBeenCalledWith({ error: "Missing session ID" }, 400);
    expect(coreMocks.materializeSessionDetailResponse).not.toHaveBeenCalled();
  });

  it("maps an unknown agent to 404", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "unknown-agent" });
    const c = makeMockContext({ param: { agent: "unknown", id: "s1" } });

    await handleGetSessionData(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "Unknown agent: unknown" }, 404);
  });

  it("maps unavailable detail to 404", async () => {
    coreMocks.materializeSessionDetailResponse.mockReturnValue({ status: "not-ready" });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    await handleGetSessionData(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ error: "Session cache not ready" }, 404);
  });

  it("maps materialization errors to 500", async () => {
    const errorSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
    coreMocks.materializeSessionDetailResponse.mockImplementation(() => {
      throw new Error("ENOENT: open '/Users/private/.claude/session.json'");
    });
    const c = makeMockContext({ param: { agent: "claudecode", id: "s1" } });

    try {
      await handleGetSessionData(c, makeScanSource());

      expect(c.json).toHaveBeenCalledWith({ error: "Failed to load session" }, 500);
      expect(errorSpy).toHaveBeenCalledWith(
        "api.session_data.error",
        expect.objectContaining({ error: "ENOENT: open '/Users/private/.claude/session.json'" }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
