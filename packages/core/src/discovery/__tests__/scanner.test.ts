import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IdentifiedSessionHead, SessionDetail, SessionHead } from "../../types/index.js";
import {
  BaseAgent,
  FileSystemSessionSource,
  SessionScanError,
  type ChangeCheckResult,
  type SessionCacheMeta,
  type SessionSourceRef,
} from "../../agents/base.js";
import { filterSessions } from "../scanner.js";
import { computeIdentityProjection, realFs } from "../../projects/index.js";
import { setCoreDiagnostics } from "../../utils/diagnostics.js";

// --- filterSessions tests (pure function) ---

function makeSession(
  id: string,
  overrides?: Partial<SessionHead>,
  agentName = "test",
): SessionHead {
  const timeCreated = overrides?.time_created ?? 1000;
  return {
    reference: { agentName, sessionId: id },
    id,
    slug: `${agentName}/${id}`,
    title: `Session ${id}`,
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

function withCurrentIdentity(session: SessionHead): IdentifiedSessionHead {
  const projection = computeIdentityProjection(session.directory, realFs);
  return {
    ...session,
    project_identity: projection.identity,
    project_identity_resolver_revision: projection.resolverRevision,
    project_identity_input_signature: projection.inputSignature,
  };
}

class TestAgent extends BaseAgent {
  private meta: Record<string, SessionCacheMeta> = {};
  readonly name = "test";
  readonly displayName = "test";
  readonly sessionSourceAccess = {
    kind: "aggregate" as const,
    checkForChanges: (sinceTimestamp: number, cachedSessions: SessionHead[]) =>
      this.checkForChanges(sinceTimestamp, cachedSessions),
    commitChangeCheck: () => this.commitChangeCheck(),
    incrementalScan: (
      cachedSessions: SessionHead[],
      changedIds: string[],
      refs?: SessionSourceRef[],
      scanOptions?: Parameters<TestAgent["incrementalScan"]>[3],
    ) => this.incrementalScan(cachedSessions, changedIds, refs, scanOptions),
  };

  isAvailable(): boolean {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(): SessionDetail {
    return {} as SessionDetail;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "scanner test adapter" };
  }

  checkForChanges(_sinceTimestamp?: number, _cachedSessions?: SessionHead[]): ChangeCheckResult {
    return { hasChanges: false, changedIds: [], timestamp: Date.now() };
  }

  commitChangeCheck(): void {}

  incrementalScan(
    cached: SessionHead[],
    _changedIds?: string[],
    _refs?: SessionSourceRef[],
    _scanOptions?: Parameters<BaseAgent["scan"]>[0],
  ): SessionHead[] {
    return cached;
  }

  getSessionCacheMeta(sessionId: string): SessionCacheMeta | undefined {
    return this.meta[sessionId];
  }

  snapshotSessionCacheMeta(): Record<string, SessionCacheMeta> {
    return { ...this.meta };
  }

  restoreSessionCacheMeta(meta: Readonly<Record<string, SessionCacheMeta>>): void {
    this.meta = { ...meta };
  }

  removeSessionCacheMeta(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) delete this.meta[sessionId];
  }
}

class FailingFileAgent extends FileSystemSessionSource {
  readonly name = "files";
  readonly displayName = "Files";

  isAvailable(): boolean {
    return true;
  }

  listSessionSources(): SessionSourceRef[] {
    return [{ sessionId: "cached", sourcePath: "/cached.jsonl", fingerprint: "new" }];
  }

  scanSessionSource(): SessionHead | null {
    throw new SyntaxError("Unexpected end of JSON input");
  }

  getSessionData(): SessionDetail {
    return {} as SessionDetail;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "scanner test adapter" };
  }
}

