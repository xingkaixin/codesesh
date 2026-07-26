import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BaseAgent,
  materializeSessionDetail,
  saveCachedSessions,
  syncSessionSearchIndex,
  type ChangeCheckResult,
  type ScanResult,
  type SessionCacheMeta,
  type SessionData,
  type SessionHead,
} from "../../index.js";
import { setFtsIntegrityCheckedPath, setSchemaEnsuredPath } from "../cache/db.js";

const { testHomeDir } = vi.hoisted(() => ({
  testHomeDir: `/tmp/codesesh-session-detail-test-${process.pid}`,
}));
const projectIdentity = {
  kind: "path" as const,
  key: "/workspace/project",
  displayName: "project",
};

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

class TestAgent extends BaseAgent {
  readonly name = "test";
  readonly displayName = "Test";
  reads = 0;

  constructor(
    private readonly detail: SessionData,
    private readonly meta: Map<string, SessionCacheMeta>,
  ) {
    super();
  }

  isAvailable(): boolean {
    return true;
  }

  scan(): SessionHead[] {
    return [];
  }

  getSessionData(): SessionData {
    this.reads += 1;
    return this.detail;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "Test adapter" };
  }

  checkForChanges(): ChangeCheckResult {
    return { hasChanges: false, timestamp: 0 };
  }

  incrementalScan(sessions: SessionHead[]): SessionHead[] {
    return sessions;
  }

  getSessionMetaMap(): Map<string, SessionCacheMeta> {
    return this.meta;
  }

  setSessionMetaMap(): void {}
}

function makeHead(overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id: "s1",
    slug: "test/s1",
    title: "Cached Session",
    directory: "/workspace/project",
    project_identity: projectIdentity,
    time_created: 1000,
    time_updated: 2000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function makeDetail(title = "Source Session"): SessionData {
  return {
    ...makeHead({ title }),
    messages: [
      {
        id: "m1",
        role: "assistant",
        time_created: 1500,
        parts: [
          {
            type: "tool",
            tool: "Read",
            state: { arguments: { file_path: "src/index.ts" } },
          },
        ],
      },
    ],
  };
}

function makeMeta(fingerprint: string): SessionCacheMeta {
  return {
    id: "s1",
    sourcePath: "/sessions/s1.jsonl",
    sourceFingerprint: fingerprint,
  };
}

function makeScanResult(agent: TestAgent, head = makeHead()): ScanResult {
  return {
    sessions: [head],
    byAgent: { test: [head] },
    agents: [agent],
  };
}

function persistDetail(head: SessionHead, detail: SessionData, fingerprint: string): void {
  saveCachedSessions("test", [head], { [head.id]: makeMeta(fingerprint) });
  syncSessionSearchIndex("test", [head], () => detail);
}

beforeEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

afterEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

describe("materializeSessionDetail", () => {
  it("returns a complete matching cache entry without reading the source", () => {
    const head = makeHead();
    persistDetail(head, makeDetail("Cached Session"), "same");
    const agent = new TestAgent(makeDetail(), new Map([["s1", makeMeta("same")]]));

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.data.title).toBe("Cached Session");
    expect(result.data.project_identity).toEqual(projectIdentity);
    expect(result.data.smart_tags_source_updated_at).toBe(2000);
    expect(result.data.file_activity).toEqual([
      expect.objectContaining({ path: "src/index.ts", kind: "read", count: 1 }),
    ]);
    expect(agent.reads).toBe(0);
  });

  it("reads the source when cached messages are incomplete", () => {
    const head = makeHead();
    saveCachedSessions("test", [head], { s1: makeMeta("same") });
    const agent = new TestAgent(makeDetail(), new Map([["s1", makeMeta("same")]]));

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result).toMatchObject({
      status: "found",
      data: { title: "Source Session", messages: [{ id: "m1" }] },
    });
    expect(agent.reads).toBe(1);
  });

  it("reads the source when its fingerprint no longer matches the cache", () => {
    const head = makeHead();
    persistDetail(head, makeDetail("Cached Session"), "old");
    const agent = new TestAgent(makeDetail(), new Map([["s1", makeMeta("current")]]));

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result).toMatchObject({ status: "found", data: { title: "Source Session" } });
    expect(agent.reads).toBe(1);
  });

  it("derives the same file activity for cached and source details", () => {
    const head = makeHead();
    const detail = makeDetail();
    persistDetail(head, detail, "cached");
    const cachedAgent = new TestAgent(detail, new Map([["s1", makeMeta("cached")]]));
    const sourceAgent = new TestAgent(detail, new Map([["s1", makeMeta("source")]]));

    const cached = materializeSessionDetail(makeScanResult(cachedAgent, head), {
      agentName: "test",
      sessionId: "s1",
    });
    const source = materializeSessionDetail(makeScanResult(sourceAgent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(cached.status).toBe("found");
    expect(source.status).toBe("found");
    if (cached.status !== "found" || source.status !== "found") return;
    expect(source.data.file_activity).toEqual(cached.data.file_activity);
  });

  it("returns explicit lookup outcomes when no detail can be materialized", () => {
    const agent = new TestAgent(makeDetail(), new Map());
    const emptyScan = { sessions: [], byAgent: { test: [] }, agents: [agent] };

    expect(materializeSessionDetail(emptyScan, { agentName: "missing", sessionId: "s1" })).toEqual({
      status: "unknown-agent",
    });
    expect(materializeSessionDetail(emptyScan, { agentName: "test", sessionId: "s1" })).toEqual({
      status: "not-ready",
    });
  });
});
