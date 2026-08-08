import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSystemSessionSource } from "@codesesh/core";
import type { BaseAgent, loadCachedSessions, LiveSnapshot, SessionHead } from "@codesesh/core";
import type { ScanStatusEvent } from "@codesesh/core/contract";
import type { WorkerRunner } from "./worker-runner.js";
import { appLogger } from "./logging.js";

const core = vi.hoisted(() => ({
  getAgentFullSyncCursor: vi.fn(() => null as string | null),
  getAgentLastFullSyncAt: vi.fn(() => Date.now()),
  isAgentCacheInitialized: vi.fn(() => true),
  loadCachedSessions: vi.fn((): ReturnType<typeof loadCachedSessions> => null),
  markAgentCacheInitialized: vi.fn(),
  markAgentFullSyncProgress: vi.fn(),
  markAgentFullSyncStarted: vi.fn(),
  markAgentFullSyncCompleted: vi.fn(),
  saveCachedSessionChanges: vi.fn(() => true),
  saveCachedSessions: vi.fn(() => true),
  sessionSignature: vi.fn(),
}));

const searchIndex = vi.hoisted(() => ({
  enqueue: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
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
    loadCachedSessions: core.loadCachedSessions,
    markAgentCacheInitialized: core.markAgentCacheInitialized,
    markAgentFullSyncProgress: core.markAgentFullSyncProgress,
    markAgentFullSyncStarted: core.markAgentFullSyncStarted,
    markAgentFullSyncCompleted: core.markAgentFullSyncCompleted,
    saveCachedSessionChanges: core.saveCachedSessionChanges,
    saveCachedSessions: core.saveCachedSessions,
    sessionSignature: core.sessionSignature,
  };
});

vi.mock("./search-index-job-runner.js", () => ({
  SearchIndexJobRunner: class {
    enqueue = searchIndex.enqueue;
    shutdown = searchIndex.shutdown;
    snapshot = searchIndex.snapshot;
  },
}));

import { AgentSyncEngine } from "./agent-sync-engine.js";

