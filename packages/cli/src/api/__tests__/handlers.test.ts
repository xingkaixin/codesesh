import { describe, it, expect, vi } from "vitest";
import {
  handleGetAgents,
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
    time_created: 1000,
    time_updated: 1000,
    directory: "/home/user/project",
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
          makeSession("old", { time_created: new Date("2023-01-01").getTime() }),
          makeSession("new", { time_created: new Date("2025-01-01").getTime() }),
        ],
        byAgent: {},
      }),
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].id).toBe("new");
  });

  it("ignores invalid from date", () => {
    const c = makeMockContext({ query: { from: "not-a-date" } });
    handleGetSessions(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    // Invalid date → filter not applied
    expect(response.sessions).toHaveLength(2);
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