describe("filterSessions", () => {
  it("returns all sessions when no filters", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    expect(filterSessions(sessions, {})).toHaveLength(2);
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
    const result = filterSessions(sessions, { cwd: "/home/user/project" });
    expect(result.map((s) => s.id)).toEqual(["exact", "child", "parent", "identity"]);
  });

  it("filters by cwd excluding non-matching directories", () => {
    const sessions = [
      makeSession("a", { directory: "/home/user/project" }),
      makeSession("b", { directory: "/home/user/other" }),
    ];
    const result = filterSessions(sessions, { cwd: "/home/user/other" });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("b");
  });

  it("returns empty when cwd matches nothing", () => {
    const sessions = [makeSession("a", { directory: "/home/user/project" })];
    const result = filterSessions(sessions, { cwd: "/home/user/nothing" });
    expect(result).toHaveLength(0);
  });

  it("filters by from timestamp", () => {
    const sessions = [
      makeSession("a", { time_created: 100 }),
      makeSession("b", { time_created: 200 }),
      makeSession("c", { time_created: 300 }),
    ];
    const result = filterSessions(sessions, { from: 200 });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["b", "c"]);
  });

  it("filters by to timestamp", () => {
    const sessions = [
      makeSession("a", { time_created: 100 }),
      makeSession("b", { time_created: 200 }),
      makeSession("c", { time_created: 300 }),
    ];
    const result = filterSessions(sessions, { to: 200 });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("filters by activity timestamp", () => {
    const sessions = [
      makeSession("old", { time_created: 100, time_updated: 150 }),
      makeSession("active", { time_created: 100, time_updated: 300 }),
    ];
    const result = filterSessions(sessions, { from: 200 });
    expect(result.map((s) => s.id)).toEqual(["active"]);
  });

  it("combines cwd and time filters", () => {
    const sessions = [
      makeSession("a", { directory: "/home/user/project", time_created: 100 }),
      makeSession("b", { directory: "/home/user/project", time_created: 300 }),
      makeSession("c", { directory: "/home/user/other", time_created: 200 }),
    ];
    const result = filterSessions(sessions, { cwd: "/home/user/project", from: 200 });
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("b");
  });

  it("returns empty for null directory with cwd filter", () => {
    const sessions = [makeSession("a", { directory: null as any })];
    const result = filterSessions(sessions, { cwd: "/home/user/project" });
    expect(result).toHaveLength(0);
  });
});

// --- scanSessions integration tests ---
// Mock cache and perf to isolate scanner logic

vi.mock("../cache/sessions.js", () => ({
  loadCachedSessions: vi.fn(() => null),
  markAgentCacheInitialized: vi.fn(),
  markAgentFullSyncCompleted: vi.fn(),
  saveCachedSessionChanges: vi.fn(),
  saveCachedSessions: vi.fn(),
}));

vi.mock("../../utils/index.js", () => ({
  classifySessionTags: vi.fn(() => []),
  getSmartTagSourceTimestamp: vi.fn(() => 1000),
  SMART_TAG_CLASSIFIER_REVISION: "smart-tags-v1",
  perf: {
    start: vi.fn(() => ({ name: "test", startTime: 0, children: [] })),
    end: vi.fn(),
  },
}));

// Mock createRegisteredAgents to return controlled agents
vi.mock("../../agents/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/index.js")>();
  return { ...actual, createRegisteredAgents: vi.fn(() => []) };
});

import { ensureSessionTagsSync, finalizeAgentScan, scanSessions } from "../scanner.js";
import { createRegisteredAgents } from "../../agents/index.js";
import {
  loadCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "../cache/sessions.js";

const mockedCreateRegisteredAgents = vi.mocked(createRegisteredAgents);
const mockedLoadCachedSessions = vi.mocked(loadCachedSessions);
const mockedSaveCachedSessionChanges = vi.mocked(saveCachedSessionChanges);
const mockedSaveCachedSessions = vi.mocked(saveCachedSessions);

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadCachedSessions.mockReturnValue(null);
  mockedSaveCachedSessionChanges.mockReturnValue(true);
  mockedSaveCachedSessions.mockReturnValue(true);
});

function createTestAgent(overrides: {
  name: string;
  available: boolean;
  sessions: SessionHead[];
  shouldThrow?: boolean;
  checkForChangesResult?: ChangeCheckResult;
  incrementalScanResult?: SessionHead[];
  metaMap?: Map<string, SessionCacheMeta>;
}) {
  const agent = new TestAgent() as any;
  agent.name = overrides.name;
  agent.displayName = overrides.name;
  agent.isAvailable = () => overrides.available;
  agent.scan = () => {
    if (overrides.shouldThrow) throw new Error("scan failed");
    if (overrides.metaMap) agent._metaMap = overrides.metaMap;
    return overrides.sessions;
  };
  agent.getSessionData = () => ({
    id: "s1",
    title: "Session",
    directory: "/repo",
    time_created: 1000,
    messages: [],
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  });
  if (overrides.metaMap) {
    agent.snapshotSessionCacheMeta = () => Object.fromEntries(overrides.metaMap!);
  }
  if (overrides.checkForChangesResult) {
    agent.checkForChanges = () => overrides.checkForChangesResult!;
  }
  if (overrides.incrementalScanResult) {
    agent.incrementalScan = () => overrides.incrementalScanResult!;
  }
  return agent as TestAgent;
}

