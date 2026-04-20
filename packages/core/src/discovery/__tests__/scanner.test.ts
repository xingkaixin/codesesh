import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionHead, SessionData } from "../../types/index.js";
import { BaseAgent, type SessionCacheMeta, type ChangeCheckResult } from "../../agents/base.js";
import { filterSessions } from "../scanner.js";

// --- filterSessions tests (pure function) ---

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  return {
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: "/home/user/project",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

class TestAgent extends BaseAgent {
  readonly name = "test";
  readonly displayName = "test";

  isAvailable(): boolean {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(): SessionData {
    return {} as SessionData;
  }
}

describe("filterSessions", () => {
  it("returns all sessions when no filters", () => {
    const sessions = [makeSession("a"), makeSession("b")];
    expect(filterSessions(sessions, {})).toHaveLength(2);
  });

  it("filters by cwd using path scope match", () => {
    const sessions = [
      makeSession("a", { directory: "/home/user/project/src" }),
      makeSession("b", { directory: "/home/user/other" }),
      makeSession("c", { directory: "/home/user/project" }),
    ];
    const result = filterSessions(sessions, { cwd: "/home/user/project" });
    expect(result).toHaveLength(2);
    expect(result.map((s) => s.id)).toEqual(["a", "c"]);
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

vi.mock("../cache.js", () => ({
  loadCachedSessions: vi.fn(() => null),
  saveCachedSessions: vi.fn(),
}));

vi.mock("../../utils/index.js", () => ({
  perf: {
    start: vi.fn(() => ({ name: "test", startTime: 0, children: [] })),
    end: vi.fn(),
  },
}));

// Mock createRegisteredAgents to return controlled agents
vi.mock("../../agents/index.js", () => ({
  createRegisteredAgents: vi.fn(() => []),
  BaseAgent: class {},
}));

import { scanSessions, scanSessionsAsync } from "../scanner.js";
import { createRegisteredAgents } from "../../agents/index.js";
import { loadCachedSessions, saveCachedSessions } from "../cache.js";

const mockedCreateRegisteredAgents = vi.mocked(createRegisteredAgents);
const mockedLoadCachedSessions = vi.mocked(loadCachedSessions);
const mockedSaveCachedSessions = vi.mocked(saveCachedSessions);

beforeEach(() => {
  vi.clearAllMocks();
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
  agent.getSessionData = () => ({}) as SessionData;
  agent.getSessionMetaMap = overrides.metaMap ? () => overrides.metaMap! : undefined;
  agent.setSessionMetaMap = undefined;
  agent.checkForChanges = overrides.checkForChangesResult
    ? () => overrides.checkForChangesResult!
    : undefined;
  agent.incrementalScan = overrides.incrementalScanResult
    ? () => overrides.incrementalScanResult!
    : undefined;
  return agent as BaseAgent;
}

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

  it("handles scan errors gracefully", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "error",
        available: true,
        sessions: [],
        shouldThrow: true,
      }),
    ]);
    const result = await scanSessions({});
    expect(result.agents).toHaveLength(1);
    expect(result.byAgent.error).toEqual([]);
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

  it("uses cache when available", async () => {
    const cachedSessions = [makeSession("cached")];
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

  it("refreshes stale cache before returning results", async () => {
    const cachedSessions = [makeSession("cached")];
    const refreshedSessions = [makeSession("fresh")];
    mockedLoadCachedSessions.mockReturnValue({
      sessions: cachedSessions,
      meta: {},
      timestamp: Date.now(),
    });
    mockedCreateRegisteredAgents.mockReturnValue([
      createTestAgent({
        name: "test",
        available: true,
        sessions: refreshedSessions,
        checkForChangesResult: {
          hasChanges: true,
          changedIds: ["fresh"],
          timestamp: Date.now(),
        },
        incrementalScanResult: refreshedSessions,
      }),
    ]);

    const result = await scanSessions({ useCache: true, smartRefresh: false });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.id).toBe("fresh");
    expect(mockedSaveCachedSessions).toHaveBeenCalledWith("test", refreshedSessions, {});
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

describe("scanSessionsAsync", () => {
  it("is an alias for scanSessions", async () => {
    mockedCreateRegisteredAgents.mockReturnValue([]);
    const result = await scanSessionsAsync({});
    expect(result).toBeDefined();
    expect(result.sessions).toEqual([]);
  });
});
