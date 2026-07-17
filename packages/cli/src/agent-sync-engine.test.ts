import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseAgent, ScanResult, SessionHead } from "@codesesh/core";
import type { WorkerRunner } from "./worker-runner.js";

const core = vi.hoisted(() => ({
  getAgentLastFullSyncAt: vi.fn(() => Date.now()),
  isAgentCacheInitialized: vi.fn(() => true),
  loadCachedSessions: vi.fn(() => null),
  markAgentFullSyncCompleted: vi.fn(),
}));

const searchIndex = vi.hoisted(() => ({
  enqueue: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
  snapshot: vi.fn(() => ({ activeBatchId: undefined, pendingBatches: 0 })),
}));

vi.mock("@codesesh/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core")>()),
  getAgentLastFullSyncAt: core.getAgentLastFullSyncAt,
  isAgentCacheInitialized: core.isAgentCacheInitialized,
  loadCachedSessions: core.loadCachedSessions,
  markAgentFullSyncCompleted: core.markAgentFullSyncCompleted,
}));

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
});
