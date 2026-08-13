import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerData: {} as Record<string, unknown>,
  postMessage: vi.fn(),
  commitDurableSessionPublication: vi.fn(),
  createRegisteredAgents: vi.fn(),
  markAgentCacheInitialized: vi.fn(),
  synchronizePricingGeneration: vi.fn(),
  syncSessionSearchIndex: vi.fn(),
  syncSessionSearchIndexChanges: vi.fn(),
  appLoggerInfo: vi.fn(),
  appLoggerWarn: vi.fn(),
  appLoggerError: vi.fn(),
  messageHandler: undefined as ((message: Record<string, unknown>) => void) | undefined,
}));

vi.mock("node:worker_threads", () => ({
  parentPort: {
    postMessage: mocks.postMessage,
    on: (_event: string, handler: (message: Record<string, unknown>) => void) => {
      mocks.messageHandler = handler;
    },
  },
  threadId: 17,
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", () => ({
  commitDurableSessionPublication: mocks.commitDurableSessionPublication,
  createRegisteredAgents: mocks.createRegisteredAgents,
  markAgentCacheInitialized: mocks.markAgentCacheInitialized,
  sessionDetailVersion: (meta: { id?: string }) => `detail:${meta.id ?? "none"}`,
  synchronizePricingGeneration: mocks.synchronizePricingGeneration,
  syncSessionSearchIndex: mocks.syncSessionSearchIndex,
  syncSessionSearchIndexChanges: mocks.syncSessionSearchIndexChanges,
  // diagnostics-bridge.js (imported by the worker for its side effect) needs this export.
  setCoreDiagnostics: vi.fn(),
}));

vi.mock("./logging.js", () => ({
  appLogger: {
    forwardToParent: vi.fn(),
    info: mocks.appLoggerInfo,
    warn: mocks.appLoggerWarn,
    error: mocks.appLoggerError,
  },
}));

function makeAgent() {
  return {
    name: "codex",
    setSessionMetaMap: vi.fn(),
    getSessionData: vi.fn((id: string) => ({ id })),
  };
}

async function runWorker() {
  mocks.workerData = { type: "run", pricingGenerationId: 17, ...mocks.workerData };
  await import("./search-index-worker.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.messageHandler = undefined;
  mocks.commitDurableSessionPublication.mockReturnValue({
    status: "committed",
    publicationId: "publication-default",
    searchIndex: { indexed: 0, skipped: 0 },
  });
  mocks.workerData = {
    context: "refresh",
    agentNames: [],
    sessionsByAgent: {},
    metaByAgent: {},
  };
});

