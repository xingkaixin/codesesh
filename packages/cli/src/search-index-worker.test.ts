import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerData: {} as Record<string, unknown>,
  postMessage: vi.fn(),
  createRegisteredAgents: vi.fn(),
  getCachePath: vi.fn(() => "/cache"),
  markAgentCacheInitialized: vi.fn(),
  saveCachedSessionChanges: vi.fn(),
  saveCachedSessions: vi.fn(),
  setFtsIntegrityCheckedPath: vi.fn(),
  syncSessionSearchIndex: vi.fn(),
  syncSessionSearchIndexChanges: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", () => ({
  createRegisteredAgents: mocks.createRegisteredAgents,
  getCachePath: mocks.getCachePath,
  markAgentCacheInitialized: mocks.markAgentCacheInitialized,
  saveCachedSessionChanges: mocks.saveCachedSessionChanges,
  saveCachedSessions: mocks.saveCachedSessions,
  setFtsIntegrityCheckedPath: mocks.setFtsIntegrityCheckedPath,
  syncSessionSearchIndex: mocks.syncSessionSearchIndex,
  syncSessionSearchIndexChanges: mocks.syncSessionSearchIndexChanges,
  // diagnostics-bridge.js (imported by the worker for its side effect) needs this export.
  setCoreDiagnostics: vi.fn(),
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
  mocks.workerData = {
    context: "refresh",
    agentNames: [],
    sessionsByAgent: {},
    metaByAgent: {},
  };
});

describe("search index worker", () => {
  it("builds legacy full jobs and preserves the integrity-check state", async () => {
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
      skipFtsIntegrityCheck: true,
    };

    await runWorker();

    expect(mocks.setFtsIntegrityCheckedPath).toHaveBeenCalledWith("/cache");
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
      { force: true },
    );
    expect(mocks.markAgentCacheInitialized).toHaveBeenCalledWith("codex");
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
      { force: true },
    );
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "done", sessions: 1 }),
    );
  });
});