function makeSession(id: string, title = id): SessionHead {
  return {
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
}

function makeAgent(overrides: Partial<BaseAgent> = {}): BaseAgent {
  return {
    name: "codex",
    displayName: "Codex",
    isAvailable: () => true,
    scan: () => [],
    checkForChanges: () => ({ hasChanges: false, timestamp: Date.now() }),
    incrementalScan: (sessions) => sessions,
    getSessionData: () => ({ messages: [] }) as never,
    getSessionMetaMap: () => new Map(),
    setSessionMetaMap: () => undefined,
    ...overrides,
  } as BaseAgent;
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

function makeWorkerRunner(): WorkerRunner {
  return {
    activeCount: 0,
    run: vi.fn(async () => ({ sessions: [], meta: {} })),
    shutdown: vi.fn(async () => undefined),
  };
}

function makeEngine(
  agent: BaseAgent,
  sessions: SessionHead[] = [],
  workerRunner: WorkerRunner = makeWorkerRunner(),
) {
  const state: LiveSnapshot = {
    agents: [agent],
    byAgent: { [agent.name]: sessions },
    sessions,
  };
  const engine = new AgentSyncEngine({ workerRunner });
  engine.initialize(state);
  return { engine };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  core.getAgentLastFullSyncAt.mockReturnValue(Date.now());
  core.isAgentCacheInitialized.mockReturnValue(true);
  core.loadCachedSessions.mockReturnValue(null);
  core.markAgentCacheInitialized.mockClear();
  core.markAgentFullSyncStarted.mockClear();
  core.saveCachedSessionChanges.mockClear();
  core.saveCachedSessions.mockClear();
  core.saveCachedSessionChanges.mockReturnValue(true);
  core.saveCachedSessions.mockReturnValue(true);
  searchIndex.enqueue.mockImplementation(async () => undefined);
});

describe("AgentSyncEngine", () => {
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
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, changedIds: [updated.id], timestamp: 2 }),
      incrementalScan: () => [updated],
    });
    const { engine } = makeEngine(agent, [previous]);
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
  });

  it("publishes an ordinary refresh only after the search index commits", async () => {
    let commitIndex!: () => void;
    searchIndex.enqueue.mockReturnValueOnce(
      new Promise<undefined>((resolve) => {
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
        phase: "indexing",
        agentStatuses: {
          codex: expect.objectContaining({ status: "indexing" }),
        },
      }),
    );

    commitIndex();
    await refresh;

    expect(engine.snapshot().sessions[0]?.title).toBe("after");
  });

  it("publishes and persists the head checkpoint before final indexing", async () => {
    core.isAgentCacheInitialized.mockReturnValue(false);
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
        payload.onCheckpoint?.({
          stage: "scanned",
          sessions: [head],
          meta,
          completeness: "complete",
        });
        payload.onCheckpoint?.({
          stage: "finalizing",
          changes: [{ session: tagged, sortIndex: 0 }],
          meta,
        });
        return { sessions: [tagged], meta };
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent(), [], workerRunner);

    await engine.refresh("codex");

    expect(core.saveCachedSessions).toHaveBeenCalledWith("codex", [head], meta, {
      completeness: "complete",
    });
    expect(core.markAgentCacheInitialized).toHaveBeenCalledWith("codex");
    expect(core.saveCachedSessionChanges).toHaveBeenCalledWith(
      "codex",
      [{ session: tagged, sortIndex: 0 }],
      [],
      meta,
    );
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
      run: vi.fn(async (_agentName, payload) => {
        payload.onCheckpoint?.({
          stage: "scanned",
          sessions: [recent],
          meta: {},
          completeness: "partial",
        });
        return { sessions: [recent], meta: {} };
      }),
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

    expect(logInfo).toHaveBeenCalledWith("scan.checkpoint.replacement_candidate", {
      agent: "codex",
      completeness: "partial",
      cached_sessions: 2,
      checkpoint_sessions: 1,
      missing_cached_sessions: 1,
      delete_candidates: 0,
    });
    expect(core.saveCachedSessions).toHaveBeenCalledWith(
      "codex",
      [recent],
      {},
      {
        completeness: "partial",
      },
    );
  });

  it("keeps the last durable snapshot when a head checkpoint is rejected", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logError = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    core.isAgentCacheInitialized.mockReturnValue(false);
    core.saveCachedSessions.mockReturnValue(false);
    const previous = makeSession("head", "before");
    const head = makeSession("head", "after");
    const meta = { head: { id: "head", sourcePath: "/head" } };
    const setSessionMetaMap = vi.fn();
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        payload.onCheckpoint?.({
          stage: "scanned",
          sessions: [head],
          meta,
          completeness: "complete",
        });
        return { sessions: [head], meta };
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent({ setSessionMetaMap }), [previous], workerRunner);
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([previous]);
    expect(setSessionMetaMap).not.toHaveBeenCalled();
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(searchIndex.enqueue).not.toHaveBeenCalled();
    expect(engine.status().agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "failed",
        error: "Failed to persist scanned checkpoint for codex",
      }),
    );
    expect(logError).toHaveBeenCalledWith(
      "scan.checkpoint.failed",
      expect.objectContaining({ agent: "codex", stage: "scanned", sessions: 1 }),
    );

    core.saveCachedSessions.mockReturnValue(true);
    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([
      expect.objectContaining({ id: head.id, title: head.title }),
    ]);
    expect(sessionChanges.mock.calls.filter(([change]) => change.event != null)).toHaveLength(1);
    expect(core.markAgentCacheInitialized).toHaveBeenCalledTimes(1);
  });

  it("keeps the last durable snapshot when head persistence throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    core.isAgentCacheInitialized.mockReturnValue(false);
    core.saveCachedSessions.mockImplementation(() => {
      throw new Error("database is read-only");
    });
    const previous = makeSession("head", "before");
    const head = makeSession("head", "after");
    const meta = { head: { id: "head", sourcePath: "/head" } };
    const workerRunner: WorkerRunner = {
      activeCount: 0,
      run: vi.fn(async (_agentName, payload) => {
        payload.onCheckpoint?.({
          stage: "scanned",
          sessions: [head],
          meta,
          completeness: "complete",
        });
        return { sessions: [head], meta };
      }),
      shutdown: vi.fn(async () => undefined),
    };
    const { engine } = makeEngine(makeAgent(), [previous], workerRunner);
    const sessionChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);

    await engine.refresh("codex");

    expect(engine.snapshot().sessions).toEqual([previous]);
    expect(sessionChanges).not.toHaveBeenCalled();
    expect(engine.status().agentStatuses.codex).toEqual(
      expect.objectContaining({ status: "failed", error: "database is read-only" }),
    );
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

  it("rescans imprecise changes in a worker and persists only the signature diff", async () => {
    const steady = makeSession("steady");
    const previous = makeSession("changed", "before");
    const updated = makeSession("changed", "after");
    const incrementalScan = vi.fn(() => [updated]);
    const runWorker = vi.fn(async () => ({
      sessions: [steady, updated],
      meta: {
        steady: { id: "steady", sourcePath: "/database" },
        changed: { id: "changed", sourcePath: "/database" },
      },
    }));
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
        changedIds: null,
      }),
    );
    expect(searchIndex.enqueue).toHaveBeenCalledWith("scan.refresh", [
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
    ]);
  });

  it("keeps the previous snapshot when search indexing fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    searchIndex.enqueue.mockRejectedValueOnce(new Error("index failed"));
    const previous = makeSession("session", "before");
    const updated = makeSession("session", "after");
    const { engine } = makeEngine(
      makeAgent({
        checkForChanges: () => ({ hasChanges: true, changedIds: [updated.id], timestamp: 2 }),
        incrementalScan: () => [updated],
      }),
      [previous],
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
      run: vi.fn(async () => ({ sessions: [session], meta: {}, changedIds: [] })),
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
      run: vi.fn(async () => ({ sessions: [newSession], meta: {}, changedIds: [] })),
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
      run: vi.fn(async () => ({ sessions: [newSession], meta: {}, changedIds: [] })),
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
      run: vi.fn(async () => ({ sessions: scanResult, meta: {} })),
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
    expect(workerRunner.run).toHaveBeenCalledTimes(1);
  });
});
