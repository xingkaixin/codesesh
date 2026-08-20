import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachMissingProjectIdentities,
  FileSystemSessionSource,
  SMART_TAG_CLASSIFIER_REVISION,
} from "@codesesh/core";
import type {
  AggregateSessionSourceCapability,
  BaseAgent,
  IdentifiedSessionHead,
  loadCachedSessions,
  LiveSnapshot,
  PendingSearchIndexMaintenance,
  SessionCacheMeta,
  SessionHead,
  SessionSourceFailure,
} from "@codesesh/core";
import type { ScanStatusEvent } from "@codesesh/core/contract";
import type { WorkerResult, WorkerRunner } from "./worker-runner.js";
import { appLogger } from "./logging.js";
import { AgentUnavailableDuringScanError } from "./scan-refresh-error.js";
import type { ScanStatusModel } from "./scan-status-model.js";

const core = vi.hoisted(() => {
  const getAgentLastFullSyncAt = vi.fn(() => Date.now());
  const isAgentCacheInitialized = vi.fn(() => true);
  const loadCachedSessionsMock = vi.fn(
    (_agentName?: string): ReturnType<typeof loadCachedSessions> => null,
  );
  return {
    getAgentFullSyncCursor: vi.fn(() => null as string | null),
    getAgentLastFullSyncAt,
    isAgentCacheInitialized,
    readAgentCacheInitialization: vi.fn<
      () => { status: "success"; value: boolean } | { status: "failed" }
    >(() => ({
      status: "success",
      value: isAgentCacheInitialized(),
    })),
    readAgentLastFullSyncAt: vi.fn<
      () => { status: "success"; value: number | null } | { status: "failed" }
    >(() => ({
      status: "success",
      value: getAgentLastFullSyncAt(),
    })),
    loadCachedSessions: loadCachedSessionsMock,
    readCachedSessions: vi.fn(
      (
        agentName: string,
      ):
        | { status: "success"; value: ReturnType<typeof loadCachedSessions> }
        | {
            status: "failed";
          } => ({ status: "success", value: loadCachedSessionsMock(agentName) }),
    ),
    readPendingSearchIndexMaintenance: vi.fn<
      (_agentName: string, _limit: number) => PendingSearchIndexMaintenance | null
    >(() => ({ sessionIds: [], total: 0 })),
    markAgentFullSyncStarted: vi.fn(() => true),
    markAgentFullSyncCompleted: vi.fn(() => true),
    markAgentFullSyncProgress: vi.fn(() => true),
    sessionSignature: vi.fn(),
  };
});