describe("ensureSessionTagsSync", () => {
  it("separates cache hits, source reads, and tag classification timing", () => {
    const cached = makeSession("cached", {
      smart_tags: [],
      smart_tags_source_updated_at: 1000,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const stale = makeSession("stale", { time_updated: 2000 });
    const agent = createTestAgent({ name: "test", available: true, sessions: [cached, stale] });

    const result = ensureSessionTagsSync(agent, [cached, stale]);

    expect(result.timing).toMatchObject({
      sessions: 2,
      cacheHits: 1,
      staleSessions: 1,
      failedSessions: 0,
      getSessionDataCalls: 1,
      classifySessionTagsCalls: 1,
    });
    expect(result.timing.getSessionDataMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.classifySessionTagsMs).toBeGreaterThanOrEqual(0);
  });

  it("reclassifies unchanged sources produced by an older classifier", () => {
    const cached = makeSession("cached", {
      smart_tags: ["bugfix"],
      smart_tags_source_updated_at: 1000,
      smart_tags_classifier_revision: "smart-tags-v0",
    });
    const agent = createTestAgent({ name: "test", available: true, sessions: [cached] });

    const result = ensureSessionTagsSync(agent, [cached]);

    expect(result.changed).toBe(true);
    expect(result.timing).toMatchObject({ cacheHits: 0, staleSessions: 1 });
    expect(result.sessions[0]).toMatchObject({
      smart_tags: [],
      smart_tags_source_updated_at: 1000,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
  });
});

describe("finalizeAgentScan", () => {
  it("finalizes cache-only sessions without classifying or writing", async () => {
    const sessions = [
      withCurrentIdentity(makeSession("old", { time_created: 100 })),
      withCurrentIdentity(makeSession("current", { time_created: 300 })),
    ];
    const agent = createTestAgent({ name: "test", available: true, sessions });
    agent.getSessionData = vi.fn();
    const onProgress = vi.fn();

    const result = await finalizeAgentScan(agent, sessions, {
      finalization: {
        kind: "cache-only",
        cached: { sessions, meta: {}, timestamp: 123 },
      },
      options: { from: 200, includeSmartTags: true },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "partial",
      onProgress,
    });

    expect(result.heads.map((session) => session.id)).toEqual(["current"]);
    expect(result.heads[0]?.project_identity).toBeDefined();
    expect(result.cachePersistence).toBe("not-requested");
    expect(result.cacheTimestamp).toBe(123);
    expect(agent.getSessionData).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith({
      agent: "test",
      phase: "complete",
      newCount: 2,
    });
  });

  it("persists an incremental diff and marks the result refreshed", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("old"))];
    const updatedSessions = [makeSession("new")];
    const agent = createTestAgent({ name: "test", available: true, sessions: updatedSessions });

    const result = await finalizeAgentScan(agent, updatedSessions, {
      finalization: {
        kind: "incremental",
        cached: { sessions: cachedSessions, meta: {}, timestamp: 123 },
        changedIds: ["new"],
        cacheTimestamp: 456,
      },
      options: { includeSmartTags: false },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(result.refreshed).toBe(true);
    expect(result.cachePersistence).toBe("persisted");
    expect(result.cacheTimestamp).toBe(456);
    expect(mockedSaveCachedSessionChanges).toHaveBeenCalledWith(
      "test",
      [
        {
          session: expect.objectContaining({ id: "new", project_identity: expect.any(Object) }),
          sortIndex: 0,
        },
      ],
      ["old"],
      {},
    );
  });

  it("serves fresh heads without advancing the durable timestamp when an incremental write fails", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("old"))];
    const updatedSessions = [makeSession("new")];
    const agent = createTestAgent({ name: "test", available: true, sessions: updatedSessions });
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    mockedSaveCachedSessionChanges.mockReturnValue(false);
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });

    try {
      const result = await finalizeAgentScan(agent, updatedSessions, {
        finalization: {
          kind: "incremental",
          cached: { sessions: cachedSessions, meta: {}, timestamp: 123 },
          changedIds: ["new"],
          cacheTimestamp: 456,
        },
        options: { includeSmartTags: false },
        timing: { total: 0 },
        agentStart: performance.now(),
        completeness: "complete",
      });

      expect(result.heads.map((session) => session.id)).toEqual(["new"]);
      expect(result.refreshed).toBe(true);
      expect(result.cachePersistence).toBe("failed");
      expect(result.cacheTimestamp).toBe(123);
      expect(events).toContainEqual({
        event: "cache.save_failed",
        detail: { agent: "test", changed_sessions: 1, removed_sessions: 1 },
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("does not advance an incremental durable timestamp when cache writes are disabled", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("old"))];
    const updatedSessions = [makeSession("new")];
    const agent = createTestAgent({ name: "test", available: true, sessions: updatedSessions });

    const result = await finalizeAgentScan(agent, updatedSessions, {
      finalization: {
        kind: "incremental",
        cached: { sessions: cachedSessions, meta: {}, timestamp: 123 },
        changedIds: ["new"],
        cacheTimestamp: 456,
      },
      options: { includeSmartTags: false, writeCache: false },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(result.cachePersistence).toBe("not-requested");
    expect(result.cacheTimestamp).toBe(123);
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
  });

  it("does not rewrite an unchanged cache when tag maintenance is disabled", async () => {
    const sessions = [withCurrentIdentity(makeSession("cached"))];
    const agent = createTestAgent({ name: "test", available: true, sessions });

    const result = await finalizeAgentScan(agent, sessions, {
      finalization: {
        kind: "unchanged",
        cached: { sessions, meta: {}, timestamp: 123 },
      },
      options: { includeSmartTags: false },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(result.refreshed).toBeUndefined();
    expect(result.cacheTimestamp).toBe(123);
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
  });

  it("persists refreshed identity provenance for an otherwise unchanged cache", async () => {
    const sessions = [
      {
        ...withCurrentIdentity(makeSession("cached")),
        project_identity_resolver_revision: "outdated",
        project_identity_input_signature: "outdated",
      },
    ];
    const agent = createTestAgent({ name: "test", available: true, sessions });

    await finalizeAgentScan(agent, sessions, {
      finalization: {
        kind: "unchanged",
        cached: { sessions, meta: {}, timestamp: 123 },
      },
      options: { includeSmartTags: false },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(mockedSaveCachedSessionChanges).toHaveBeenCalledWith(
      "test",
      [
        {
          session: expect.objectContaining({
            id: "cached",
            project_identity_resolver_revision: expect.any(String),
            project_identity_input_signature: expect.any(String),
          }),
          sortIndex: 0,
        },
      ],
      [],
      {},
    );
  });

  it("persists tag maintenance for an otherwise unchanged cache", async () => {
    const sessions = [withCurrentIdentity(makeSession("cached"))];
    const agent = createTestAgent({ name: "test", available: true, sessions });

    const result = await finalizeAgentScan(agent, sessions, {
      finalization: {
        kind: "unchanged",
        cached: { sessions, meta: {}, timestamp: 123 },
      },
      options: {},
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(result.heads[0]).toMatchObject({
      id: "cached",
      smart_tags: [],
      smart_tags_source_updated_at: 1000,
    });
    expect(mockedSaveCachedSessionChanges).toHaveBeenCalledWith(
      "test",
      [
        {
          session: expect.objectContaining({ id: "cached", smart_tags: [] }),
          sortIndex: 0,
        },
      ],
      [],
      {},
    );
  });
});

describe("scanSessions", () => {
  it("returns empty result when no agents registered", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([]);
    const result = await scanSessions({});
    expect(result.sessions).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.byAgent).toEqual({});
  });

  it("skips unavailable agents", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({ name: "unavail", available: false, sessions: [] }),
    ]);
    const result = await scanSessions({});
    expect(result.agents).toHaveLength(0);
  });

  it("retains cached sessions when an agent is unavailable", async () => {
    mockedLoadCachedSessions.mockReturnValue({
      sessions: [withCurrentIdentity(makeSession("cached"))],
      meta: {},
      timestamp: 123,
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({ name: "test", available: false, sessions: [] }),
    ]);
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });

    try {
      const result = await scanSessions({ useCache: true });

      expect(result.sessions.map((session) => session.id)).toEqual(["cached"]);
      expect(result.byAgent.test?.map((session) => session.id)).toEqual(["cached"]);
      expect(result.cacheTimestamps).toEqual({ test: 123 });
      expect(result.scanFailures?.test).toEqual({
        agentName: "test",
        stage: "checking availability",
        errorClass: "AgentUnavailableError",
        message: "Agent test is unavailable",
      });
      expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
      expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        event: "agent.scan_failed",
        detail: expect.objectContaining({
          agent: "test",
          stage: "checking availability",
          error_class: "AgentUnavailableError",
          baseline_retained: true,
        }),
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("scans available agents and returns sessions", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [makeSession("s1"), makeSession("s2")],
      }),
    ]);
    const result = await scanSessions({});
    expect(result.agents).toHaveLength(1);
    expect(result.sessions).toHaveLength(2);
    expect(result.byAgent.test).toHaveLength(2);
  });

  it("reports a scan failure when an adapter publishes a conflicting identity", async () => {
    const conflicting = { ...makeSession("session"), id: "other" };
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({ name: "test", available: true, sessions: [conflicting] }),
    ]);

    const result = await scanSessions({});

    expect(result.byAgent.test).toBeUndefined();
    expect(result.scanFailures?.test).toMatchObject({
      agentName: "test",
      stage: "scanning sessions",
      message: "Session identity fields disagree",
    });
  });

  it("handles scan errors gracefully", async () => {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "error",
        available: true,
        sessions: [],
        shouldThrow: true,
      }),
    ]);
    try {
      const result = await scanSessions({});
      expect(result.agents).toHaveLength(1);
      expect(result.byAgent.error).toBeUndefined();
      expect(result.scanFailures?.error).toEqual({
        agentName: "error",
        stage: "scanning sessions",
        errorClass: "Error",
        message: "scan failed",
      });
      expect(events).toContainEqual({
        event: "agent.scan_failed",
        detail: expect.objectContaining({
          agent: "error",
          stage: "scanning sessions",
          error_class: "Error",
          message: "scan failed",
          baseline_retained: false,
        }),
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("keeps successful agents when another agent fails", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({ name: "failed", available: true, sessions: [], shouldThrow: true }),
      createTestAgent({
        name: "healthy",
        available: true,
        sessions: [makeSession("ok", undefined, "healthy")],
      }),
    ]);

    const result = await scanSessions({});

    expect(result.sessions.map((session) => session.id)).toEqual(["ok"]);
    expect(result.byAgent.healthy).toHaveLength(1);
    expect(result.byAgent.failed).toBeUndefined();
    expect(result.scanFailures?.failed).toBeDefined();
  });

  it("retains a cached baseline when source enumeration fails", async () => {
    const cached = withCurrentIdentity(makeSession("cached"));
    mockedLoadCachedSessions.mockReturnValue({
      sessions: [cached],
      meta: { cached: { id: "cached", sourcePath: "/sessions/cached" } },
      timestamp: 123,
    });
    const agent = createTestAgent({ name: "test", available: true, sessions: [] });
    agent.checkForChanges = () => {
      throw new SessionScanError("test", "enumerating session sources", {
        cause: Object.assign(new Error("permission denied"), { code: "EACCES" }),
        sourcePath: "/sessions",
      });
    };
    mockedCreateRegisteredAgents.mockReturnValue([agent]);
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });

    try {
      const result = await scanSessions({ useCache: true });

      expect(result.sessions.map((session) => session.id)).toEqual(["cached"]);
      expect(result.byAgent.test?.map((session) => session.id)).toEqual(["cached"]);
      expect(result.scanFailures?.test).toEqual({
        agentName: "test",
        stage: "enumerating session sources",
        sourcePath: "/sessions",
        errorClass: "EACCES",
        message: "permission denied",
      });
      expect(events).toContainEqual({
        event: "agent.scan_failed",
        detail: expect.objectContaining({
          agent: "test",
          source_path: "/sessions",
          error_class: "EACCES",
          baseline_retained: true,
        }),
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("retains the cached baseline when change detection fails", async () => {
    const cached = withCurrentIdentity(makeSession("cached"));
    mockedLoadCachedSessions.mockReturnValue({ sessions: [cached], meta: {}, timestamp: 123 });
    const agent = createTestAgent({
      name: "test",
      available: true,
      sessions: [],
      checkForChangesResult: {
        status: "failed",
        hasChanges: false,
        timestamp: 123,
        failure: {
          sourcePath: "/sessions/test.db",
          errorClass: "SqliteError",
          message: "database is locked",
        },
      },
    });
    const commitChangeCheck = vi.spyOn(agent, "commitChangeCheck");
    mockedCreateRegisteredAgents.mockReturnValue([agent]);
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });

    try {
      const result = await scanSessions({ useCache: true });

      expect(result.sessions.map((session) => session.id)).toEqual(["cached"]);
      expect(result.byAgent.test?.map((session) => session.id)).toEqual(["cached"]);
      expect(result.cacheTimestamps).toEqual({ test: 123 });
      expect(result.scanFailures?.test).toEqual({
        agentName: "test",
        stage: "checking for changes",
        sourcePath: "/sessions/test.db",
        errorClass: "SqliteError",
        message: "database is locked",
      });
      expect(commitChangeCheck).not.toHaveBeenCalled();
      expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
      expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
      expect(events).toContainEqual({
        event: "agent.scan_failed",
        detail: expect.objectContaining({
          agent: "test",
          stage: "checking for changes",
          source_path: "/sessions/test.db",
          error_class: "SqliteError",
          baseline_retained: true,
        }),
      });
    } finally {
      setCoreDiagnostics(null);
    }
  });

  it("uses an explicitly declared enumerated source without relying on class identity", async () => {
    const cached = withCurrentIdentity(makeSession("cached"));
    const refreshed = makeSession("refreshed");
    mockedLoadCachedSessions.mockReturnValue({
      sessions: [cached],
      meta: {},
      timestamp: 123,
    });
    const agent = createTestAgent({ name: "test", available: true, sessions: [] });
    const synchronize = vi.fn(() => ({
      sessions: [refreshed],
      meta: {},
      sources: [],
      sourceOutcomes: [],
      detectedSessionIds: ["refreshed"],
      changedSessionIds: ["refreshed"],
      explicitRemovedSessionIds: ["cached"],
      finalizeSessionIds: ["refreshed"],
      sourceFailures: [],
      completeness: "complete" as const,
      sourceCount: 1,
      removedSourceCount: 1,
    }));
    Object.assign(agent, {
      sessionSourceAccess: {
        kind: "enumerated",
        synchronize,
        count: vi.fn(() => 1),
      },
      checkForChanges: vi.fn(() => {
        throw new Error("class-identity fallback should not run");
      }),
    });
    mockedCreateRegisteredAgents.mockReturnValue([agent]);

    const result = await scanSessions({ useCache: true, includeSmartTags: false });

    expect(result.sessions.map((session) => session.reference.sessionId)).toEqual(["refreshed"]);
    expect(synchronize).toHaveBeenCalledOnce();
  });

  it("does not publish a false empty baseline when a forced scan fails", async () => {
    const cached = withCurrentIdentity(makeSession("cached"));
    mockedLoadCachedSessions.mockReturnValue({ sessions: [cached], meta: {}, timestamp: 123 });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({ name: "test", available: true, sessions: [], shouldThrow: true }),
    ]);

    const result = await scanSessions({ useCache: false });

    expect(result.byAgent.test).toBeUndefined();
    expect(result.scanFailures?.test).toEqual(
      expect.objectContaining({ stage: "scanning sessions", message: "scan failed" }),
    );
  });

  it("recovers from an agent-level failure in the same process", async () => {
    const agent = createTestAgent({ name: "test", available: true, sessions: [] });
    agent.scan = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new SessionScanError("test", "opening the database");
      })
      .mockReturnValue([makeSession("recovered")]);
    mockedCreateRegisteredAgents.mockReturnValue([agent]);

    const failed = await scanSessions({ useCache: false });
    const recovered = await scanSessions({ useCache: false });

    expect(failed.scanFailures?.test?.stage).toBe("opening the database");
    expect(failed.byAgent.test).toBeUndefined();
    expect(recovered.scanFailures).toBeUndefined();
    expect(recovered.byAgent.test?.map((session) => session.id)).toEqual(["recovered"]);
  });

  it("calls onProgress for complete phase", async () => {
    const progress = vi.fn();
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [makeSession("s1")],
      }),
    ]);
    await scanSessions({}, progress);
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "test", phase: "complete" }),
    );
  });

  it("filters agents by name", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "alpha",
        available: true,
        sessions: [makeSession("a1")],
      }),
      createTestAgent({
        name: "beta",
        available: true,
        sessions: [makeSession("b1")],
      }),
    ]);
    const result = await scanSessions({ agents: ["alpha"] });
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.name).toBe("alpha");
  });

  it("applies time filters to results", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [
          makeSession("old", { time_created: 100 }),
          makeSession("new", { time_created: 500 }),
        ],
      }),
    ]);
    const result = await scanSessions({ from: 200 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe("new");
  });

  it("persists a windowed scan as a partial snapshot", async () => {
    const recent = makeSession("recent", { time_created: 500 });
    mockedSaveCachedSessions.mockReturnValue(true);
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [recent],
      }),
    ]);

    await scanSessions({ from: 200, includeSmartTags: false });

    expect(mockedSaveCachedSessions).toHaveBeenCalledWith(
      "test",
      [expect.objectContaining({ id: "recent" })],
      {},
      { completeness: "partial" },
    );
  });

  it("retains a cached head and writes a partial snapshot when full parsing fails", async () => {
    const cached = withCurrentIdentity(makeSession("cached", undefined, "files"));
    const meta = {
      cached: {
        id: "cached",
        sourcePath: "/cached.jsonl",
        sourceFingerprint: "old",
      },
    };
    mockedLoadCachedSessions.mockReturnValue({
      sessions: [cached],
      meta,
      timestamp: Date.now(),
    });
    mockedSaveCachedSessions.mockReturnValue(true);
    mockedCreateRegisteredAgents.mockReturnValue([new FailingFileAgent()]);

    const result = await scanSessions({ useCache: false, includeSmartTags: false });

    expect(result.sessions).toEqual([expect.objectContaining({ id: "cached" })]);
    expect(mockedSaveCachedSessions).toHaveBeenCalledWith(
      "files",
      [expect.objectContaining({ id: "cached" })],
      meta,
      { completeness: "partial" },
    );
  });

  it("uses cache when available", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("cached"))];
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: Date.now(),
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [makeSession("fresh")],
      }),
    ]);
    const result = await scanSessions({ useCache: true });
    // Should use cached sessions
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe("cached");
  });

  it("can return cached sessions without validating agent availability", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("cached"))];
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: Date.now(),
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: false,
        sessions: [makeSession("fresh")],
        checkForChangesResult: {
          hasChanges: true,
          changedIds: ["fresh"],
          timestamp: Date.now(),
        },
        incrementalScanResult: [makeSession("fresh")],
      }),
    ]);

    const result = await scanSessions({ useCache: true, cacheOnly: true });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe("cached");
    expect(result.sessions[0]!.project_identity).toEqual({
      kind: "path",
      key: "/home/user/project",
      displayName: "project",
    });
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
  });

  it("filters agent-specific stale sessions from cache-only results", async () => {
    const empty = withCurrentIdentity(
      makeSession("empty", {
        stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
      }),
    );
    const visible = withCurrentIdentity(makeSession("visible"));
    const cachedSessions = [empty, visible];
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: Date.now(),
    });
    const filterCachedSessions = vi.fn(() => [visible]);
    const agent = createTestAgent({
      name: "test",
      available: false,
      sessions: [],
    });
    agent.filterCachedSessions = filterCachedSessions;
    mockedCreateRegisteredAgents.mockReturnValue([agent]);

    const result = await scanSessions({ useCache: true, cacheOnly: true });

    expect(filterCachedSessions).toHaveBeenCalledWith(cachedSessions);
    expect(result.sessions.map((session) => session.id)).toEqual(["visible"]);
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
  });

  it("uses cached sessions even when last refresh is old", async () => {
    mockedLoadCachedSessions.mockReturnValue({
      sessions: [withCurrentIdentity(makeSession("cached"))],
      meta: {},
      timestamp: 0,
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [makeSession("fresh")],
      }),
    ]);

    const result = await scanSessions({ useCache: true, cacheOnly: true });

    expect(mockedLoadCachedSessions).toHaveBeenCalledWith("test");
    expect(result.sessions.map((session) => session.id)).toEqual(["cached"]);
    expect(mockedSaveCachedSessionChanges).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
  });

  it("refreshes stale cache before returning results", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("cached"))];
    const refreshedSessions = [makeSession("fresh")];
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: Date.now(),
    });
    const agent = createTestAgent({
      name: "test",
      available: true,
      sessions: refreshedSessions,
      checkForChangesResult: {
        hasChanges: true,
        changedIds: ["fresh"],
        timestamp: Date.now(),
      },
      incrementalScanResult: refreshedSessions,
    });
    const incrementalScan = vi.spyOn(agent, "incrementalScan");
    mockedCreateRegisteredAgents.mockReturnValue([agent]);

    const result = await scanSessions({
      useCache: true,
      smartRefresh: false,
      from: 500,
      to: 1_500,
      fast: true,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe("fresh");
    expect(incrementalScan).toHaveBeenCalledWith(cachedSessions, ["fresh"], undefined, {
      from: 500,
      to: 1_500,
      fast: true,
      includeRelatedSessions: true,
      onProgress: expect.any(Function),
    });
    expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessionChanges).toHaveBeenCalledWith(
      "test",
      [
        {
          session: expect.objectContaining({
            ...refreshedSessions[0]!,
            project_identity: expect.objectContaining({ kind: "path", key: "/home/user/project" }),
            smart_tags: [],
            smart_tags_source_updated_at: 1000,
          }),
          sortIndex: 0,
        },
      ],
      [],
      {},
    );
  });

  it("retains the durable baseline after a failed incremental cache write", async () => {
    const cachedSessions = [withCurrentIdentity(makeSession("cached"))];
    const refreshedSessions = [makeSession("fresh")];
    const checkForChanges = vi.fn(() => ({
      hasChanges: true,
      changedIds: ["fresh"],
      timestamp: 456,
    }));
    const agent = createTestAgent({
      name: "test",
      available: true,
      sessions: refreshedSessions,
      incrementalScanResult: refreshedSessions,
    });
    agent.checkForChanges = checkForChanges;
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: 123,
    });
    mockedSaveCachedSessionChanges.mockReturnValueOnce(false).mockReturnValue(true);
    mockedCreateRegisteredAgents.mockReturnValue([agent]);

    const failed = await scanSessions({ useCache: true, includeSmartTags: false });
    const recovered = await scanSessions({ useCache: true, includeSmartTags: false });

    expect(failed.sessions.map((session) => session.id)).toEqual(["fresh"]);
    expect(failed.cacheTimestamps).toEqual({ test: 123 });
    expect(failed.cacheFailures).toEqual({ test: { agentName: "test" } });
    expect(failed.scanFailures).toBeUndefined();
    expect(recovered.sessions.map((session) => session.id)).toEqual(["fresh"]);
    expect(recovered.cacheTimestamps).toEqual({ test: 456 });
    expect(recovered.cacheFailures).toBeUndefined();
    expect(checkForChanges).toHaveBeenNthCalledWith(1, 123, cachedSessions);
    expect(checkForChanges).toHaveBeenNthCalledWith(2, 123, cachedSessions);
  });

  it("writes only changed sessions after smart refresh", async () => {
    const projectIdentity = {
      kind: "path" as const,
      key: "/home/user/project",
      displayName: "project",
    };
    const keep = withCurrentIdentity(makeSession("keep", { project_identity: projectIdentity }));
    const changed = withCurrentIdentity(makeSession("changed"));
    const removed = withCurrentIdentity(makeSession("removed"));
    const updatedChanged = makeSession("changed", { title: "Updated changed" });
    const added = makeSession("added");

    mockedLoadCachedSessions.mockReturnValue({
      sessions: [keep, changed, removed],
      meta: {},
      timestamp: Date.now(),
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [keep, updatedChanged, added],
        checkForChangesResult: {
          hasChanges: true,
          changedIds: ["changed"],
          timestamp: Date.now(),
        },
        incrementalScanResult: [keep, updatedChanged, added],
      }),
    ]);

    await scanSessions({ useCache: true, includeSmartTags: false });

    expect(mockedSaveCachedSessions).not.toHaveBeenCalled();
    expect(mockedSaveCachedSessionChanges).toHaveBeenCalledWith(
      "test",
      [
        {
          session: expect.objectContaining({
            id: "changed",
            title: "Updated changed",
            project_identity: expect.objectContaining({ kind: "path", key: "/home/user/project" }),
          }),
          sortIndex: 1,
        },
        {
          session: expect.objectContaining({
            id: "added",
            project_identity: expect.objectContaining({ kind: "path", key: "/home/user/project" }),
          }),
          sortIndex: 2,
        },
      ],
      ["removed"],
      {},
    );
  });

  it("does not crash without onProgress callback", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: [makeSession("s1")],
      }),
    ]);
    const result = await scanSessions({});
    expect(result).toBeDefined();
  });
});
