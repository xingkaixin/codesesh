import type { BaseAgent, SessionCacheMeta, SessionHead, SessionSourceRef } from "@codesesh/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FileSystemSessionSource {}

  return {
    workerData: {} as Record<string, unknown>,
    postMessage: vi.fn(),
    attachMissingProjectIdentities: vi.fn((sessions: SessionHead[]) => sessions),
    createRegisteredAgents: vi.fn(),
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
  };
});

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage, on: vi.fn() },
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core")>();
  return {
    attachMissingProjectIdentities: mocks.attachMissingProjectIdentities,
    createRegisteredAgents: mocks.createRegisteredAgents,
    ensureSessionTagsSync: mocks.ensureSessionTagsSync,
    FileSystemSessionSource: mocks.FileSystemSessionSource,
    buildAgentCacheMeta: actual.buildAgentCacheMeta,
    computeSessionDiff: actual.computeSessionDiff,
    sessionSignature: actual.sessionSignature,
    sortSessions: actual.sortSessions,
    // The change decision is shared with FileSystemSessionSource.checkForChanges;
    // stubbing it would stop this suite from covering the wiring it exists to test.
    diffSessionSources: actual.diffSessionSources,
    // diagnostics-bridge.js (imported by the worker for its side effect) needs this export.
    setCoreDiagnostics: vi.fn(),
  };
});

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
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

function makeAgent(overrides: Record<string, unknown> = {}) {
  let sessionMetaMap = new Map<string, SessionCacheMeta>();
  return Object.assign(new mocks.FileSystemSessionSource(), {
    name: "codex",
    isAvailable: vi.fn(() => true),
    scan: vi.fn(() => []),
    incrementalScan: vi.fn(() => []),
    listSessionSources: vi.fn(() => []),
    scanSessionSource: vi.fn(() => null),
    getSessionData: vi.fn(),
    getSessionMetaMap: vi.fn(() => sessionMetaMap),
    setSessionMetaMap: vi.fn((next: Map<string, SessionCacheMeta>) => {
      sessionMetaMap = new Map(next);
    }),
    ...overrides,
  });
}

function setWorkerData(overrides: Record<string, unknown> = {}) {
  mocks.workerData = {
    type: "run",
    requestId: 1,
    agentName: "codex",
    previousSessions: [],
    changedIds: null,
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
  mocks.attachMissingProjectIdentities.mockImplementation((sessions) => sessions);
  mocks.ensureSessionTagsSync.mockImplementation((_agent, sessions, onProgress) => {
    onProgress?.(sessions.length, sessions.length);
    return { sessions };
  });
  setWorkerData();
});

