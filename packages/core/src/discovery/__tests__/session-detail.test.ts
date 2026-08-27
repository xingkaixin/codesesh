import { rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BaseAgent, type ChangeCheckResult, type SessionCacheMeta } from "../../agents/base.js";
import type { IdentifiedSessionHead, SessionDetail, SessionHead } from "../../types/index.js";
import { readCachedSessionCursor, saveCachedSessions } from "../cache/sessions.js";
import { withCacheDb } from "../cache/connection.js";
import { MESSAGE_CURSOR_VERSION } from "../cache/message-cursor.js";
import { syncSessionSearchIndex } from "../cache/search.js";
import {
  materializeSessionDetail,
  materializeSessionDetailResponse,
  materializeCachedSessionDetailResponse,
} from "../session-detail.js";
import type { LiveSnapshot } from "../scanner.js";
import { getCachePath, setSchemaEnsuredPath } from "../cache/db.js";
import { setCoreDiagnostics } from "../../utils/diagnostics.js";
import { SMART_TAG_CLASSIFIER_REVISION } from "../../utils/smart-tags.js";
import { createSessionIdentity } from "../../contract/session-reference.js";

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
  readonly sessionSourceAccess = {
    kind: "aggregate" as const,
    checkForChanges: () => ({ hasChanges: false, timestamp: 0 }),
    commitChangeCheck: () => {},
    incrementalScan: (sessions: SessionHead[]) => sessions,
  };
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

  getSessionCacheMeta(sessionId: string): SessionCacheMeta | undefined {
    return this.meta.get(sessionId);
  }

  snapshotSessionCacheMeta(): Record<string, SessionCacheMeta> {
    return Object.fromEntries(this.meta);
  }

  restoreSessionCacheMeta(): void {}

  removeSessionCacheMeta(): void {}
}

