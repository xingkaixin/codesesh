import {
  PRICING_CAPTURE_EPOCH,
  synchronizeSessionSources,
  type BaseAgent,
  type SessionCacheMeta,
  type SessionHead,
  type SessionSourceRef,
} from "@codesesh/core/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FileSystemSessionSource {
    scanSessionSourceOutcome(source: SessionSourceRef) {
      try {
        const session = (
          this as unknown as { scanSessionSource(path: string): SessionHead | null }
        ).scanSessionSource(source.sourcePath);
        if (session) return { status: "parsed" as const, source, session };
        return {
          status: "failed" as const,
          source,
          failure: {
            sessionId: source.sessionId,
            sourcePath: source.sourcePath,
            stage: "parsing" as const,
            errorClass: "Error",
            message: "source produced no session",
          },
        };
      } catch (error) {
        return {
          status: "failed" as const,
          source,
          failure: {
            sessionId: source.sessionId,
            sourcePath: source.sourcePath,
            stage: "parsing" as const,
            errorClass: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
  }

  return {
    workerData: {} as Record<string, unknown>,
    workerMessageHandler: undefined as ((message: unknown) => void) | undefined,
    postMessage: vi.fn(),
    attachMissingProjectIdentities: vi.fn((sessions: SessionHead[]) => sessions),
    createRegisteredAgents: vi.fn(),
    synchronizePricingGeneration: vi.fn(),
    ensureSessionTagsSync: vi.fn(
      (
        _agent: BaseAgent,
        sessions: SessionHead[],
        onProgress?: (processed: number, total: number) => void,
      ) => {
        onProgress?.(sessions.length, sessions.length);
        return { sessions };
      },
    ),
    FileSystemSessionSource,
    appLogger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      forwardToParent: vi.fn(),
    },
  };
});

