import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseAgent, type ChangeCheckResult, type SessionCacheMeta } from "../../agents/base.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";
import { saveCachedSessions } from "../cache/sessions.js";
import { syncSessionSearchIndex } from "../cache/search.js";
import { materializeSessionDetail, materializeSessionDetailResponse } from "../session-detail.js";
import type { LiveSnapshot } from "../scanner.js";
import { setSchemaEnsuredPath } from "../cache/db.js";
import { setCoreDiagnostics } from "../../utils/diagnostics.js";
import { SMART_TAG_CLASSIFIER_REVISION } from "../../utils/smart-tags.js";

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
    private readonly detail: SessionDetail,
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

  getSessionData(): SessionDetail {
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

function makeDetail(title = "Source Session"): SessionDetail {
  return {
    ...makeHead({ title }),
    reference: { agentName: "test", sessionId: "s1" },
    messages: [
      {
        id: "m1",
        role: "assistant",
        time_created: 1500,
        parts: [
          {
            type: "tool",
            tool: "Read",
            state: { status: "completed", input: { file_path: "src/index.ts" } },
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

function makeScanResult(agent: TestAgent, head = makeHead()): LiveSnapshot {
  return {
    sessions: [head],
    byAgent: { test: [head] },
    agents: [agent],
  };
}

function persistDetail(head: SessionHead, detail: SessionDetail, fingerprint: string): void {
  saveCachedSessions("test", [head], { [head.id]: makeMeta(fingerprint) });
  syncSessionSearchIndex("test", [head], () => detail);
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
});

afterEach(() => {
  setCoreDiagnostics(null);
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
});

describe("materializeSessionDetail", () => {
  it("does not treat an old detail as fresh after only its head advances", () => {
    const head = makeHead();
    const detailA = makeDetail("Detail A");
    detailA.messages[0]!.id = "message-a";
    const detailB = makeDetail("Detail B");
    detailB.messages[0]!.id = "message-b";
    persistDetail(head, detailA, "fingerprint-a");
    saveCachedSessions("test", [head], { s1: makeMeta("fingerprint-b") });
    const agent = new TestAgent(detailB, new Map([["s1", makeMeta("fingerprint-b")]]));

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result).toMatchObject({
      status: "found",
      data: { detail_freshness: "fresh", messages: [{ id: "message-b" }] },
    });
    expect(agent.reads).toBe(1);
  });

  it("keeps the last detail explicitly stale when rebuilding it fails", () => {
    const warnings: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      warn: (event, detail) => warnings.push({ event, detail }),
    });
    const head = makeHead();
    const detailA = makeDetail("Detail A");
    detailA.messages[0]!.id = "message-a";
    persistDetail(head, detailA, "fingerprint-a");
    saveCachedSessions("test", [head], { s1: makeMeta("fingerprint-b") });
    const agent = new TestAgent(
      makeDetail("Detail B"),
      new Map([["s1", makeMeta("fingerprint-b")]]),
    );
    vi.spyOn(agent, "getSessionData").mockImplementation(() => {
      throw new Error("source parse failed");
    });

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result).toMatchObject({
      status: "found",
      data: { detail_freshness: "stale", messages: [{ id: "message-a" }] },
    });
    expect(warnings).toContainEqual({
      event: "session_detail.stale_fallback",
      detail: expect.objectContaining({
        agent: "test",
        session_id: "s1",
        error: "source parse failed",
      }),
    });
  });

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
    const sourceDetail = {
      ...makeDetail(),
      reference: { agentName: "wrong", sessionId: "wrong" },
    };
    const agent = new TestAgent(sourceDetail, new Map([["s1", makeMeta("current")]]));

    const result = materializeSessionDetail(makeScanResult(agent, head), {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result).toMatchObject({
      status: "found",
      data: {
        title: "Source Session",
        reference: { agentName: "test", sessionId: "s1" },
      },
    });
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

  it("returns cached messages as lazy JSON without reading the source", () => {
    const head = makeHead({
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    });
    const detail = {
      ...makeDetail("Cached Session"),
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    };
    persistDetail(head, detail, "same");
    const agent = new TestAgent(makeDetail(), new Map([["s1", makeMeta("same")]]));
    const scanResult = makeScanResult(agent, head);

    const result = materializeSessionDetailResponse(scanResult, {
      agentName: "test",
      sessionId: "s1",
    });
    const structured = materializeSessionDetail(scanResult, {
      agentName: "test",
      sessionId: "s1",
    });

    expect(result.status).toBe("found-json");
    expect(structured.status).toBe("found");
    if (result.status !== "found-json" || structured.status !== "found") return;
    expect(result.data.title).toBe("Cached Session");
    expect(result.messageCount).toBe(1);
    expect([...result.messages].map((message) => JSON.parse(message))).toEqual(
      structured.data.messages,
    );
    expect(agent.reads).toBe(0);
  });

  it("indexes heads once per scan snapshot instead of calling Array.find", () => {
    const heads = Array.from({ length: 100 }, (_, index) =>
      makeHead({ id: `s${index}`, slug: `test/s${index}` }),
    );
    const target = heads.at(-1)!;
    const agent = new TestAgent({ ...makeDetail(), id: target.id, slug: target.slug }, new Map());
    const scanResult = {
      sessions: heads,
      byAgent: { test: heads },
      agents: [agent],
    };
    const find = vi.spyOn(heads, "find");

    const first = materializeSessionDetail(scanResult, {
      agentName: "test",
      sessionId: target.id,
    });
    const second = materializeSessionDetail(scanResult, {
      agentName: "test",
      sessionId: target.id,
    });

    expect(first.status).toBe("found");
    expect(second.status).toBe("found");
    expect(find).not.toHaveBeenCalled();
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