const searchIndex = vi.hoisted(() => ({
  enqueue: vi.fn<(...args: unknown[]) => Promise<undefined>>(async (...args: unknown[]) => {
    const onStarted = args[2];
    if (typeof onStarted === "function") onStarted();
    return undefined;
  }),
  enqueueMaintenance: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  snapshot: vi.fn(() => ({ activeBatchId: undefined, pendingBatches: 0 })),
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@codesesh/core")>();
  // Spy that still delegates to the real implementation, so diff behavior is unchanged.
  core.sessionSignature.mockImplementation(original.sessionSignature);
  return {
    ...original,
    getAgentFullSyncCursor: core.getAgentFullSyncCursor,
    getAgentLastFullSyncAt: core.getAgentLastFullSyncAt,
    isAgentCacheInitialized: core.isAgentCacheInitialized,
    readAgentCacheInitialization: core.readAgentCacheInitialization,
    readAgentLastFullSyncAt: core.readAgentLastFullSyncAt,
    loadCachedSessions: core.loadCachedSessions,
    readCachedSessions: core.readCachedSessions,
    readPendingSearchIndexMaintenance: core.readPendingSearchIndexMaintenance,
    markAgentFullSyncStarted: core.markAgentFullSyncStarted,
    markAgentFullSyncCompleted: core.markAgentFullSyncCompleted,
    markAgentFullSyncProgress: core.markAgentFullSyncProgress,
    sessionSignature: core.sessionSignature,
    SMART_TAG_CLASSIFIER_REVISION: "smart-tags-v1",
  };
});

vi.mock("./search-index-job-runner.js", () => ({
  SearchIndexJobRunner: class {
    enqueue = searchIndex.enqueue;
    enqueueMaintenance = searchIndex.enqueueMaintenance;
    shutdown = searchIndex.shutdown;
    snapshot = searchIndex.snapshot;
  },
}));

import { AgentSyncEngine } from "./agent-sync-engine.js";

function makeSession(id: string, title = id): IdentifiedSessionHead {
  const session: SessionHead = {
    reference: { agentName: "codex", sessionId: id },
    id,
    slug: `codex/${id}`,
    title,
    directory: "/workspace",
    time_created: 1,
    time_updated: 1,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
  return attachMissingProjectIdentities([session])[0]!;
}

type TestAggregateAgent = BaseAgent & {
  checkForChanges: AggregateSessionSourceCapability["checkForChanges"];
  commitChangeCheck: AggregateSessionSourceCapability["commitChangeCheck"];
  incrementalScan: AggregateSessionSourceCapability["incrementalScan"];
};

type TestAgentOverrides = Partial<BaseAgent> &
  Partial<Pick<TestAggregateAgent, "checkForChanges" | "commitChangeCheck" | "incrementalScan">>;

function makeAgent(overrides: TestAgentOverrides = {}): TestAggregateAgent {
  let meta: Record<string, SessionCacheMeta> = {};
  const agent = {
    name: "codex",
    displayName: "Codex",
    isAvailable: () => true,
    scan: () => [],
    checkForChanges: () => ({ hasChanges: false, timestamp: Date.now() }),
    commitChangeCheck: () => undefined,
    incrementalScan: (sessions: SessionHead[]) => sessions,
    getSessionData: () => ({ messages: [] }) as never,
    getSessionWatchPlan: () => ({ status: "not-needed" as const, reason: "test adapter" }),
    getSessionCacheMeta: (sessionId: string) => meta[sessionId],
    snapshotSessionCacheMeta: () => structuredClone(meta),
    restoreSessionCacheMeta: (next: Readonly<Record<string, SessionCacheMeta>>) => {
      meta = structuredClone(next);
    },
    removeSessionCacheMeta: (sessionIds: Iterable<string>) => {
      for (const sessionId of sessionIds) delete meta[sessionId];
    },
    ...overrides,
  } as unknown as TestAggregateAgent;
  return Object.assign(agent, {
    sessionSourceAccess: {
      kind: "aggregate" as const,
      checkForChanges: (...args: Parameters<TestAggregateAgent["checkForChanges"]>) =>
        agent.checkForChanges(...args),
      commitChangeCheck: () => agent.commitChangeCheck(),
      incrementalScan: (...args: Parameters<TestAggregateAgent["incrementalScan"]>) =>
        agent.incrementalScan(...args),
    },
  });
}

class FakeSyncAgent extends FileSystemSessionSource {
  readonly name = "codex";
  readonly displayName = "Codex";

  isAvailable(): boolean {
    return true;
  }

  listSessionSources() {
    return [];
  }

  scanSessionSource() {
    return null;
  }

  getSessionData() {
    return { messages: [] } as never;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "sync test adapter" };
  }
}

function workerResult(
  result: Omit<WorkerResult, "completeness" | "explicitRemovedSessionIds">,
  completeness: WorkerResult["completeness"] = "complete",
): WorkerResult {
  return { ...result, completeness, explicitRemovedSessionIds: [] };
}

function makeWorkerRunner(): WorkerRunner {
  return {
    activeCount: 0,
    run: vi.fn(async (_agentName, payload) =>
      workerResult(
        {
          sessions: payload.operation.kind === "recompute-derived" ? payload.previousSessions : [],
          meta: payload.meta,
        },
        payload.scanOptions.from == null && payload.scanOptions.to == null ? "complete" : "partial",
      ),
    ),
    commit: vi.fn(),
    discard: vi.fn(),
    shutdown: vi.fn(async () => undefined),
  };
}

function makeEngine(
  agent: BaseAgent,
  sessions: IdentifiedSessionHead[] = [],
  workerRunner: WorkerRunner = makeWorkerRunner(),
  startupScanOptions: { from?: number; to?: number } = {},
) {
  const state: LiveSnapshot = {
    agents: [agent],
    byAgent: { [agent.name]: sessions },
    sessions,
  };
  const engine = new AgentSyncEngine({ workerRunner, startupScanOptions });
  engine.initialize(state);
  return { engine };
}

function expectValidBackfillStatus(status: ScanStatusEvent["backfill"]): void {
  const terminalAgents = new Set([...status.completedAgents, ...status.failedAgents]);
  expect(terminalAgents.size).toBe(status.completedAgents.length + status.failedAgents.length);
  expect(status.progress == null || status.currentAgent != null).toBe(true);
  expect(status.currentAgent == null || !status.pendingAgents.includes(status.currentAgent)).toBe(
    true,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  core.getAgentLastFullSyncAt.mockReturnValue(Date.now());
  core.isAgentCacheInitialized.mockReturnValue(true);
  core.loadCachedSessions.mockReturnValue(null);
  core.readPendingSearchIndexMaintenance.mockReturnValue({ sessionIds: [], total: 0 });
  core.markAgentFullSyncStarted.mockClear();
  core.markAgentFullSyncProgress.mockClear();
  searchIndex.enqueue.mockImplementation(async (...args: unknown[]) => {
    const onStarted = args[2];
    if (typeof onStarted === "function") onStarted();
    return undefined;
  });
  searchIndex.enqueueMaintenance.mockImplementation(async () => undefined);
});

describe("AgentSyncEngine", () => {
  it("schedules migration reindex work as separate background maintenance", async () => {
    const session = makeSession("legacy");
    core.loadCachedSessions.mockReturnValue({
      sessions: [session],
      meta: { legacy: { id: "legacy", sourcePath: "/legacy" } },
      timestamp: Date.now(),
    });
    core.readPendingSearchIndexMaintenance
      .mockReturnValueOnce({ sessionIds: [session.id], total: 1 })
      .mockReturnValueOnce({ sessionIds: [], total: 0 });
    const { engine } = makeEngine(makeAgent(), [session]);

    await engine.refresh("codex");
    await vi.waitFor(() => expect(searchIndex.enqueueMaintenance).toHaveBeenCalledOnce());

    expect(searchIndex.enqueueMaintenance).toHaveBeenCalledWith("search.maintenance", [
      expect.objectContaining({
        kind: "maintenance",
        agentName: "codex",
        changes: [expect.objectContaining({ session })],
        searchIndexOptions: { isBulk: false },
      }),
    ]);
  });

  it("loads cached sessions once across a refresh and its backfill decision", async () => {
    const session = makeSession("cached");
    core.loadCachedSessions.mockReturnValue({
      sessions: [session],
      meta: {},
      timestamp: Date.now(),
    });
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) =>
        workerResult({
          sessions: payload.previousSessions,
          meta: payload.meta,
          changedIds: [],
        }),
      ),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(new FakeSyncAgent(), [session], workerRunner, { from: 1 });

    await engine.refresh("codex");

    expect(core.loadCachedSessions).toHaveBeenCalledOnce();
  });

  it("skips source availability work until the full-sync interval expires", () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-12T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    core.getAgentLastFullSyncAt.mockReturnValue(now);
    const agent = new FakeSyncAgent();
    const isAvailable = vi.spyOn(agent, "isAvailable");
    const listSessionSources = vi.spyOn(agent, "listSessionSources");
    const { engine } = makeEngine(agent, [], makeWorkerRunner(), { from: 1 });
    const internal = engine as unknown as {
      needsBackfill(candidate: BaseAgent, cached: ReturnType<typeof loadCachedSessions>): boolean;
    };
    const cached = { sessions: [], meta: {}, timestamp: Date.now() };

    expect(internal.needsBackfill(agent, cached)).toBe(false);
    expect(internal.needsBackfill(agent, cached)).toBe(false);

    expect(isAvailable).toHaveBeenCalledOnce();
    expect(listSessionSources).toHaveBeenCalledOnce();
    expect(core.readAgentLastFullSyncAt).toHaveBeenCalledOnce();
    expect(core.loadCachedSessions).not.toHaveBeenCalled();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    expect(internal.needsBackfill(agent, cached)).toBe(true);
    expect(isAvailable).toHaveBeenCalledTimes(2);
    expect(listSessionSources).toHaveBeenCalledOnce();
    expect(core.readAgentLastFullSyncAt).toHaveBeenCalledTimes(2);
  });

  it("keeps the current snapshot when cache initialization cannot be read", async () => {
    core.readAgentCacheInitialization.mockReturnValueOnce({ status: "failed" });
    const previous = makeSession("session", "retained");
    const workerRunner = makeWorkerRunner();
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(makeAgent(), [previous], workerRunner);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([previous]);
    expect(workerRunner.run).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("scan.refresh.cache_state_unavailable", {
      agent: "codex",
      state: "initialization",
    });
  });

  it("commits the change check only after the consuming scan succeeds", async () => {
    const commitChangeCheck = vi.fn();
    const agent = makeAgent({
      commitChangeCheck,
      checkForChanges: () => ({ hasChanges: true, timestamp: Date.now() }),
    });
    const workerRunner = makeWorkerRunner();
    vi.mocked(workerRunner.run).mockRejectedValueOnce(new Error("worker crashed"));
    const { engine } = makeEngine(agent, [makeSession("session")], workerRunner);

    await engine.refresh("codex");
    expect(commitChangeCheck).not.toHaveBeenCalled();

    await engine.refresh("codex");
    expect(commitChangeCheck).toHaveBeenCalledOnce();
  });

  it("completes the refresh when the backfill probe throws", async () => {
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(makeAgent(), []);
    const internal = engine as unknown as { needsBackfill: () => boolean };
    internal.needsBackfill = () => {
      throw new Error("probe boom");
    };

    await expect(engine.refresh("codex")).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "scan.refresh.backfill_probe_failed",
      expect.objectContaining({ agent: "codex" }),
    );
  });

  it("does not enqueue a backfill when cached sessions cannot be read", () => {
    core.readCachedSessions.mockReturnValueOnce({ status: "failed" });
    const agent = new FakeSyncAgent();
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(agent, [], makeWorkerRunner(), { from: 1 });
    const internal = engine as unknown as { needsBackfill(candidate: BaseAgent): boolean };

    expect(internal.needsBackfill(agent)).toBe(false);
    expect(warn).toHaveBeenCalledWith("scan.backfill.cache_state_unavailable", {
      agent: "codex",
      state: "cached_sessions",
    });
  });

  it("does not report a backfill checkpoint that failed to persist", () => {
    core.markAgentFullSyncProgress.mockReturnValueOnce(false);
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(makeAgent());
    const internal = engine as unknown as {
      handleBackfillCheckpoint(agentName: string, checkpoint: unknown): void;
    };

    internal.handleBackfillCheckpoint("codex", {
      stage: "finalizing",
      backfillCursor: "cursor-1",
      changes: [],
    });

    expect(warn).toHaveBeenCalledWith("scan.backfill.checkpoint_not_durable", {
      agent: "codex",
      cursor: "cursor-1",
    });
  });

  it("does not enqueue a backfill when the full-sync timestamp cannot be read", () => {
    core.readAgentLastFullSyncAt.mockReturnValueOnce({ status: "failed" });
    const agent = makeAgent();
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(agent, [], makeWorkerRunner(), { from: 1 });
    const internal = engine as unknown as { needsBackfill(candidate: BaseAgent): boolean };

    expect(internal.needsBackfill(agent)).toBe(false);
    expect(warn).toHaveBeenCalledWith("scan.backfill.cache_state_unavailable", {
      agent: "codex",
      state: "last_full_sync",
    });
  });

  it("keeps the refresh baseline when database change detection fails", async () => {
    const previous = makeSession("session", "retained");
    const agent = makeAgent({
      checkForChanges: () => ({
        status: "failed",
        hasChanges: false,
        timestamp: 123,
        failure: {
          sourcePath: "/tmp/source.db",
          errorClass: "SqliteError",
          message: "database is locked",
        },
      }),
    });
    const workerRunner = makeWorkerRunner();
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(agent, [previous], workerRunner);
    const refreshState = engine as unknown as { lastRefreshAtByAgent: Map<string, number> };
    const baseline = refreshState.lastRefreshAtByAgent.get("codex");

    await engine.refresh("codex");

    expect(refreshState.lastRefreshAtByAgent.get("codex")).toBe(baseline);
    expect(engine.snapshot().sessions).toEqual([previous]);
    expect(workerRunner.run).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("scan.refresh.change_check_failed", {
      agent: "codex",
      source_path: "/tmp/source.db",
      error_class: "SqliteError",
      message: "database is locked",
    });
  });

  it("publishes only the latest backfill attempt terminal", async () => {
    const { engine } = makeEngine(makeAgent());
    const internal = engine as unknown as {
      enqueueBackfill(agentName: string): void;
      runBackfill(attempt: { agentName: string; attemptId: number }): Promise<unknown>;
    };
    vi.spyOn(internal, "runBackfill")
      .mockResolvedValueOnce("committed")
      .mockResolvedValueOnce("failed");
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));

    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(statuses.at(-1)?.backfill.completedAgents).toEqual(["codex"]));
    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(statuses.at(-1)?.backfill.failedAgents).toEqual(["codex"]));

    for (const status of statuses) expectValidBackfillStatus(status.backfill);
    expect(statuses.at(-1)?.backfill).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: ["codex"],
    });
  });

  it("marks a rejected backfill failed and continues the queue", async () => {
    const { engine } = makeEngine(makeAgent());
    const internal = engine as unknown as {
      backfills: { stateFor(agentName: string): { status: string } | undefined };
      enqueueBackfill(agentName: string): void;
      runBackfill(attempt: { agentName: string; attemptId: number }): Promise<unknown>;
    };
    const runBackfill = vi
      .spyOn(internal, "runBackfill")
      .mockRejectedValueOnce(new Error("backfill callback rejected"))
      .mockResolvedValueOnce("committed");
    const logError = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    engine.subscribeStatusChanged(() => {
      throw new Error("status listener rejected");
    });

    try {
      internal.enqueueBackfill("codex");
      internal.enqueueBackfill("kimi");
      await vi.waitFor(() => expect(internal.backfills.stateFor("kimi")?.status).toBe("committed"));
      expect(logError).toHaveBeenCalledWith(
        "scan.backfill.queue_error",
        expect.objectContaining({ agent: "codex", error: expect.any(Error) }),
      );
      expect(logError).toHaveBeenCalledWith(
        "scan.status_listener.error",
        expect.objectContaining({ error: expect.any(Error) }),
      );
    } finally {
      logError.mockRestore();
    }

    expect(internal.backfills.stateFor("codex")?.status).toBe("failed");
    expect(runBackfill).toHaveBeenCalledTimes(2);
  });

  it("bounds backfill progress and publishes its terminal immediately", async () => {
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        for (let processed = 1; processed <= 10_000; processed += 1) {
          payload.onProgress?.({ phase: "scanning", total: 10_000, processed });
        }
        payload.onProgress?.({ phase: "finalizing", total: 10_000, processed: 10_000 });
        return workerResult({ sessions: [], meta: {} });
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent(), [], workerRunner);
    const internal = engine as unknown as { enqueueBackfill(agentName: string): void };
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));

    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(statuses.at(-1)?.backfill.completedAgents).toEqual(["codex"]));

    const progress = statuses.flatMap((status) =>
      status.backfill.progress ? [status.backfill.progress] : [],
    );
    expect(progress).toHaveLength(5);
    expect(progress.map((item) => item.processed)).toEqual([1, 10_000, 10_000, 10_000, 10_000]);
    expect(progress.map((item) => item.phase)).toEqual([
      "scanning",
      "scanning",
      "finalizing",
      "publish-queued",
      "publishing",
    ]);
    expect(statuses.at(-1)?.backfill).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
    });
  });

  it("persists cursors from durable backfill finalization checkpoints", async () => {
    core.getAgentFullSyncCursor.mockReturnValueOnce("previous");
    const next = makeSession("next");
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        expect(payload.operation).toEqual({
          kind: "backfill",
          cursor: "previous",
          checkpoint: "durable",
        });
        expect(payload.onCheckpoint).toEqual(expect.any(Function));
        payload.onCheckpoint?.({
          stage: "scanned",
          sessions: [],
          meta: {},
          completeness: "complete",
        });
        payload.onCheckpoint?.({ stage: "finalizing", changes: [], meta: {} });
        payload.onCheckpoint?.({
          stage: "finalizing",
          changes: [{ session: next, sortIndex: 0 }],
          meta: {},
          backfillCursor: next.id,
        });
        return workerResult({ sessions: [next], meta: {} });
      }),
      commit: vi.fn(),
      discard: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(new FakeSyncAgent(), [], workerRunner);
    const internal = engine as unknown as { enqueueBackfill(agentName: string): void };
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));

    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(statuses.at(-1)?.backfill.completedAgents).toEqual(["codex"]));

    expect(core.markAgentFullSyncProgress).toHaveBeenCalledOnce();
    expect(core.markAgentFullSyncProgress).toHaveBeenCalledWith("codex", next.id);
    expect(core.markAgentFullSyncCompleted).toHaveBeenCalledWith("codex");
  });

  it("commits source failures in backfill as a partial snapshot", async () => {
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const failure: SessionSourceFailure = {
      sessionId: previous.id,
      sourcePath: "/session",
      stage: "parsing",
      errorClass: "SyntaxError",
      message: "Unexpected end of JSON input",
    };
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        payload.onCheckpoint?.({
          stage: "finalizing",
          changes: [{ session: updated, sortIndex: 0 }],
          meta: {},
          backfillCursor: "cursor-2",
        });
        return workerResult(
          {
            sessions: [updated],
            meta: {},
            changedIds: [updated.id],
            sourceFailures: [failure],
          },
          "partial",
        );
      }),
      commit: vi.fn(),
      discard: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    core.getAgentFullSyncCursor.mockReturnValueOnce("cursor-1");
    const { engine } = makeEngine(new FakeSyncAgent(), [previous], workerRunner, { from: 1 });
    const internal = engine as unknown as {
      enqueueBackfill(agentName: string): void;
      scheduler: { schedule(agentName: string, delayMs: number): void };
    };
    const schedule = vi.spyOn(internal.scheduler, "schedule").mockImplementation(() => undefined);
    const info = vi.spyOn(appLogger, "info");

    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(engine.status().backfill.completedAgents).toEqual(["codex"]));

    expect(engine.snapshot().byAgent.codex).toEqual([expect.objectContaining({ title: "after" })]);
    expect(engine.status().backfill).toMatchObject({
      completedAgents: ["codex"],
      failedAgents: [],
      partialAgents: {
        codex: {
          completeness: "partial",
          sourceFailureCount: 1,
          sourceFailureSummary: "SyntaxError: Unexpected end of JSON input",
        },
      },
    });
    expect(workerRunner.commit).toHaveBeenCalledWith("codex");
    expect(workerRunner.discard).not.toHaveBeenCalled();
    expect(workerRunner.run).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        operation: { kind: "backfill", cursor: "cursor-1", checkpoint: "durable" },
      }),
    );
    expect(core.markAgentFullSyncProgress).toHaveBeenCalledWith("codex", "cursor-2");
    expect(core.markAgentFullSyncCompleted).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith("codex", 5 * 60 * 1000);
    expect(info).toHaveBeenCalledWith("scan.backfill.retry_scheduled", {
      agent: "codex",
      delay_ms: 5 * 60 * 1000,
    });
  });

  it("cancels backfill lifecycle before awaiting shutdown", async () => {
    let resolveBackfill!: (result: "committed") => void;
    const { engine } = makeEngine(makeAgent());
    const internal = engine as unknown as {
      backfills: { stateFor(agentName: string): { status: string } | undefined };
      enqueueBackfill(agentName: string): void;
      runBackfill(attempt: { agentName: string; attemptId: number }): Promise<unknown>;
    };
    const runBackfill = vi.spyOn(internal, "runBackfill").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBackfill = resolve as (result: "committed") => void;
        }),
    );
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));
    internal.enqueueBackfill("codex");
    await vi.waitFor(() => expect(statuses.at(-1)?.backfill.currentAgent).toBe("codex"));

    await engine.shutdown();
    const statusCountAtShutdown = statuses.length;
    resolveBackfill("committed");
    await Promise.resolve();

    expect(internal.backfills.stateFor("codex")?.status).toBe("cancelled");
    expect(runBackfill).toHaveBeenCalledOnce();
    expect(statuses).toHaveLength(statusCountAtShutdown);
  });
  it("keeps the earliest refresh deadline", async () => {
    vi.useFakeTimers();
    const checkForChanges = vi.fn(() => ({ hasChanges: false, timestamp: Date.now() }));
    const { engine } = makeEngine(makeAgent({ checkForChanges }), [makeSession("existing")]);

    engine.handleAgentsChanged(["codex"]);
    await vi.advanceTimersByTimeAsync(50);
    engine.handleAgentsChanged(["codex"]);
    await vi.advanceTimersByTimeAsync(149);
    expect(checkForChanges).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(checkForChanges).toHaveBeenCalledTimes(1);
  });

  it("coalesces refreshes requested while one is running", async () => {
    vi.useFakeTimers();
    let finishFirst: (() => void) | undefined;
    const checkForChanges = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ hasChanges: false; timestamp: number }>((resolve) => {
            finishFirst = () => resolve({ hasChanges: false, timestamp: Date.now() });
          }),
      )
      .mockReturnValue({ hasChanges: false, timestamp: Date.now() });
    const { engine } = makeEngine(makeAgent({ checkForChanges }), [makeSession("existing")]);

    const first = engine.refresh("codex");
    await vi.waitFor(() => expect(checkForChanges).toHaveBeenCalledTimes(1));
    await engine.refresh("codex");
    await engine.refresh("codex");
    finishFirst?.();
    await first;
    await vi.advanceTimersByTimeAsync(100);

    expect(checkForChanges).toHaveBeenCalledTimes(2);
  });

  it("publishes session and status changes through its interface", async () => {
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const workerRunner = makeWorkerRunner();
    const incrementalScan = vi.fn(() => [updated]);
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, changedIds: [updated.id], timestamp: 2 }),
      incrementalScan,
    });
    const { engine } = makeEngine(agent, [previous], workerRunner, { from: 1, to: 2 });
    const sessionChanges = vi.fn();
    const statusChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);
    engine.subscribeStatusChanged(statusChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions[0]?.title).toBe("after");
    expect(sessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "codex",
        sessions: [expect.objectContaining({ id: updated.id, title: updated.title })],
      }),
    );
    expect(statusChanges).toHaveBeenCalledWith(
      expect.objectContaining({ type: "scan-status", active: false }),
    );
    expect(workerRunner.discard).toHaveBeenCalledWith("codex");
    expect(incrementalScan).toHaveBeenCalledWith([previous], [updated.id], undefined, {
      from: 1,
      to: 2,
    });
  });

  it("bounds progress broadcasts while preserving phase and completion", async () => {
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        for (let processed = 1; processed <= 10_000; processed += 1) {
          payload.onProgress?.({ phase: "scanning", total: 10_000, processed });
        }
        payload.onProgress?.({ phase: "finalizing", total: 10_000, processed: 10_000 });
        return workerResult({ sessions: [], meta: {} });
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent(), [], workerRunner);
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));

    await engine.refresh("codex");

    const progressStatuses = statuses.filter((status) => {
      const agentStatus = status.agentStatuses.codex;
      return (
        (agentStatus?.status === "scanning" || agentStatus?.status === "finalizing") &&
        (agentStatus.processed ?? 0) > 0
      );
    });
    expect(progressStatuses).toHaveLength(3);
    expect(progressStatuses.map((status) => status.agentStatuses.codex?.processed)).toEqual([
      1, 10_000, 10_000,
    ]);
    expect(progressStatuses.at(-1)?.agentStatuses.codex?.status).toBe("finalizing");
    expect(statuses.at(-1)).toEqual(
      expect.objectContaining({
        active: false,
        agentStatuses: {
          codex: expect.objectContaining({ status: "complete", processed: 10_000 }),
        },
      }),
    );
  });

  it("publishes a classifier revision refresh when the source is unchanged", async () => {
    const resolved = attachMissingProjectIdentities([makeSession("session")])[0]!;
    const previous = {
      ...resolved,
      smart_tags: ["bugfix" as const],
      smart_tags_source_updated_at: resolved.time_updated,
      smart_tags_classifier_revision: "smart-tags-v0",
    };
    const updated = {
      ...previous,
      smart_tags: ["docs" as const],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    };
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: [updated], meta: {} })),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(
      makeAgent({ checkForChanges: () => ({ hasChanges: false, timestamp: 2 }) }),
      [previous],
      workerRunner,
    );
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(workerRunner.run).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ operation: { kind: "recompute-derived" } }),
    );
    expect(engine.snapshot().sessions[0]).toMatchObject({
      smart_tags: ["docs"],
      smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
    });
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "changes",
          publicationId: expect.stringMatching(/^scan\.refresh:codex:/),
          changes: [
            expect.objectContaining({
              session: expect.objectContaining({ smart_tags: ["docs"] }),
            }),
          ],
        }),
      ],
      expect.any(Function),
    );
    expect(sessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ updatedSessions: 1 }) }),
    );
  });

  it("checks an initialized empty aggregate baseline instead of forcing a reload", async () => {
    const checkForChanges = vi.fn(() => ({ hasChanges: false, timestamp: 2 }));
    const workerRunner = makeWorkerRunner();
    const { engine } = makeEngine(makeAgent({ checkForChanges }), [], workerRunner);

    await engine.refresh("codex");

    expect(checkForChanges).toHaveBeenCalledWith(expect.any(Number), []);
    expect(workerRunner.run).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ operation: { kind: "recompute-derived" } }),
    );
    expect(workerRunner.run).not.toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({ operation: { kind: "full-scan" } }),
    );
  });

  it("distinguishes queued and active publication before committing the refresh", async () => {
    let startIndex!: () => void;
    let commitIndex!: () => void;
    searchIndex.enqueue.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise<undefined>((resolve) => {
          const onStarted = args[2];
          startIndex = () => {
            if (typeof onStarted === "function") onStarted();
          };
          commitIndex = () => resolve(undefined);
        }),
    );
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const { engine } = makeEngine(
      makeAgent({
        checkForChanges: () => ({ hasChanges: true, changedIds: [updated.id], timestamp: 2 }),
        incrementalScan: () => [updated],
      }),
      [previous],
    );
    const statuses: ScanStatusEvent[] = [];
    engine.subscribeStatusChanged((status) => statuses.push(status));

    const refresh = engine.refresh("codex");
    await vi.waitFor(() => expect(searchIndex.enqueue).toHaveBeenCalledOnce());
    expect(engine.snapshot().sessions[0]?.title).toBe("before");
    expect(statuses.at(-1)).toEqual(
      expect.objectContaining({
        active: true,
        phase: "publishing",
        agentStatuses: {
          codex: expect.objectContaining({ status: "publish-queued" }),
        },
      }),
    );

    startIndex();
    expect(statuses.at(-1)?.agentStatuses.codex?.status).toBe("publishing");

    commitIndex();
    await refresh;

    expect(engine.snapshot().sessions[0]?.title).toBe("after");
  });

  it("keeps worker checkpoints private until the durable publication commits", async () => {
    core.isAgentCacheInitialized.mockReturnValue(false);
    let commitIndex!: () => void;
    searchIndex.enqueue.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise<undefined>((resolve) => {
          const onStarted = args[2];
          if (typeof onStarted === "function") onStarted();
          commitIndex = () => resolve(undefined);
        }),
    );
    const head = makeSession("head");
    const tagged: SessionHead = {
      ...head,
      smart_tags: ["feature-dev"],
      smart_tags_source_updated_at: 1,
    };
    const meta = { head: { id: "head", sourcePath: "/head" } };
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        expect(payload.onCheckpoint).toBeUndefined();
        return workerResult({ sessions: [tagged], meta });
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent(), [], workerRunner);

    const refresh = engine.refresh("codex");
    await vi.waitFor(() => expect(searchIndex.enqueue).toHaveBeenCalledOnce());

    expect(engine.snapshot().sessions).toEqual([]);
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "full",
          sessions: [tagged],
          saveCache: true,
          publicationId: expect.stringMatching(/^scan\.refresh:codex:/),
        }),
      ],
      expect.any(Function),
    );

    commitIndex();
    await refresh;

    expect(engine.snapshot().sessions[0]?.smart_tags).toEqual(["feature-dev"]);
  });

  it("persists a windowed initialization without authorizing cached session deletion", async () => {
    core.isAgentCacheInitialized.mockReturnValue(false);
    const old = makeSession("old");
    const recent = makeSession("recent", "updated");
    core.loadCachedSessions.mockReturnValue({
      sessions: [old, recent],
      meta: {},
      timestamp: Date.now(),
    });
    const logInfo = vi.spyOn(appLogger, "info");
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: [recent], meta: {} }, "partial")),
      shutdown: vi.fn(async () => undefined),
    };
    const state: LiveSnapshot = {
      agents: [makeAgent()],
      byAgent: { codex: [recent] },
      sessions: [recent],
    };
    const engine = new AgentSyncEngine({
      workerRunner,
      startupScanOptions: { from: 2 },
    });
    engine.initialize(state);

    await engine.refresh("codex");

    expect(logInfo).toHaveBeenCalledWith("scan.refresh.persistence_candidate", {
      agent: "codex",
      scope_from: 2,
      scope_to: undefined,
      publication_completeness: "partial",
      durable_baseline_sessions: 2,
      payload_sessions: 1,
      delete_candidates: 0,
    });
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [expect.objectContaining({ kind: "full", completeness: "partial" })],
      expect.any(Function),
    );
  });

  it("restores durable metadata and retries the same publication after a commit failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    core.isAgentCacheInitialized.mockReturnValue(false);
    searchIndex.enqueue.mockRejectedValueOnce(new Error("atomic publication failed"));
    const previous = makeSession("head", "before");
    const head = makeSession("head", "after");
    const oldMeta = { head: { id: "head", sourcePath: "/old" } };
    const nextMeta = { head: { id: "head", sourcePath: "/updated" } };
    let currentMeta = oldMeta;
    const restoreSessionCacheMeta = vi.fn((meta: typeof oldMeta) => {
      currentMeta = structuredClone(meta);
    });
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: [head], meta: nextMeta })),
      shutdown: vi.fn(async () => undefined),
    };
    const agent = makeAgent({
      snapshotSessionCacheMeta: () => structuredClone(currentMeta),
      restoreSessionCacheMeta: restoreSessionCacheMeta as BaseAgent["restoreSessionCacheMeta"],
    });
    const { engine } = makeEngine(agent, [previous], workerRunner);
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([previous]);
    expect(currentMeta).toEqual(oldMeta);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(engine.status().agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "atomic publication failed",
      }),
    );

    await engine.refresh("codex");

    expect(workerRunner.run).toHaveBeenCalledTimes(2);
    expect(currentMeta).toEqual(nextMeta);
    expect(engine.snapshot().sessions).toEqual([
      expect.objectContaining({ id: head.id, title: head.title }),
    ]);
    expect(sessionChanges.mock.calls.filter(([change]) => change.event != null)).toHaveLength(1);
  });

  it("waits for the initial search index commit", async () => {
    let commitIndex!: () => void;
    searchIndex.enqueue.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
        commitIndex = () => resolve(undefined);
      }),
    );
    const { engine } = makeEngine(makeAgent(), [makeSession("session")]);
    let completed = false;

    const initialIndex = engine.syncInitialIndex().then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(searchIndex.enqueue).toHaveBeenCalledOnce());
    expect(completed).toBe(false);

    commitIndex();
    await initialIndex;

    expect(completed).toBe(true);
  });

  it("publishes an initial scan failure without indexing a false empty baseline", async () => {
    const agent = makeAgent();
    const engine = new AgentSyncEngine({ workerRunner: makeWorkerRunner() });
    engine.initialize({
      agents: [agent],
      byAgent: {},
      sessions: [],
      scanFailures: {
        codex: {
          agentName: "codex",
          stage: "enumerating session sources",
          sourcePath: "/sessions",
          errorClass: "EACCES",
          message: "permission denied",
        },
      },
    });

    expect(engine.status().agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "failed",
        sessions: 0,
        error: "enumerating session sources: permission denied",
      }),
    );

    await engine.syncInitialIndex();

    expect(core.loadCachedSessions).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).toHaveBeenCalledWith("scan.initial", []);
  });

  it("rescans imprecise changes in a worker and persists only the signature diff", async () => {
    const steady = makeSession("steady");
    const previous = makeSession("changed", "before");
    const updated = makeSession("changed", "after");
    const incrementalScan = vi.fn(() => [updated]);
    const runWorker = vi.fn(async () =>
      workerResult({
        sessions: [steady, updated],
        meta: {
          steady: { id: "steady", sourcePath: "/database" },
          changed: { id: "changed", sourcePath: "/database" },
        },
      }),
    );
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: runWorker,
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(
      makeAgent({
        checkForChanges: () => ({ hasChanges: true, timestamp: 2 }),
        incrementalScan,
      }),
      [steady, previous],
      workerRunner,
    );

    await engine.refresh("codex");

    expect(incrementalScan).not.toHaveBeenCalled();
    expect(runWorker).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        previousSessions: [steady, previous],
        operation: { kind: "full-scan" },
      }),
    );
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "changes",
          agentName: "codex",
          changes: [
            expect.objectContaining({
              session: expect.objectContaining({ id: "changed", title: "after" }),
            }),
          ],
          removedSessionIds: [],
        }),
      ],
      expect.any(Function),
    );
  });

  it("keeps out-of-window cache rows during a bounded database refresh", async () => {
    const historical = makeSession("historical");
    const previous = makeSession("recent", "before");
    const updated = makeSession("recent", "after");
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () =>
        workerResult(
          {
            sessions: [updated],
            meta: { recent: { id: "recent", sourcePath: "/database" } },
          },
          "partial",
        ),
      ),
      shutdown: vi.fn(async () => undefined),
    };
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, timestamp: 3 }),
    });
    const { engine } = makeEngine(agent, [historical, previous], workerRunner, {
      from: 2,
      to: 3,
    });

    await engine.refresh("codex");

    expect(workerRunner.run).toHaveBeenCalledWith(
      "codex",
      expect.objectContaining({
        operation: { kind: "full-scan" },
        scanOptions: { from: 2, to: 3 },
      }),
    );
    expect(engine.snapshot().sessions).toEqual([
      expect.objectContaining({ id: "recent", title: "after" }),
    ]);
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "changes",
          removedSessionIds: [],
        }),
      ],
      expect.any(Function),
    );
  });

  it("persists meta-only changes reported by a full rescan", async () => {
    // Regression test for the zcode/opencode startup loop: checkForChanges kept
    // reporting stale cache meta (missing pricingCaptureEpoch), the full rescan
    // repaired it in memory, but the signature-only persistence diff dropped the
    // meta-only change, so the repaired meta never reached disk and the next
    // startup rescanned again.
    const steady = makeSession("steady");
    const staleMeta = { steady: { id: "steady", sourcePath: "/database" } };
    const repairedMeta = {
      steady: { id: "steady", sourcePath: "/database", pricingCaptureEpoch: "pricing-capture-v1" },
    };
    let currentMeta = staleMeta;
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () =>
        workerResult({ sessions: [steady], meta: repairedMeta, changedIds: [steady.id] }),
      ),
      shutdown: vi.fn(async () => undefined),
    };
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, timestamp: 2 }),
      snapshotSessionCacheMeta: () => currentMeta,
      restoreSessionCacheMeta: ((meta: typeof staleMeta) => {
        currentMeta = structuredClone(meta);
      }) as BaseAgent["restoreSessionCacheMeta"],
    });
    const { engine } = makeEngine(agent, [steady], workerRunner);

    await engine.refresh("codex");

    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "changes",
          agentName: "codex",
          changes: [
            expect.objectContaining({ session: expect.objectContaining({ id: "steady" }) }),
          ],
          meta: repairedMeta,
        }),
      ],
      expect.any(Function),
    );
  });

  it("commits successful source updates as a partial snapshot", async () => {
    const changed = makeSession("changed", "before");
    const updated = makeSession("changed", "after");
    const retained = makeSession("retained");
    const failure: SessionSourceFailure = {
      sessionId: retained.id,
      sourcePath: "/retained",
      stage: "parsing",
      errorClass: "SyntaxError",
      message: "Unexpected end of JSON input",
    };
    core.loadCachedSessions.mockReturnValue({
      sessions: [changed, retained],
      meta: {
        changed: { id: "changed", sourcePath: "/changed", sourceFingerprint: "old" },
        retained: { id: "retained", sourcePath: "/retained", sourceFingerprint: "old" },
      },
      timestamp: 1,
    });
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () =>
        workerResult(
          {
            sessions: [updated, retained],
            meta: {
              changed: { id: "changed", sourcePath: "/changed", sourceFingerprint: "new" },
              retained: { id: "retained", sourcePath: "/retained", sourceFingerprint: "old" },
            },
            changedIds: [changed.id],
            sourceFailures: [failure],
          },
          "partial",
        ),
      ),
      commit: vi.fn(),
      discard: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(new FakeSyncAgent(), [changed, retained], workerRunner);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([
      expect.objectContaining({ id: updated.id, title: updated.title }),
      expect.objectContaining({ id: retained.id, title: retained.title }),
    ]);
    expect(searchIndex.enqueue).toHaveBeenCalledWith(
      "scan.refresh",
      [
        expect.objectContaining({
          kind: "changes",
          changes: [
            expect.objectContaining({
              session: expect.objectContaining({ id: updated.id, title: updated.title }),
            }),
          ],
          removedSessionIds: [],
        }),
      ],
      expect.any(Function),
    );
    expect(engine.status().agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "complete",
        completeness: "partial",
        sourceFailureCount: 1,
        sourceFailureSummary: "SyntaxError: Unexpected end of JSON input",
      }),
    );
    expect(workerRunner.commit).toHaveBeenCalledWith("codex");
    expect(workerRunner.discard).not.toHaveBeenCalled();
  });

  it("keeps a committed refresh complete when post-commit notifications throw", async () => {
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    core.loadCachedSessions.mockReturnValue({
      sessions: [previous],
      meta: { session: { id: "session", sourcePath: "/session", sourceFingerprint: "old" } },
      timestamp: 1,
    });
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () =>
        workerResult({
          sessions: [updated],
          meta: { session: { id: "session", sourcePath: "/session", sourceFingerprint: "new" } },
          changedIds: [updated.id],
        }),
      ),
      commit: vi.fn(),
      discard: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(new FakeSyncAgent(), [previous], workerRunner);
    engine.subscribeSessionsChanged(() => {
      throw new Error("session event broadcast failed");
    });
    const scanStatus = (engine as unknown as { statusReporter: { scanStatus: ScanStatusModel } })
      .statusReporter.scanStatus;
    const finishAgent = vi.spyOn(scanStatus, "finishAgent").mockImplementationOnce(() => {
      throw new Error("terminal status publication failed");
    });
    const logError = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    const logInfo = vi.spyOn(appLogger, "info").mockImplementation((event) => {
      if (event === "scan.refresh.done") throw new Error("post-commit reporting failed");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await engine.refresh("codex");

      expect(engine.snapshot().byAgent.codex).toEqual([
        expect.objectContaining({ id: updated.id, title: updated.title }),
      ]);
      expect(engine.status().agentStatuses.codex).toMatchObject({ status: "complete" });
      expect(workerRunner.commit).toHaveBeenCalledWith("codex");
      expect(workerRunner.discard).not.toHaveBeenCalled();
      expect(finishAgent).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenCalledWith(
        "scan.refresh.post_commit_error",
        expect.objectContaining({ agent: "codex", error: expect.any(Error) }),
      );
    } finally {
      consoleError.mockRestore();
      logInfo.mockRestore();
      logError.mockRestore();
      finishAgent.mockRestore();
    }
  });

  it("keeps the previous snapshot when search indexing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    searchIndex.enqueue.mockRejectedValueOnce(new Error("index failed"));
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const workerRunner = makeWorkerRunner();
    const { engine } = makeEngine(
      makeAgent({
        checkForChanges: () => ({ hasChanges: true, changedIds: [updated.id], timestamp: 2 }),
        incrementalScan: () => [updated],
      }),
      [previous],
      workerRunner,
    );
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions[0]?.title).toBe("before");
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "[codex] Session refresh failed:",
      expect.objectContaining({ message: "index failed" }),
    );
    expect(workerRunner.commit).not.toHaveBeenCalled();
    expect(workerRunner.discard).toHaveBeenCalledWith("codex");
    expect(engine.status().agentStatuses.codex).toMatchObject({ status: "failed" });
  });

  it("CS-138: keeps the previous snapshot when a scan fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workerRunner = makeWorkerRunner();
    workerRunner.run = vi.fn(async () => {
      throw new Error("codex session scan failed while opening the database");
    });
    const previous = makeSession("session", "before");
    const { engine } = makeEngine(
      makeAgent({ checkForChanges: () => ({ hasChanges: true, timestamp: 2 }) }),
      [previous],
      workerRunner,
    );
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([previous]);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
  });

  it("CS-243: retains the baseline when the worker loses agent availability", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const workerRunner = makeWorkerRunner();
    workerRunner.run = vi
      .fn()
      .mockRejectedValueOnce(new AgentUnavailableDuringScanError("codex"))
      .mockResolvedValueOnce(
        workerResult({ sessions: [updated], meta: {}, changedIds: [updated.id] }),
      );
    const warn = vi.spyOn(appLogger, "warn");
    const { engine } = makeEngine(
      makeAgent({ checkForChanges: () => ({ hasChanges: true, timestamp: 2 }) }),
      [previous],
      workerRunner,
    );
    const refreshState = engine as unknown as { lastRefreshAtByAgent: Map<string, number> };
    const baselineTimestamp = refreshState.lastRefreshAtByAgent.get("codex");
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([previous]);
    expect(refreshState.lastRefreshAtByAgent.get("codex")).toBe(baselineTimestamp);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
    expect(workerRunner.commit).not.toHaveBeenCalled();
    expect(workerRunner.discard).toHaveBeenCalledWith("codex");
    expect(engine.status().agentStatuses.codex).toMatchObject({ status: "failed" });
    expect(warn).toHaveBeenCalledWith("scan.refresh.worker_agent_unavailable", {
      agent: "codex",
      error: "Agent codex became unavailable during scan",
    });

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([updated]);
    expect(engine.status().agentStatuses.codex).toMatchObject({ status: "complete" });
    expect(searchIndex.enqueue).toHaveBeenCalledOnce();
  });

  it("CS-138: keeps sessions when the agent becomes unreachable", async () => {
    const previous = makeSession("session", "before");
    const { engine } = makeEngine(makeAgent({ isAvailable: () => false }), [previous]);
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([previous]);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
  });

  it("CS-138: still publishes a genuinely empty scan as removals", async () => {
    const workerRunner = makeWorkerRunner();
    const previous = makeSession("session", "before");
    const { engine } = makeEngine(
      makeAgent({ checkForChanges: () => ({ hasChanges: true, timestamp: 2 }) }),
      [previous],
      workerRunner,
    );
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([]);
    expect(sessionChanges).toHaveBeenCalled();
  });

  it("clears pending refresh work during shutdown", async () => {
    vi.useFakeTimers();
    const checkForChanges = vi.fn(() => ({ hasChanges: false, timestamp: Date.now() }));
    const { engine } = makeEngine(makeAgent({ checkForChanges }), [makeSession("existing")]);
    engine.handleAgentsChanged(["codex"]);

    await engine.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(checkForChanges).not.toHaveBeenCalled();
  });

  it("reuses cached session signatures across refreshes for an unchanged session", async () => {
    const session = makeSession("steady", "same-title");
    const agent = makeAgent({
      checkForChanges: () => ({
        hasChanges: true,
        changedIds: [session.id],
        timestamp: Date.now(),
      }),
      incrementalScan: () => [session],
    });
    const { engine } = makeEngine(agent, [session]);

    await engine.refresh("codex");
    const firstRoundCalls = core.sessionSignature.mock.calls.length;
    expect(firstRoundCalls).toBeGreaterThan(0);

    core.sessionSignature.mockClear();
    await engine.refresh("codex");
    const secondRoundCalls = core.sessionSignature.mock.calls.length;

    // The cached-side signature is served from the per-agent cache on the second
    // round, so fewer sessionSignature calls are needed than on the cold-cache round.
    expect(secondRoundCalls).toBeLessThan(firstRoundCalls);
  });

  it("removes sessions from its owned snapshot", async () => {
    const session = makeSession("gone");
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, timestamp: Date.now() }),
      incrementalScan: () => [],
    });
    const { engine } = makeEngine(agent, [session]);

    await engine.refresh("codex");

    expect(engine.snapshot().byAgent.codex).toEqual([]);
    expect(engine.snapshot().sessions).toEqual([]);
  });

  it("short-circuits source sync when fingerprints and signatures are unchanged", async () => {
    const session = makeSession("steady");
    const agent = new FakeSyncAgent();
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: [session], meta: {}, changedIds: [] })),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(agent, [session], workerRunner);
    core.loadCachedSessions.mockReturnValue({
      sessions: [session],
      meta: {},
      timestamp: Date.now(),
    });
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(workerRunner.run).toHaveBeenCalledOnce();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
    expect(sessionChanges).not.toHaveBeenCalled();
  });

  it("still emits a changed event for a signature-only update reported via the DB-baseline (sync) path", async () => {
    // Regression test for a bug where the strategy-path diff (DB `cached.sessions`
    // baseline) and the event-path diff (in-memory `previousSessions` baseline)
    // shared one signature cache within a single refresh. The strategy-path diff
    // ran first and wrote the *new* signature into the cache; the event-path diff
    // then read that new signature back for the cached side too, so a change with
    // no reported changedIds (e.g. smart-tag reclassification) looked like no
    // change at all and the UI event was dropped. Only the event path may use the
    // cache now — this asserts the event still fires in that scenario.
    const oldSession = { ...makeSession("sess1"), smart_tags_source_updated_at: 1 };
    const newSession = { ...makeSession("sess1"), smart_tags_source_updated_at: 2 };
    const agent = new FakeSyncAgent();
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      // The sync worker reports no changedIds even though the session content
      // changed — mirrors an out-of-band reclassification the file-fingerprint
      // check can't see.
      run: vi.fn(async () => workerResult({ sessions: [newSession], meta: {}, changedIds: [] })),
      shutdown: vi.fn(async () => undefined),
    };
    const state: LiveSnapshot = {
      agents: [agent],
      byAgent: { codex: [oldSession] },
      sessions: [oldSession],
    };
    const engine = new AgentSyncEngine({ workerRunner });
    engine.initialize(state);

    core.loadCachedSessions.mockReturnValue({
      sessions: [oldSession],
      meta: {},
      timestamp: Date.now(),
    });

    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(sessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: "codex",
        event: expect.objectContaining({ updatedSessions: 1 }),
      }),
    );
  });

  it("does not advance signature lineage when search indexing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    searchIndex.enqueue.mockRejectedValueOnce(new Error("index failed"));
    const oldSession = { ...makeSession("sess1"), smart_tags_source_updated_at: 1 };
    const newSession = { ...makeSession("sess1"), smart_tags_source_updated_at: 2 };
    const agent = new FakeSyncAgent();
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: [newSession], meta: {}, changedIds: [] })),
      commit: vi.fn(),
      discard: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const engine = new AgentSyncEngine({ workerRunner });
    engine.initialize({
      agents: [agent],
      byAgent: { codex: [oldSession] },
      sessions: [oldSession],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [oldSession],
      meta: {},
      timestamp: Date.now(),
    });
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([oldSession]);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(workerRunner.commit).not.toHaveBeenCalled();
    expect(workerRunner.discard).toHaveBeenCalledTimes(1);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([
      expect.objectContaining({
        id: newSession.id,
        smart_tags_source_updated_at: newSession.smart_tags_source_updated_at,
      }),
    ]);
    expect(sessionChanges).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ updatedSessions: 1 }),
      }),
    );
    expect(workerRunner.commit).toHaveBeenCalledTimes(1);
  });

  it("CS-73 regression: a windowed startup scan with one unindexed session still switches to the incremental refresh path", async () => {
    // Mirrors the fixed search-index-worker.ts:108 (`job.saveCache && result`,
    // no more `skipped === 0` gate): the head cache is marked initialized as
    // soon as it's saved, even if `getSessionData` couldn't load "broken" and
    // syncSessionSearchIndex reports skipped > 0 for it. Before the fix, that
    // skip permanently blocked markAgentCacheInitialized, so isInitialized
    // stayed false and every later refresh re-ran the full initializeAgent
    // scan instead of the incremental checkForChanges path.
    let cacheInitialized = false;
    core.isAgentCacheInitialized.mockImplementation(() => cacheInitialized);
    searchIndex.enqueue.mockImplementation(async (...args: unknown[]) => {
      const jobs = args[1] as Array<{ kind: string; saveCache?: boolean }>;
      for (const job of jobs) {
        if (job.kind === "full" && job.saveCache) cacheInitialized = true;
      }
      return undefined;
    });

    const checkForChanges = vi.fn(() => ({ hasChanges: false, timestamp: Date.now() }));
    const agent = makeAgent({ checkForChanges });
    const scanResult = [makeSession("broken")];
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async () => workerResult({ sessions: scanResult, meta: {} }, "partial")),
      shutdown: vi.fn(async () => undefined),
    };
    const state: LiveSnapshot = { agents: [agent], byAgent: { codex: [] }, sessions: [] };
    const engine = new AgentSyncEngine({
      workerRunner,
      startupScanOptions: { from: 1, to: 2 },
    });
    engine.initialize(state);

    await engine.refresh("codex");
    expect(cacheInitialized).toBe(true);
    expect(workerRunner.run).toHaveBeenCalledTimes(1);

    await engine.refresh("codex");

    // The second refresh takes the incremental path (checkForChanges), not
    // another windowed initializeAgent full scan.
    expect(checkForChanges).toHaveBeenCalledTimes(1);
    expect(workerRunner.run).toHaveBeenCalledTimes(2);
    expect(workerRunner.run).toHaveBeenLastCalledWith(
      "codex",
      expect.objectContaining({ operation: { kind: "recompute-derived" } }),
    );
  });
});