vi.mock("node:worker_threads", () => ({
  parentPort: {
    postMessage: mocks.postMessage,
    on: vi.fn((event: string, handler: (message: unknown) => void) => {
      if (event === "message") mocks.workerMessageHandler = handler;
    }),
  },
  threadId: 17,
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("./logging.js", () => ({ appLogger: mocks.appLogger }));

vi.mock("@codesesh/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime")>();
  return {
    attachMissingProjectIdentities: mocks.attachMissingProjectIdentities,
    createRegisteredAgents: mocks.createRegisteredAgents,
    synchronizePricingGeneration: mocks.synchronizePricingGeneration,
    ensureSessionTagsSync: mocks.ensureSessionTagsSync,
    FileSystemSessionSource: mocks.FileSystemSessionSource,
    PRICING_CAPTURE_EPOCH: actual.PRICING_CAPTURE_EPOCH,
    buildAgentCacheMeta: actual.buildAgentCacheMeta,
    buildSessionPersistenceDiff: actual.buildSessionPersistenceDiff,
    computeSessionDiff: actual.computeSessionDiff,
    planAgentScan: actual.planAgentScan,
    sessionSignature: actual.sessionSignature,
    SMART_TAG_CLASSIFIER_REVISION: "smart-tags-v1",
    sortSessions: actual.sortSessions,
    synchronizeSessionSources: actual.synchronizeSessionSources,
    setCoreDiagnostics: actual.setCoreDiagnostics,
  };
});

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    title: id,
    directory: "/workspace",
    time_created: Date.now(),
    time_updated: Date.now(),
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function currentPricingMeta(meta: SessionCacheMeta): SessionCacheMeta {
  return { ...meta, pricingCaptureEpoch: PRICING_CAPTURE_EPOCH };
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  let sessionMeta: Record<string, SessionCacheMeta> = {};
  const agent = Object.assign(new mocks.FileSystemSessionSource(), {
    name: "codex",
    isAvailable: vi.fn(() => true),
    scan: vi.fn(() => []),
    incrementalScan: vi.fn(() => []),
    listSessionSources: vi.fn(() => []),
    scanSessionSource: vi.fn(() => null),
    expandChangedSessionIds: vi.fn((changedIds: string[]) => changedIds),
    filterCachedSessions: vi.fn((sessions: SessionHead[]) => sessions),
    getSessionData: vi.fn(),
    getSessionCacheMeta: vi.fn((sessionId: string) => sessionMeta[sessionId]),
    snapshotSessionCacheMeta: vi.fn(() => structuredClone(sessionMeta)),
    restoreSessionCacheMeta: vi.fn((next: Readonly<Record<string, SessionCacheMeta>>) => {
      sessionMeta = structuredClone(next);
    }),
    removeSessionCacheMeta: vi.fn((sessionIds: Iterable<string>) => {
      for (const sessionId of sessionIds) delete sessionMeta[sessionId];
    }),
    ...overrides,
  });
  return Object.assign(agent, {
    sessionSourceAccess: {
      kind: "enumerated" as const,
      synchronize: (
        baseline: Parameters<typeof synchronizeSessionSources>[1],
        request: Parameters<typeof synchronizeSessionSources>[2],
      ) => synchronizeSessionSources(agent as never, baseline, request),
      count: () => agent.listSessionSources().length,
    },
  });
}

function makeGenericAgent(overrides: Record<string, unknown> = {}) {
  const agent = { ...makeAgent(overrides) };
  return Object.assign(agent, {
    sessionSourceAccess: {
      kind: "aggregate" as const,
      checkForChanges: () => ({ hasChanges: false, timestamp: 0 }),
      commitChangeCheck: () => {},
      incrementalScan: (...args: unknown[]) =>
        (agent.incrementalScan as (...values: unknown[]) => unknown)(...args),
    },
  });
}

function setWorkerData(overrides: Record<string, unknown> = {}) {
  mocks.workerData = {
    type: "run",
    requestId: 1,
    agentName: "codex",
    pricingGenerationId: 17,
    previousSessions: [],
    operation: { kind: "full-scan" },
    scanOptions: { fast: true },
    meta: {},
    ...overrides,
  };
}

async function runWorker() {
  await import("./scan-refresh-worker.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.workerMessageHandler = undefined;
  mocks.attachMissingProjectIdentities.mockImplementation((sessions) => sessions);
  mocks.ensureSessionTagsSync.mockImplementation((_agent, sessions, onProgress) => {
    onProgress?.(sessions.length, sessions.length);
    return { sessions };
  });
  setWorkerData();
});

describe("scan refresh worker entry", () => {
  it("synchronizes pricing before creating agents", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();

    expect(mocks.appLogger.forwardToParent).toHaveBeenCalledWith(
      expect.objectContaining({ postMessage: mocks.postMessage }),
      17,
    );
    expect(mocks.synchronizePricingGeneration).toHaveBeenCalledWith(17);
    expect(mocks.synchronizePricingGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRegisteredAgents.mock.invocationCallOrder[0]!,
    );
  });

  it("reports an unknown agent as an error", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: "Unknown agent: codex" }),
    );
  });

  it("fails unavailable agents without staging an empty complete snapshot", async () => {
    const retained = makeSession("retained");
    const agent = makeAgent({ isAvailable: vi.fn(() => false) });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      previousSessions: [retained],
      meta: { retained: { id: "retained", sourcePath: "/workspace/retained" } },
    });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "error",
        error: "Agent codex became unavailable during scan",
        errorCode: "agent-unavailable-during-scan",
      }),
    );
    expect(mocks.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "done" }));
    expect(agent.scan).not.toHaveBeenCalled();
    expect(mocks.appLogger.warn).toHaveBeenCalledWith("scan.refresh_worker.agent_unavailable", {
      agent: "codex",
      operation: "full-scan",
    });
  });

  it("inherits cached smart tags so an unchanged full rescan reports no changes", async () => {
    // scan() rebuilds heads without smart tags; without inheritance every
    // rescan would reclassify (and re-publish) every settled session.
    const tagged = makeSession("steady", {
      time_created: 1_000,
      time_updated: 1_000,
      smart_tags: ["feature-dev"],
      smart_tags_source_updated_at: 1_000,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const rebuilt = makeSession("steady", { time_created: 1_000, time_updated: 1_000 });
    const meta = { steady: { id: "steady", sourcePath: "/database" } };
    const agent = makeGenericAgent({
      scan: vi.fn(() => [rebuilt]),
      snapshotSessionCacheMeta: vi.fn(() => meta),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({ previousSessions: [tagged], meta });

    await runWorker();

    expect(mocks.ensureSessionTagsSync).toHaveBeenCalledWith(
      agent,
      [
        expect.objectContaining({
          smart_tags: ["feature-dev"],
          smart_tags_source_updated_at: 1_000,
          smart_tags_classifier_revision: "smart-tags-v1",
        }),
      ],
      expect.any(Function),
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [],
        removedSessionIds: [],
        meta: {},
        removedMetaIds: [],
      }),
    );
  });

  it("runs a full scan and forwards progress", async () => {
    const session = makeSession("fresh");
    const scan = vi.fn(
      (options: { onProgress: (progress: { agent: string; current: number }) => void }) => {
        options.onProgress({ agent: "codex", current: 1 });
        return [session];
      },
    );
    const agent = makeGenericAgent({
      scan,
      snapshotSessionCacheMeta: vi.fn(() => ({
        fresh: { id: "fresh", sourcePath: "/fresh" },
      })),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);

    await runWorker();

    expect(mocks.postMessage).toHaveBeenNthCalledWith(1, {
      type: "progress",
      requestId: 1,
      generation: 0,
      progress: { agent: "codex", current: 1 },
    });
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session, sortIndex: 0 }],
        removedSessionIds: [],
        meta: { fresh: { id: "fresh", sourcePath: "/fresh" } },
        removedMetaIds: [],
      }),
    );
  });

  it("coalesces a synchronous progress burst and flushes its latest value", async () => {
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(0);
    const scan = vi.fn((options: { onProgress: (progress: object) => void }) => {
      for (let processed = 1; processed <= 10_000; processed += 1) {
        options.onProgress({ phase: "scanning", total: 10_000, processed });
      }
      return [];
    });
    mocks.createRegisteredAgents.mockReturnValue([makeGenericAgent({ scan })]);

    try {
      await runWorker();
    } finally {
      nowSpy.mockRestore();
    }

    const progressMessages = mocks.postMessage.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "progress");
    expect(progressMessages).toEqual([
      expect.objectContaining({ progress: expect.objectContaining({ processed: 1 }) }),
      expect.objectContaining({ progress: expect.objectContaining({ processed: 10_000 }) }),
    ]);
    expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ type: "done" }),
    );
  });

  it("reuses a committed baseline without receiving the full history again", async () => {
    const session = makeSession("stateful");
    const scan = vi.fn(() => [session]);
    mocks.createRegisteredAgents.mockReturnValue([makeGenericAgent({ scan })]);
    setWorkerData({ generation: 4 });

    await runWorker();
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done", requestId: 1, generation: 4 }),
      ),
    );

    mocks.workerMessageHandler?.({ type: "commit", requestId: 1, generation: 4 });
    mocks.workerMessageHandler?.({
      type: "run",
      requestId: 2,
      agentName: "codex",
      generation: 5,
      pricingGenerationId: 17,
      operation: { kind: "recompute-derived" },
      scanOptions: {},
    });

    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "done",
          requestId: 2,
          generation: 5,
          changes: [],
          removedSessionIds: [],
        }),
      ),
    );
    expect(scan).toHaveBeenCalledTimes(1);
    expect(mocks.createRegisteredAgents).toHaveBeenCalledTimes(1);
    expect(mocks.synchronizePricingGeneration).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an operation skips the committed generation", async () => {
    mocks.createRegisteredAgents.mockReturnValue([makeAgent({ scan: vi.fn(() => []) })]);
    setWorkerData({ generation: 2 });

    await runWorker();
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done", requestId: 1, generation: 2 }),
      ),
    );
    mocks.workerMessageHandler?.({ type: "commit", requestId: 1, generation: 2 });
    mocks.workerMessageHandler?.({
      type: "run",
      requestId: 2,
      agentName: "codex",
      generation: 4,
      pricingGenerationId: 17,
      operation: { kind: "recompute-derived" },
      scanOptions: {},
    });

    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          requestId: 2,
          generation: 4,
          error: "Worker generation mismatch: expected 3, received 4",
        }),
      ),
    );
  });

  it("reports a rejected commit and continues processing later requests", async () => {
    mocks.createRegisteredAgents.mockReturnValue([makeAgent({ scan: vi.fn(() => []) })]);
    setWorkerData({ generation: 4 });

    await runWorker();
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done", requestId: 1, generation: 4 }),
      ),
    );
    mocks.workerMessageHandler?.({ type: "commit", requestId: 1, generation: 5 });
    mocks.workerMessageHandler?.({ type: "commit", requestId: 1, generation: 4 });
    mocks.workerMessageHandler?.({
      type: "run",
      requestId: 2,
      agentName: "codex",
      generation: 5,
      pricingGenerationId: 17,
      operation: { kind: "recompute-derived" },
      scanOptions: {},
    });

    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          requestId: 1,
          generation: 5,
          error: "Worker commit generation mismatch: expected 4, received 5",
        }),
      ),
    );
    await vi.waitFor(() =>
      expect(mocks.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "done", requestId: 2, generation: 5 }),
      ),
    );
  });

  it("emits a durable head checkpoint before metadata finalization", async () => {
    const session = makeSession("fresh", { time_updated: 1 });
    const agent = makeAgent({
      listSessionSources: vi.fn(() => [
        { sessionId: "fresh", sourcePath: "/fresh", fingerprint: "fresh" },
      ]),
      scanSessionSource: vi.fn(() => session),
      snapshotSessionCacheMeta: vi.fn(() => ({ fresh: { sourcePath: "/fresh" } })),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({ operation: { kind: "full-scan", checkpoint: "durable" } });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          stage: "scanned",
          sessions: [session],
          completeness: "complete",
        }),
      }),
    );
    expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        type: "done",
        completeness: "complete",
        explicitRemovedSessionIds: [],
      }),
    );
  });

  it("marks a windowed head checkpoint as partial", async () => {
    const agent = makeAgent({ scan: vi.fn(() => []) });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "full-scan", checkpoint: "durable" },
      scanOptions: { fast: true, from: 1 },
    });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          stage: "scanned",
          completeness: "partial",
        }),
      }),
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", completeness: "partial" }),
    );
  });

  it("keeps a failed cached source in a partial full-scan checkpoint", async () => {
    const cached = makeSession("cached");
    const agent = makeAgent({
      listSessionSources: vi.fn(() => [
        { sessionId: "cached", sourcePath: "/cached", fingerprint: "new" },
      ]),
      scanSessionSource: vi.fn(() => null),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "full-scan", checkpoint: "durable" },
      previousSessions: [cached],
      meta: {
        cached: { id: "cached", sourcePath: "/cached", sourceFingerprint: "old" },
      },
    });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          sessions: [cached],
          completeness: "partial",
        }),
      }),
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        removedSessionIds: [],
        sourceFailures: [expect.objectContaining({ sessionId: "cached" })],
      }),
    );
  });

  it("re-parses only changed sources and forwards progress", async () => {
    const session = makeSession("changed");
    const scanSessionSource = vi.fn(() => session);
    const agent = makeAgent({
      scanSessionSource,
      listSessionSources: vi.fn(() => [
        { sessionId: "changed", sourcePath: "/changed", fingerprint: "new" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [makeSession("changed")],
      meta: {
        changed: {
          id: "changed",
          sourcePath: "/changed",
          sourceFingerprint: "old",
        },
      },
    });

    await runWorker();

    expect(agent.scan).not.toHaveBeenCalled();
    expect(scanSessionSource).toHaveBeenCalledWith("/changed");
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "progress",
        progress: { total: 1, processed: 1, sessions: 1 },
      }),
    );
  });

  it("keeps unchanged heads and their smart tags without re-parsing them", async () => {
    const unchanged = makeSession("unchanged", {
      smart_tags: ["bugfix"],
      smart_tags_source_updated_at: 1,
      time_created: 1,
      time_updated: 1,
    });
    const changed = makeSession("changed", { time_created: 1, time_updated: 1 });
    const scanSessionSource = vi.fn(() => changed);
    const agent = makeAgent({
      scanSessionSource,
      listSessionSources: vi.fn(() => [
        { sessionId: unchanged.reference.sessionId, sourcePath: "/unchanged", fingerprint: "same" },
        { sessionId: changed.reference.sessionId, sourcePath: "/changed", fingerprint: "new" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh", checkpoint: "durable" },
      previousSessions: [
        unchanged,
        makeSession(changed.reference.sessionId, { time_created: 1, time_updated: 1 }),
      ],
      meta: {
        unchanged: currentPricingMeta({
          id: unchanged.reference.sessionId,
          sourcePath: "/unchanged",
          sourceFingerprint: "same",
        }),
        changed: {
          id: changed.reference.sessionId,
          sourcePath: "/changed",
          sourceFingerprint: "old",
        },
      },
    });

    await runWorker();

    expect(scanSessionSource).not.toHaveBeenCalledWith("/unchanged");
    const scannedCheckpoint = mocks.postMessage.mock.calls
      .map(([message]) => message)
      .find((message) => message?.type === "checkpoint" && message.checkpoint.stage === "scanned");
    expect(scannedCheckpoint?.checkpoint.sessions).toContainEqual(
      expect.objectContaining({
        reference: unchanged.reference,
        smart_tags: ["bugfix"],
        smart_tags_source_updated_at: 1,
      }),
    );
  });

  it("re-parses sessions pulled in by changed-id expansion", async () => {
    const parent = makeSession("parent");
    const child = makeSession("child", {
      parent_reference: { agentName: "codex", sessionId: "parent" },
    });
    const scanSessionSource = vi.fn((sourcePath: string) =>
      sourcePath === "/parent" ? parent : child,
    );
    const expandChangedSessionIds = vi.fn((ids: string[]) =>
      ids.includes("child") ? [...new Set([...ids, "parent"])] : ids,
    );
    const agent = makeAgent({
      scanSessionSource,
      expandChangedSessionIds,
      listSessionSources: vi.fn(() => [
        { sessionId: "parent", sourcePath: "/parent", fingerprint: "same" },
        { sessionId: "child", sourcePath: "/child", fingerprint: "new" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [parent, makeSession("child")],
      meta: {
        parent: currentPricingMeta({
          id: "parent",
          sourcePath: "/parent",
          sourceFingerprint: "same",
        }),
        child: { id: "child", sourcePath: "/child", sourceFingerprint: "old" },
      },
    });

    await runWorker();

    expect(expandChangedSessionIds).toHaveBeenCalledWith(
      ["child"],
      expect.arrayContaining([expect.objectContaining({ sessionId: "parent" })]),
    );
    expect(scanSessionSource).toHaveBeenCalledWith("/child");
    expect(scanSessionSource).toHaveBeenCalledWith("/parent");
  });

  it("resumes backfill finalization after the durable cursor", async () => {
    const newest = makeSession("newest", {
      time_created: 3_000,
      time_updated: 3_000,
      smart_tags: [],
      smart_tags_source_updated_at: 1,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const cursor = makeSession("cursor", {
      time_created: 2_000,
      time_updated: 2_000,
      smart_tags: [],
      smart_tags_source_updated_at: 2_000,
      smart_tags_classifier_revision: "smart-tags-v1",
    });
    const next = makeSession("next", { time_created: 1_000, time_updated: 1_000 });
    const agent = makeAgent({
      listSessionSources: vi.fn(() =>
        [newest, cursor, next].map((session) => ({
          sessionId: session.reference.sessionId,
          sourcePath: `/${session.reference.sessionId}`,
          fingerprint: "same",
        })),
      ),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "backfill", cursor: cursor.reference.sessionId, checkpoint: "durable" },
      previousSessions: [newest, cursor, next],
      meta: Object.fromEntries(
        [newest, cursor, next].map((session) => [
          session.reference.sessionId,
          {
            id: session.reference.sessionId,
            sourcePath: `/${session.reference.sessionId}`,
            sourceFingerprint: "same",
          },
        ]),
      ),
    });

    await runWorker();

    expect(mocks.ensureSessionTagsSync).toHaveBeenCalledWith(
      agent,
      [newest, next],
      expect.any(Function),
    );
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          stage: "finalizing",
          backfillCursor: next.reference.sessionId,
        }),
      }),
    );
  });

  it("preserves cached sessions outside a windowed sync", async () => {
    const old = makeSession("old", { time_updated: 1 });
    const recent = makeSession("recent", { time_updated: 10, title: "new" });
    const scanSessionSource = vi.fn(() => recent);
    const agent = makeAgent({
      scanSessionSource,
      listSessionSources: vi.fn(() => [
        { sessionId: "recent", sourcePath: "/recent", fingerprint: "new" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [recent, old],
      scanOptions: { from: 5, fast: true },
      meta: {
        recent: {
          id: "recent",
          sourcePath: "/recent",
          sourceFingerprint: "old",
          sourceMtimeMs: 10,
        },
        old: {
          id: "old",
          sourcePath: "/old",
          sourceFingerprint: "same",
          sourceMtimeMs: 1,
        },
      },
    });

    await runWorker();

    expect(scanSessionSource).toHaveBeenCalledWith("/recent");
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session: recent, sortIndex: 0 }],
        removedSessionIds: [],
        removedMetaIds: [],
      }),
    );
    expect(mocks.ensureSessionTagsSync).toHaveBeenCalledWith(agent, [recent], expect.any(Function));
  });

  it("returns a head when only its metadata changes", async () => {
    const session = makeSession("same");
    let meta: Record<string, SessionCacheMeta> = {};
    const agent = makeGenericAgent({
      scan: vi.fn(() => {
        meta.same = {
          id: "same",
          sourcePath: "/same",
          sourceFingerprint: "new",
        };
        return [session];
      }),
      snapshotSessionCacheMeta: vi.fn(() => meta),
      restoreSessionCacheMeta: vi.fn((next: Readonly<Record<string, SessionCacheMeta>>) => {
        meta = structuredClone(next);
      }),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      previousSessions: [session],
      meta: {
        same: {
          id: "same",
          sourcePath: "/same",
          sourceFingerprint: "old",
        },
      },
    });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session, sortIndex: 0 }],
        removedSessionIds: [],
        meta: {
          same: {
            id: "same",
            sourcePath: "/same",
            sourceFingerprint: "new",
          },
        },
        removedMetaIds: [],
      }),
    );
  });

  it("returns an empty delta when source heads and metadata are unchanged", async () => {
    const session = makeSession("unchanged");
    const scanSessionSource = vi.fn();
    const agent = makeAgent({
      listSessionSources: vi.fn(() => [
        { sessionId: "unchanged", sourcePath: "/unchanged", fingerprint: "same" },
      ]),
      scanSessionSource,
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [session],
      meta: {
        unchanged: currentPricingMeta({
          id: "unchanged",
          sourcePath: "/unchanged",
          sourceFingerprint: "same",
        }),
      },
    });

    await runWorker();

    expect(scanSessionSource).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [],
        removedSessionIds: [],
        meta: {},
        removedMetaIds: [],
      }),
    );
  });

  it("does not finalize unchanged sessions outside a bounded refresh delta", async () => {
    const recent = makeSession("recent", { time_updated: 10 });
    const agent = makeAgent({
      listSessionSources: vi.fn(() => [
        { sessionId: "recent", sourcePath: "/recent", fingerprint: "same" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [recent],
      scanOptions: { from: 5, fast: true },
      meta: {
        recent: currentPricingMeta({
          id: "recent",
          sourcePath: "/recent",
          sourceFingerprint: "same",
          sourceMtimeMs: 10,
        }),
      },
    });

    await runWorker();

    expect(mocks.ensureSessionTagsSync).not.toHaveBeenCalled();
  });

  it("synchronizes parsed, failed, removed, and out-of-window sources", async () => {
    const unchanged = makeSession("unchanged", { time_updated: 500 });
    const changed = makeSession("changed", { title: "old", time_updated: 400 });
    const removed = makeSession("removed", { time_updated: 300 });
    const outsideWindow = makeSession("outside", { time_updated: 200 });
    const moved = makeSession("moved", { time_updated: 100 });
    const updated = makeSession("changed", { title: "new", time_updated: 400 });
    const refs: SessionSourceRef[] = [
      {
        sessionId: "unchanged",
        sourcePath: "/unchanged",
        fingerprint: "same",
      },
      {
        sessionId: "changed",
        sourcePath: "/changed",
        fingerprint: "different",
      },
      {
        sessionId: "moved",
        sourcePath: "/moved-to",
        fingerprint: "same",
      },
      {
        sessionId: "missing",
        sourcePath: "/missing",
        fingerprint: "new",
      },
    ];
    const scanSessionSource = vi.fn((sourcePath: string) =>
      sourcePath === "/changed" ? updated : null,
    );
    const agent = makeAgent({
      listSessionSources: vi.fn(() => refs),
      scanSessionSource,
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [unchanged, changed, removed, outsideWindow, moved],
      // from: 5 puts `outside` (mtime 0) before the window and `removed`
      // (mtime 10) inside it, so only the latter counts as deleted on disk.
      scanOptions: { from: 5, fast: true },
      meta: {
        unchanged: currentPricingMeta({
          id: "unchanged",
          sourcePath: "/unchanged",
          sourceFingerprint: "same",
        }),
        changed: { id: "changed", sourcePath: "/changed", sourceFingerprint: "old" },
        removed: { id: "removed", sourcePath: "/removed", sourceMtimeMs: 10 },
        outside: { id: "outside", sourcePath: "/outside", sourceMtimeMs: 0 },
        // Same fingerprint, different path — a relocated file still needs re-parsing.
        moved: { id: "moved", sourcePath: "/moved-from", sourceFingerprint: "same" },
      },
    });

    await runWorker();

    expect(scanSessionSource).toHaveBeenCalledTimes(3);
    expect(scanSessionSource).toHaveBeenCalledWith("/changed");
    expect(scanSessionSource).toHaveBeenCalledWith("/moved-to");
    expect(scanSessionSource).toHaveBeenCalledWith("/missing");
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session: updated, sortIndex: 1 }],
        removedSessionIds: ["removed"],
        removedMetaIds: ["removed"],
        completeness: "partial",
        explicitRemovedSessionIds: ["removed"],
        // `missing` has no retained baseline session, so its parse failure is
        // logged and skipped instead of being reported as a source failure.
        sourceFailures: [expect.objectContaining({ sessionId: "moved", stage: "parsing" })],
      }),
    );
    expect(mocks.appLogger.warn).toHaveBeenCalledWith(
      "agent.session_source_outcome",
      expect.objectContaining({
        session_id: "moved",
        outcome: "failed",
        error_class: "Error",
      }),
    );
  });

  it("re-parses a cached session whose fingerprint format changed", async () => {
    const cached = makeSession("legacy");
    const reparsed = makeSession("legacy", { title: "reparsed" });
    const scanSessionSource = vi.fn(() => reparsed);
    const agent = makeAgent({
      listSessionSources: vi.fn(() => [
        { sessionId: "legacy", sourcePath: "/legacy", fingerprint: '["v2",2,42,7,null]' },
      ]),
      scanSessionSource,
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      operation: { kind: "source-refresh" },
      previousSessions: [cached],
      meta: {
        // Written by an older parser version: same file, but the head it produced
        // is no longer what the current parser would produce.
        legacy: {
          id: "legacy",
          sourcePath: "/legacy",
          sourceFingerprint: '["v2",1,42,7,null]',
          sourceMtimeMs: 42,
        },
      },
    });

    await runWorker();

    expect(scanSessionSource).toHaveBeenCalledWith("/legacy");
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session: reparsed, sortIndex: 0 }],
        removedSessionIds: [],
        removedMetaIds: [],
      }),
    );
  });
});