describe("scan refresh worker entry", () => {
  it("reports an unknown agent as an error", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", error: "Unknown agent: codex" }),
    );
  });

  it("returns an empty result when the agent is unavailable", async () => {
    const agent = makeAgent({ isAvailable: vi.fn(() => false) });
    mocks.createRegisteredAgents.mockReturnValue([agent]);

    await runWorker();

    expect(agent.setSessionMetaMap).toHaveBeenCalledWith(new Map());
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
    const agent = makeAgent({
      scan,
      getSessionMetaMap: vi.fn(() => new Map([["fresh", { sourcePath: "/fresh" }]])),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);

    await runWorker();

    expect(mocks.postMessage).toHaveBeenNthCalledWith(1, {
      type: "progress",
      requestId: 1,
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

  it("emits a durable head checkpoint before metadata finalization", async () => {
    const session = makeSession("fresh", { time_updated: 1 });
    const agent = makeAgent({
      scan: vi.fn(() => [session]),
      getSessionMetaMap: vi.fn(() => new Map([["fresh", { sourcePath: "/fresh" }]])),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({ checkpoint: true });

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          stage: "scanned",
          sessions: [session],
        }),
      }),
    );
    expect(mocks.postMessage.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ type: "done" }),
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
      sourceSync: true,
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
        { sessionId: unchanged.id, sourcePath: "/unchanged", fingerprint: "same" },
        { sessionId: changed.id, sourcePath: "/changed", fingerprint: "new" },
      ]),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      sourceSync: true,
      checkpoint: true,
      previousSessions: [unchanged, makeSession(changed.id, { time_created: 1, time_updated: 1 })],
      meta: {
        unchanged: {
          id: unchanged.id,
          sourcePath: "/unchanged",
          sourceFingerprint: "same",
        },
        changed: {
          id: changed.id,
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
        id: unchanged.id,
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
      sourceSync: true,
      previousSessions: [parent, makeSession("child")],
      meta: {
        parent: { id: "parent", sourcePath: "/parent", sourceFingerprint: "same" },
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
      smart_tags_source_updated_at: 3_000,
    });
    const cursor = makeSession("cursor", {
      time_created: 2_000,
      time_updated: 2_000,
      smart_tags: [],
      smart_tags_source_updated_at: 2_000,
    });
    const next = makeSession("next", { time_created: 1_000, time_updated: 1_000 });
    const agent = makeAgent({
      listSessionSources: vi.fn(() =>
        [newest, cursor, next].map((session) => ({
          sessionId: session.id,
          sourcePath: `/${session.id}`,
          fingerprint: "same",
        })),
      ),
    });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({
      sourceSync: true,
      backfill: true,
      backfillCursor: cursor.id,
      checkpoint: true,
      previousSessions: [newest, cursor, next],
      meta: Object.fromEntries(
        [newest, cursor, next].map((session) => [
          session.id,
          {
            id: session.id,
            sourcePath: `/${session.id}`,
            sourceFingerprint: "same",
          },
        ]),
      ),
    });

    await runWorker();

    expect(mocks.ensureSessionTagsSync).toHaveBeenCalledWith(agent, [next], expect.any(Function));
    expect(mocks.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "checkpoint",
        checkpoint: expect.objectContaining({
          stage: "finalizing",
          backfillCursor: next.id,
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
      sourceSync: true,
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
    let meta = new Map<string, SessionCacheMeta>();
    const agent = makeAgent({
      scan: vi.fn(() => {
        meta.set("same", {
          id: "same",
          sourcePath: "/same",
          sourceFingerprint: "new",
        });
        return [session];
      }),
      getSessionMetaMap: vi.fn(() => meta),
      setSessionMetaMap: vi.fn((next: Map<string, SessionCacheMeta>) => {
        meta = new Map(next);
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

  it("runs an incremental scan for explicit changed ids", async () => {
    const previous = makeSession("previous");
    const updated = makeSession("updated");
    const incrementalScan = vi.fn(() => Promise.resolve([updated]));
    const agent = makeAgent({ incrementalScan });
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    setWorkerData({ previousSessions: [previous], changedIds: ["previous"] });

    await runWorker();

    expect(incrementalScan).toHaveBeenCalledWith([previous], ["previous"]);
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        changes: [{ session: updated, sortIndex: 0 }],
        removedSessionIds: ["previous"],
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
      sourceSync: true,
      previousSessions: [session],
      meta: {
        unchanged: {
          id: "unchanged",
          sourcePath: "/unchanged",
          sourceFingerprint: "same",
        },
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
      sourceSync: true,
      previousSessions: [recent],
      scanOptions: { from: 5, fast: true },
      meta: {
        recent: {
          id: "recent",
          sourcePath: "/recent",
          sourceFingerprint: "same",
          sourceMtimeMs: 10,
        },
      },
    });

    await runWorker();

    expect(mocks.ensureSessionTagsSync).not.toHaveBeenCalled();
  });

  it("synchronizes changed, removed, and out-of-window sources", async () => {
    const unchanged = makeSession("unchanged");
    const changed = makeSession("changed", { title: "old" });
    const removed = makeSession("removed");
    const outsideWindow = makeSession("outside");
    const moved = makeSession("moved");
    const updated = makeSession("changed", { title: "new" });
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
      sourceSync: true,
      previousSessions: [unchanged, changed, removed, outsideWindow, moved],
      // from: 5 puts `outside` (mtime 0) before the window and `removed`
      // (mtime 10) inside it, so only the latter counts as deleted on disk.
      scanOptions: { from: 5, fast: true },
      meta: {
        unchanged: { id: "unchanged", sourcePath: "/unchanged", sourceFingerprint: "same" },
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
        removedSessionIds: ["removed", "moved"],
        removedMetaIds: ["removed", "moved"],
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
      sourceSync: true,
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