function makeHead(overrides: Partial<IdentifiedSessionHead> = {}): IdentifiedSessionHead {
  return {
    reference: { agentName: "test", sessionId: "s1" },
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

function persistDetail(
  head: IdentifiedSessionHead,
  detail: SessionDetail,
  fingerprint: string,
): void {
  saveCachedSessions("test", [head], { [head.reference.sessionId]: makeMeta(fingerprint) });
  syncSessionSearchIndex("test", [head], () => detail);
}

function withPreparedSqlCapture<T>(run: () => T): { result: T; sql: string[] } {
  const preparedSql: string[] = [];
  const originalPrepare = Database.prototype.prepare;
  const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
    this: Database.Database,
    source: string,
  ) {
    preparedSql.push(source);
    return originalPrepare.call(this, source);
  });

  try {
    return { result: run(), sql: preparedSql.map((sql) => sql.replace(/\s+/g, " ").trim()) };
  } finally {
    prepareSpy.mockRestore();
  }
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
  it("defers cold and stale details without reading their sources", () => {
    const head = makeHead();
    const agent = new TestAgent(makeDetail(), new Map([["s1", makeMeta("new")]]));
    const snapshot = makeScanResult(agent, head);
    const reference = head.reference;
    expect(materializeCachedSessionDetailResponse(snapshot, reference)).toBeNull();
    persistDetail(head, makeDetail(), "old");
    expect(materializeCachedSessionDetailResponse(snapshot, reference)).toBeNull();
    expect(agent.reads).toBe(0);
  });

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
    const sourceDetail = makeDetail();
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

  it("rejects source detail for a different session reference", () => {
    const head = makeHead();
    const sourceDetail = {
      ...makeDetail(),
      ...createSessionIdentity({ agentName: "test", sessionId: "other" }),
    };
    const agent = new TestAgent(sourceDetail, new Map());

    expect(() =>
      materializeSessionDetail(makeScanResult(agent, head), {
        agentName: "test",
        sessionId: "s1",
      }),
    ).toThrow("Session reference does not match expected session");
  });

  it("rejects an invalid snapshot instead of resolving identity during a detail request", () => {
    const detail = { ...makeDetail(), project_identity: undefined };
    const head = {
      ...makeHead(),
      project_identity: undefined,
    } as unknown as IdentifiedSessionHead;
    const agent = new TestAgent(detail, new Map([["s1", makeMeta("source")]]));
    const scanResult = makeScanResult(agent, head);
    const reference = { agentName: "test", sessionId: "s1" };

    expect(() => materializeSessionDetail(scanResult, reference)).toThrow(
      "Session test/s1 reached detail materialization without project_identity",
    );
    expect(() => materializeSessionDetailResponse(scanResult, reference, {})).toThrow(
      "Session test/s1 reached detail materialization without project_identity",
    );
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

  it("streams only an unchanged message prefix's appended suffix", () => {
    const diagnostics: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => diagnostics.push({ event, detail }),
      warn() {},
    });
    const makeStreamableHead = (messageCount: number, timeUpdated: number) => {
      const head = makeHead({
        time_updated: timeUpdated,
        smart_tags: [],
        smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      });
      return { ...head, stats: { ...head.stats, message_count: messageCount } };
    };
    const makeStreamableDetail = (head: SessionHead, texts: string[]) => ({
      ...makeDetail("Cached Session"),
      ...head,
      reference: { agentName: "test", sessionId: "s1" },
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      messages: texts.map((text, index) => ({
        id: `m${index + 1}`,
        role: "assistant" as const,
        time_created: 1500 + index,
        parts: [{ type: "text" as const, text }],
      })),
    });
    const firstText = "x".repeat(64 * 1024);
    const firstHead = makeStreamableHead(1, 2000);
    const firstDetail = makeStreamableDetail(firstHead, [firstText]);
    persistDetail(firstHead, firstDetail, "first");
    const first = materializeSessionDetailResponse(
      makeScanResult(new TestAgent(firstDetail, new Map([["s1", makeMeta("first")]])), firstHead),
      { agentName: "test", sessionId: "s1" },
    );

    expect(first.status).toBe("found-json");
    if (first.status !== "found-json") return;
    expect(first.data.message_update).toBe("reset");
    expect(first.sentMessageCount).toBe(1);

    const appendedHead = makeStreamableHead(2, 3000);
    const appendedDetail = makeStreamableDetail(appendedHead, [firstText, "second"]);
    persistDetail(appendedHead, appendedDetail, "appended");
    const { result: appended, sql } = withPreparedSqlCapture(() =>
      materializeSessionDetailResponse(
        makeScanResult(
          new TestAgent(appendedDetail, new Map([["s1", makeMeta("appended")]])),
          appendedHead,
        ),
        { agentName: "test", sessionId: "s1" },
        { messageCursor: first.data.message_cursor },
      ),
    );

    expect(appended.status).toBe("found-json");
    if (appended.status !== "found-json") return;
    expect(appended.data.message_update).toBe("append");
    expect(appended.messageCount).toBe(2);
    expect(appended.sentMessageCount).toBe(1);
    expect([...appended.messages].map((message) => JSON.parse(message).id)).toEqual(["m2"]);
    const messageSql = sql.filter((statement) => statement.includes("FROM messages"));
    expect(
      messageSql.some(
        (statement) =>
          statement.includes("parts_json") && !statement.includes("message_index >= ?"),
      ),
    ).toBe(false);
    expect(
      messageSql.some(
        (statement) => statement.includes("parts_json") && statement.includes("message_index >= ?"),
      ),
    ).toBe(true);
    expect(diagnostics).toContainEqual({
      event: "session_detail.cursor_stream",
      detail: expect.objectContaining({
        update: "append",
        message_count: 2,
        sent_message_count: 1,
        parts_json_bytes: expect.any(Number),
        duration_ms: expect.any(Number),
      }),
    });
    const appendTelemetry = diagnostics.find(
      ({ event, detail }) =>
        event === "session_detail.cursor_stream" && detail?.update === "append",
    );
    expect(Number(appendTelemetry?.detail?.parts_json_bytes)).toBeLessThan(1_000);

    const rewrittenDetail = makeStreamableDetail(appendedHead, ["rewritten", "second"]);
    persistDetail(appendedHead, rewrittenDetail, "rewritten");
    const rewritten = materializeSessionDetailResponse(
      makeScanResult(
        new TestAgent(rewrittenDetail, new Map([["s1", makeMeta("rewritten")]])),
        appendedHead,
      ),
      { agentName: "test", sessionId: "s1" },
      { messageCursor: appended.data.message_cursor },
    );

    expect(rewritten.status).toBe("found-json");
    if (rewritten.status !== "found-json") return;
    expect(rewritten.data.message_update).toBe("reset");
    expect(rewritten.sentMessageCount).toBe(2);
    expect([...rewritten.messages].map((message) => JSON.parse(message).id)).toEqual(["m1", "m2"]);
  });

  it("resets cursors when cached message order or length changes", () => {
    const makeStreamableHead = (messageCount: number, timeUpdated: number) => ({
      ...makeHead({
        time_updated: timeUpdated,
        smart_tags: [],
        smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      }),
      stats: { ...makeHead().stats, message_count: messageCount },
    });
    const makeStreamableDetail = (
      head: SessionHead,
      messages: Array<{ id: string; text: string }>,
    ) => ({
      ...makeDetail("Cached Session"),
      ...head,
      reference: { agentName: "test", sessionId: "s1" },
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      messages: messages.map((message, index) => ({
        id: message.id,
        role: "assistant" as const,
        time_created: 1500 + index,
        parts: [{ type: "text" as const, text: message.text }],
      })),
    });
    const firstHead = makeStreamableHead(3, 2000);
    const firstDetail = makeStreamableDetail(firstHead, [
      { id: "m1", text: "first" },
      { id: "m2", text: "second" },
      { id: "m3", text: "third" },
    ]);
    persistDetail(firstHead, firstDetail, "first");
    const first = materializeSessionDetailResponse(
      makeScanResult(new TestAgent(firstDetail, new Map([["s1", makeMeta("first")]])), firstHead),
      { agentName: "test", sessionId: "s1" },
    );
    expect(first.status).toBe("found-json");
    if (first.status !== "found-json") return;

    const reorderedHead = makeStreamableHead(3, 3000);
    const reorderedDetail = makeStreamableDetail(reorderedHead, [
      { id: "m3", text: "third" },
      { id: "m1", text: "first" },
      { id: "m2", text: "second" },
    ]);
    persistDetail(reorderedHead, reorderedDetail, "reordered");
    const reordered = materializeSessionDetailResponse(
      makeScanResult(
        new TestAgent(reorderedDetail, new Map([["s1", makeMeta("reordered")]])),
        reorderedHead,
      ),
      { agentName: "test", sessionId: "s1" },
      { messageCursor: first.data.message_cursor },
    );
    expect(reordered).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 3,
      sentMessageCount: 3,
    });
    if (reordered.status !== "found-json") return;

    const deletedHead = makeStreamableHead(2, 4000);
    const deletedDetail = makeStreamableDetail(deletedHead, [
      { id: "m3", text: "third" },
      { id: "m2", text: "second" },
    ]);
    persistDetail(deletedHead, deletedDetail, "deleted");
    const deleted = materializeSessionDetailResponse(
      makeScanResult(
        new TestAgent(deletedDetail, new Map([["s1", makeMeta("deleted")]])),
        deletedHead,
      ),
      { agentName: "test", sessionId: "s1" },
      { messageCursor: reordered.data.message_cursor },
    );
    expect(deleted).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 2,
      sentMessageCount: 2,
    });
    if (deleted.status !== "found-json") return;

    const truncatedHead = makeStreamableHead(1, 5000);
    const truncatedDetail = makeStreamableDetail(truncatedHead, [{ id: "m3", text: "third" }]);
    persistDetail(truncatedHead, truncatedDetail, "truncated");
    const truncated = materializeSessionDetailResponse(
      makeScanResult(
        new TestAgent(truncatedDetail, new Map([["s1", makeMeta("truncated")]])),
        truncatedHead,
      ),
      { agentName: "test", sessionId: "s1" },
      { messageCursor: deleted.data.message_cursor },
    );
    expect(truncated).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 1,
      sentMessageCount: 1,
    });
  });

  it("resets cursors with missing chains or out-of-range counts", () => {
    const head = makeHead({
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    });
    const detail = {
      ...makeDetail("Cached Session"),
      ...head,
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    };
    persistDetail(head, detail, "cached");
    const agent = new TestAgent(detail, new Map([["s1", makeMeta("cached")]]));
    const scanResult = makeScanResult(agent, head);
    const first = materializeSessionDetailResponse(scanResult, {
      agentName: "test",
      sessionId: "s1",
    });
    expect(first.status).toBe("found-json");
    if (first.status !== "found-json") return;

    withCacheDb((db) => {
      db.prepare("UPDATE messages SET content_chain_digest = NULL WHERE agent_name = ?").run(
        "test",
      );
    });
    const missingChain = materializeSessionDetailResponse(
      scanResult,
      { agentName: "test", sessionId: "s1" },
      { messageCursor: first.data.message_cursor },
    );
    expect(missingChain).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 1,
      sentMessageCount: 1,
    });

    const oversizedCursor = Buffer.from(
      JSON.stringify({ version: MESSAGE_CURSOR_VERSION, count: 2, digest: "0".repeat(64) }),
    ).toString("base64url");
    const oversized = materializeSessionDetailResponse(
      scanResult,
      { agentName: "test", sessionId: "s1" },
      { messageCursor: oversizedCursor },
    );
    expect(oversized).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 1,
      sentMessageCount: 1,
    });
    expect(agent.reads).toBe(0);
  });

  it("keeps empty cursor streams appendable", () => {
    const head = makeHead({
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      stats: { ...makeHead().stats, message_count: 0 },
    });
    const detail = {
      ...makeDetail("Cached Session"),
      ...head,
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
      messages: [],
    };
    persistDetail(head, detail, "empty");
    const scanResult = makeScanResult(
      new TestAgent(detail, new Map([["s1", makeMeta("empty")]])),
      head,
    );
    const first = materializeSessionDetailResponse(scanResult, {
      agentName: "test",
      sessionId: "s1",
    });
    expect(first).toMatchObject({
      status: "found-json",
      data: { message_update: "reset" },
      messageCount: 0,
      sentMessageCount: 0,
    });
    if (first.status !== "found-json") return;

    const next = materializeSessionDetailResponse(
      scanResult,
      { agentName: "test", sessionId: "s1" },
      { messageCursor: first.data.message_cursor },
    );
    expect(next).toMatchObject({
      status: "found-json",
      data: { message_update: "append" },
      messageCount: 0,
      sentMessageCount: 0,
    });
  });

  it("reads cursor metadata and message ranges from one cache snapshot", () => {
    const head = makeHead({
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    });
    const detail = {
      ...makeDetail("Cached Session"),
      ...head,
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    };
    persistDetail(head, detail, "snapshot");

    const snapshot = readCachedSessionCursor("test", "s1", (entry, cursor) => {
      const writer = new Database(getCachePath());
      try {
        writer
          .prepare("UPDATE messages SET parts_json = ? WHERE agent_name = ? AND session_id = ?")
          .run(JSON.stringify([]), "test", "s1");
      } finally {
        writer.close();
      }
      return {
        digest: entry.messageDigest,
        partsJson: cursor.messageRows(0)[0]?.parts_json,
      };
    });

    expect(snapshot?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(String(snapshot?.partsJson))).toEqual(detail.messages[0]?.parts);
  });

  it("resets incremental transport while a changed fingerprint is rematerialized", () => {
    const head = makeHead({
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    });
    const cached = {
      ...makeDetail("Cached Session"),
      smart_tags: [],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    };
    persistDetail(head, cached, "cached");
    const first = materializeSessionDetailResponse(
      makeScanResult(new TestAgent(cached, new Map([["s1", makeMeta("cached")]])), head),
      { agentName: "test", sessionId: "s1" },
    );
    expect(first.status).toBe("found-json");
    if (first.status !== "found-json") return;

    saveCachedSessions("test", [head], { s1: makeMeta("changed") });
    const source = makeDetail("Source Session");
    const result = materializeSessionDetailResponse(
      makeScanResult(new TestAgent(source, new Map([["s1", makeMeta("changed")]])), head),
      { agentName: "test", sessionId: "s1" },
      { messageCursor: first.data.message_cursor },
    );

    expect(result).toMatchObject({
      status: "found",
      data: { title: "Source Session", message_update: "reset" },
    });
  });

  it("indexes heads once per scan snapshot instead of calling Array.find", () => {
    const heads = Array.from({ length: 100 }, (_, index) => {
      const sessionId = `s${index}`;
      return makeHead({
        reference: { agentName: "test", sessionId },
      });
    });
    const target = heads.at(-1)!;
    const agent = new TestAgent(
      {
        ...makeDetail(),
        reference: target.reference,
      },
      new Map(),
    );
    const scanResult = {
      sessions: heads,
      byAgent: { test: heads },
      agents: [agent],
    };
    const find = vi.spyOn(heads, "find");

    const first = materializeSessionDetail(scanResult, {
      agentName: "test",
      sessionId: target.reference.sessionId,
    });
    const second = materializeSessionDetail(scanResult, {
      agentName: "test",
      sessionId: target.reference.sessionId,
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
