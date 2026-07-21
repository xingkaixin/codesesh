import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSystemSessionSource } from "@codesesh/core";
import type { BaseAgent, loadCachedSessions, ScanResult, SessionHead } from "@codesesh/core";
import type { WorkerRunner } from "./worker-runner.js";

const core = vi.hoisted(() => ({
  getAgentLastFullSyncAt: vi.fn(() => Date.now()),
  isAgentCacheInitialized: vi.fn(() => true),
  loadCachedSessions: vi.fn((): ReturnType<typeof loadCachedSessions> => null),
  markAgentFullSyncCompleted: vi.fn(),
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
    getAgentLastFullSyncAt: core.getAgentLastFullSyncAt,
    isAgentCacheInitialized: core.isAgentCacheInitialized,
    loadCachedSessions: core.loadCachedSessions,
    markAgentFullSyncCompleted: core.markAgentFullSyncCompleted,
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

function makeWorkerRunner(): WorkerRunner {
  return {
    activeCount: 0,
    run: vi.fn(async () => ({ sessions: [], meta: {} })),
    shutdown: vi.fn(async () => undefined),
  };
}

function makeEngine(agent: BaseAgent, sessions: SessionHead[] = []) {
  const state: ScanResult = {
    agents: [agent],
    byAgent: { [agent.name]: sessions },
    sessions,
  };
  const engine = new AgentSyncEngine({
    snapshot: () => state,
    workerRunner: makeWorkerRunner(),
  });
  engine.subscribeSessionsChanged((change) => {
    state.byAgent[change.agentName] = change.sessions;
    state.sessions = Object.values(state.byAgent).flat();
  });
  engine.initialize();
  return { engine, state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  core.getAgentLastFullSyncAt.mockReturnValue(Date.now());
  core.isAgentCacheInitialized.mockReturnValue(true);
  core.loadCachedSessions.mockReturnValue(null);
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
    const { engine, state } = makeEngine(agent, [previous]);
    const sessionChanges = vi.fn();
    const statusChanges = vi.fn();
    engine.subscribeSessionsChanged(sessionChanges);
    engine.subscribeStatusChanged(statusChanges);

    await engine.refresh("codex");

    expect(state.sessions[0]?.title).toBe("after");
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
      checkForChanges: () => ({ hasChanges: true, timestamp: Date.now() }),
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

  it("clears cached session signatures when a session is removed", async () => {
    const session = makeSession("gone");
    const agent = makeAgent({
      checkForChanges: () => ({ hasChanges: true, timestamp: Date.now() }),
      incrementalScan: () => [],
    });
    const { engine } = makeEngine(agent, [session]);

    await engine.refresh("codex");

    const signatureCache = (
      engine as unknown as { state: (name: string) => { signatureCache: Map<string, string> } }
    ).state("codex").signatureCache;
    expect(signatureCache.has("gone")).toBe(false);
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
    }

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
    const state: ScanResult = {
      agents: [agent],
      byAgent: { codex: [oldSession] },
      sessions: [oldSession],
    };
    const engine = new AgentSyncEngine({ snapshot: () => state, workerRunner });
    engine.subscribeSessionsChanged((change) => {
      state.byAgent[change.agentName] = change.sessions;
      state.sessions = Object.values(state.byAgent).flat();
    });
    engine.initialize();

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
    const state: ScanResult = { agents: [agent], byAgent: { codex: [] }, sessions: [] };
    const engine = new AgentSyncEngine({
      snapshot: () => state,
      workerRunner,
      startupScanOptions: { from: 1, to: 2 },
    });
    engine.subscribeSessionsChanged((change) => {
      state.byAgent[change.agentName] = change.sessions;
      state.sessions = Object.values(state.byAgent).flat();
    });
    engine.initialize();

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