describe("search index worker", () => {
  it("synchronizes pricing before creating agents", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();

    expect(mocks.synchronizePricingGeneration).toHaveBeenCalledWith(17);
    expect(mocks.synchronizePricingGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRegisteredAgents.mock.invocationCallOrder[0]!,
    );
  });

  it("reuses module initialization while isolating agents between batches", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();
    mocks.messageHandler?.({
      type: "run",
      pricingGenerationId: 17,
      context: "second-refresh",
      jobs: [],
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
    });

    expect(mocks.synchronizePricingGeneration).toHaveBeenCalledOnce();
    expect(mocks.createRegisteredAgents).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", context: "second-refresh" }),
    );
  });

  it("builds legacy full jobs", async () => {
    const agent = makeAgent();
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.syncSessionSearchIndex.mockImplementation(
      (_name: string, _sessions: unknown[], readSession: (id: string) => unknown) => {
        expect(readSession("s1")).toEqual({ id: "s1" });
        return { indexed: 1, skipped: 0 };
      },
    );
    mocks.workerData = {
      context: "startup",
      agentNames: ["codex"],
      sessionsByAgent: { codex: [{ id: "s1" }] },
      metaByAgent: { codex: { s1: { id: "s1" } } },
    };

    await runWorker();

    expect(agent.setSessionMetaMap).toHaveBeenCalledWith(new Map([["s1", { id: "s1" }]]));
    expect(mocks.postMessage).toHaveBeenNthCalledWith(1, {
      type: "sync-result",
      context: "startup",
      result: { indexed: 1, skipped: 0 },
    });
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", context: "startup", sessions: 1 }),
    );
  });

  it("rejects a job for an unknown agent instead of reporting done", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);
    mocks.workerData = {
      context: "scan.refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "full",
          context: "scan.refresh",
          agentName: "unknown",
          sessions: [{ id: "s1" }],
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
      ],
    };

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "persist-failed",
        context: "scan.refresh",
        stage: "prepare",
        agentName: "unknown",
        sessions: 1,
      }),
    );
  });

  it("saves a full cache and marks a completely indexed agent initialized", async () => {
    const agent = makeAgent();
    const sessions = [{ id: "s1" }, { id: "s2" }];
    const meta = { s1: { id: "s1" } };
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.commitDurableSessionPublication.mockImplementation(
      (_publication: unknown, readSession: (id: string) => unknown) => {
        expect(readSession("s1")).toEqual({ id: "s1" });
        return {
          status: "committed",
          publicationId: "publication-full",
          searchIndex: { indexed: 2, skipped: 0 },
        };
      },
    );
    mocks.workerData = {
      context: "refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "full",
          context: "codex-full",
          agentName: "codex",
          sessions,
          meta,
          completeness: "complete",
          removedSessionIds: [],
          publicationId: "scan.refresh:codex:1",
          saveCache: true,
          searchIndexOptions: { force: true },
        },
      ],
    };

    await runWorker();

    expect(mocks.commitDurableSessionPublication).toHaveBeenCalledWith(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions,
        meta,
        completeness: "complete",
        removedSessionIds: [],
        publicationId: "scan.refresh:codex:1",
      },
      expect.any(Function),
      { force: true },
    );
    expect(mocks.markAgentCacheInitialized).toHaveBeenCalledWith("codex");
    expect(mocks.appLoggerWarn).not.toHaveBeenCalled();
  });

  it("passes partial scope and explicit removals to both durable indexes", async () => {
    const agent = makeAgent();
    const sessions = [{ id: "recent" }];
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.commitDurableSessionPublication.mockReturnValue({
      status: "committed",
      publicationId: "publication-partial",
      searchIndex: { indexed: 1, skipped: 0 },
    });
    mocks.workerData = {
      context: "refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "full",
          context: "codex-partial",
          agentName: "codex",
          sessions,
          meta: {},
          completeness: "partial",
          removedSessionIds: ["removed"],
          saveCache: true,
        },
      ],
    };

    await runWorker();

    expect(mocks.commitDurableSessionPublication).toHaveBeenCalledWith(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions,
        meta: {},
        completeness: "partial",
        removedSessionIds: ["removed"],
      },
      expect.any(Function),
      undefined,
    );
  });

  it("CS-73 regression: still marks the agent initialized when a session couldn't be indexed, but warns", async () => {
    const agent = makeAgent();
    const sessions = [{ id: "s1" }, { id: "broken" }];
    const meta = { s1: { id: "s1" } };
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    // One session (e.g. its data failed to load) is left unindexed.
    mocks.commitDurableSessionPublication.mockReturnValue({
      status: "committed",
      publicationId: "publication-incomplete",
      searchIndex: { indexed: 1, skipped: 1 },
    });
    mocks.workerData = {
      context: "refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "full",
          context: "codex-full",
          agentName: "codex",
          sessions,
          meta,
          completeness: "complete",
          removedSessionIds: [],
          saveCache: true,
        },
      ],
    };

    await runWorker();

    // Head cache init must not be blocked by an incomplete search index —
    // otherwise every later refresh falls back to a full initializeAgent scan.
    expect(mocks.markAgentCacheInitialized).toHaveBeenCalledWith("codex");
    expect(mocks.appLoggerWarn).toHaveBeenCalledWith("search_index.sync_incomplete", {
      agent: "codex",
      skipped: 1,
    });
  });

  it("applies incremental index changes and reports processed sessions", async () => {
    const agent = makeAgent();
    const changes = [{ id: "updated", session: { id: "updated" } }];
    const removedSessionIds = ["removed"];
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.commitDurableSessionPublication.mockImplementation(
      (_publication: unknown, readSession: (id: string) => unknown) => {
        expect(readSession("updated")).toEqual({ id: "updated" });
        return {
          status: "committed",
          publicationId: "publication-changes",
          searchIndex: { indexed: 1, skipped: 0 },
        };
      },
    );
    mocks.workerData = {
      context: "refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "changes",
          context: "codex-changes",
          agentName: "codex",
          changes,
          removedSessionIds,
          meta: {},
          searchIndexOptions: { force: true },
        },
      ],
    };

    await runWorker();

    expect(mocks.commitDurableSessionPublication).toHaveBeenCalledWith(
      {
        kind: "changes",
        agentName: "codex",
        changes,
        removedSessionIds,
        meta: {},
      },
      expect.any(Function),
      { force: true },
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", sessions: 1 }),
    );
  });

  it("updates maintenance rows without rewriting the session cache", async () => {
    const agent = makeAgent();
    const changes = [{ session: { id: "legacy" }, sortIndex: 0 }];
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.syncSessionSearchIndexChanges.mockReturnValue({ indexed: 1, skipped: 0 });
    mocks.workerData = {
      context: "search.maintenance",
      jobs: [
        {
          kind: "maintenance",
          context: "search.maintenance",
          agentName: "codex",
          changes,
          removedSessionIds: [],
          meta: { legacy: { id: "legacy" } },
          searchIndexOptions: { isBulk: false },
        },
      ],
    };

    await runWorker();

    expect(mocks.syncSessionSearchIndexChanges).toHaveBeenCalledWith(
      "codex",
      changes,
      [],
      expect.any(Function),
      {
        isBulk: false,
        detailVersions: { legacy: "detail:legacy" },
      },
    );
    expect(mocks.commitDurableSessionPublication).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", context: "search.maintenance", sessions: 1 }),
    );
  });

  it("CS-137: reports a failed cache write instead of settling the batch as done", async () => {
    const agent = makeAgent();
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.commitDurableSessionPublication.mockReturnValue({
      status: "rolled-back",
      publicationId: "publication-cache-failure",
      stage: "cache",
    });
    mocks.workerData = {
      context: "scan.refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "changes",
          context: "scan.refresh",
          agentName: "codex",
          changes: [{ session: { id: "s1" }, sortIndex: 0 }],
          removedSessionIds: [],
          meta: {},
        },
      ],
    };

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "persist-failed",
      context: "scan.refresh",
      stage: "cache",
      publicationId: "publication-cache-failure",
      agentName: "codex",
      sessions: 1,
    });
  });

  it("CS-137: reports a failed index write and skips the remaining jobs", async () => {
    const agent = makeAgent();
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.commitDurableSessionPublication.mockReturnValue({
      status: "rolled-back",
      publicationId: "publication-search-failure",
      stage: "search_index",
    });
    mocks.workerData = {
      context: "scan.refresh",
      agentNames: [],
      sessionsByAgent: {},
      metaByAgent: {},
      jobs: [
        {
          kind: "full",
          context: "scan.refresh",
          agentName: "codex",
          sessions: [{ id: "s1" }, { id: "s2" }],
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
          saveCache: true,
        },
        {
          kind: "full",
          context: "scan.refresh",
          agentName: "codex",
          sessions: [{ id: "s3" }],
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
          saveCache: true,
        },
      ],
    };

    await runWorker();

    expect(mocks.markAgentCacheInitialized).not.toHaveBeenCalled();
    expect(mocks.commitDurableSessionPublication).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "persist-failed",
      context: "scan.refresh",
      stage: "search_index",
      publicationId: "publication-search-failure",
      agentName: "codex",
      sessions: 2,
    });
    expect(mocks.appLoggerError).toHaveBeenCalledWith(
      "search_index.persist_failed",
      expect.objectContaining({
        stage: "search_index",
        publication_id: "publication-search-failure",
      }),
    );
  });
});
