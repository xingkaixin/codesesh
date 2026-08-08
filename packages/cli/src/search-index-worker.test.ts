import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerData: {} as Record<string, unknown>,
  postMessage: vi.fn(),
  createRegisteredAgents: vi.fn(),
  markAgentCacheInitialized: vi.fn(),
  saveCachedSessionChanges: vi.fn(),
  saveCachedSessions: vi.fn(),
  syncSessionSearchIndex: vi.fn(),
  syncSessionSearchIndexChanges: vi.fn(),
  appLoggerWarn: vi.fn(),
  appLoggerError: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", () => ({
  createRegisteredAgents: mocks.createRegisteredAgents,
  markAgentCacheInitialized: mocks.markAgentCacheInitialized,
  saveCachedSessionChanges: mocks.saveCachedSessionChanges,
  saveCachedSessions: mocks.saveCachedSessions,
  sessionDetailVersion: (meta: { id?: string }) => `detail:${meta.id ?? "none"}`,
  syncSessionSearchIndex: mocks.syncSessionSearchIndex,
  syncSessionSearchIndexChanges: mocks.syncSessionSearchIndexChanges,
  // diagnostics-bridge.js (imported by the worker for its side effect) needs this export.
  setCoreDiagnostics: vi.fn(),
}));

vi.mock("./logging.js", () => ({
  appLogger: { warn: mocks.appLoggerWarn, error: mocks.appLoggerError },
}));

function makeAgent() {
  return {
    name: "codex",
    setSessionMetaMap: vi.fn(),
    getSessionData: vi.fn((id: string) => ({ id })),
  };
}

async function runWorker() {
  await import("./search-index-worker.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.saveCachedSessions.mockReturnValue(true);
  mocks.saveCachedSessionChanges.mockReturnValue(true);
  mocks.workerData = {
    context: "refresh",
    agentNames: [],
    sessionsByAgent: {},
    metaByAgent: {},
  };
});

describe("search index worker", () => {
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
      agentNames: ["codex", "unknown"],
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

  it("saves a full cache and marks a completely indexed agent initialized", async () => {
    const agent = makeAgent();
    const sessions = [{ id: "s1" }, { id: "s2" }];
    const meta = { s1: { id: "s1" } };
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.syncSessionSearchIndex.mockReturnValue({ indexed: 2, skipped: 0 });
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
          saveCache: true,
          searchIndexOptions: { force: true },
        },
      ],
    };

    await runWorker();

    expect(mocks.saveCachedSessions).toHaveBeenCalledWith("codex", sessions, meta);
    expect(mocks.syncSessionSearchIndex).toHaveBeenCalledWith(
      "codex",
      sessions,
      expect.any(Function),
      { force: true, detailVersions: { s1: "detail:s1" } },
    );
    expect(mocks.markAgentCacheInitialized).toHaveBeenCalledWith("codex");
    expect(mocks.appLoggerWarn).not.toHaveBeenCalled();
  });

  it("CS-73 regression: still marks the agent initialized when a session couldn't be indexed, but warns", async () => {
    const agent = makeAgent();
    const sessions = [{ id: "s1" }, { id: "broken" }];
    const meta = { s1: { id: "s1" } };
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    // One session (e.g. its data failed to load) is left unindexed.
    mocks.syncSessionSearchIndex.mockReturnValue({ indexed: 1, skipped: 1 });
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
    mocks.syncSessionSearchIndexChanges.mockImplementation(
      (
        _name: string,
        _changes: unknown[],
        _removed: string[],
        readSession: (id: string) => unknown,
      ) => {
        expect(readSession("updated")).toEqual({ id: "updated" });
        return { indexed: 1, skipped: 0 };
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

    expect(mocks.saveCachedSessionChanges).toHaveBeenCalledWith(
      "codex",
      changes,
      removedSessionIds,
      {},
    );
    expect(mocks.syncSessionSearchIndexChanges).toHaveBeenCalledWith(
      "codex",
      changes,
      removedSessionIds,
      expect.any(Function),
      { force: true, detailVersions: {} },
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", sessions: 1 }),
    );
  });

  it("CS-137: reports a failed cache write instead of settling the batch as done", async () => {
    const agent = makeAgent();
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.saveCachedSessionChanges.mockReturnValue(false);
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

    expect(mocks.syncSessionSearchIndexChanges).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "persist-failed",
      context: "scan.refresh",
      stage: "cache",
      agentName: "codex",
      sessions: 1,
    });
  });

  it("CS-137: reports a failed index write and skips the remaining jobs", async () => {
    const agent = makeAgent();
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.syncSessionSearchIndex.mockReturnValue(null);
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
          saveCache: true,
        },
        {
          kind: "full",
          context: "scan.refresh",
          agentName: "codex",
          sessions: [{ id: "s3" }],
          meta: {},
          saveCache: true,
        },
      ],
    };

    await runWorker();

    expect(mocks.markAgentCacheInitialized).not.toHaveBeenCalled();
    expect(mocks.syncSessionSearchIndex).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith({
      type: "persist-failed",
      context: "scan.refresh",
      stage: "search_index",
      agentName: "codex",
      sessions: 2,
    });
  });
});
