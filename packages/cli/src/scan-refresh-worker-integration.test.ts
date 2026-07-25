import type { BaseAgent, SessionHead, SessionSourceRef } from "@codesesh/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class FileSystemSessionSource {}

  return {
    workerData: {} as Record<string, unknown>,
    postMessage: vi.fn(),
    attachMissingProjectIdentities: vi.fn((sessions: SessionHead[]) => sessions),
    createRegisteredAgents: vi.fn(),
    ensureSessionTagsSync: vi.fn((_agent: BaseAgent, sessions: SessionHead[]) => ({ sessions })),
    FileSystemSessionSource,
  };
});

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
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
  return Object.assign(new mocks.FileSystemSessionSource(), {
    name: "codex",
    isAvailable: vi.fn(() => true),
    scan: vi.fn(() => []),
    incrementalScan: vi.fn(() => []),
    listSessionSources: vi.fn(() => []),
    scanSessionSource: vi.fn(() => null),
    getSessionData: vi.fn(),
    getSessionMetaMap: vi.fn(() => new Map()),
    setSessionMetaMap: vi.fn(),
    ...overrides,
  });
}

function setWorkerData(overrides: Record<string, unknown> = {}) {
  mocks.workerData = {
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
  mocks.ensureSessionTagsSync.mockImplementation((_agent, sessions) => ({ sessions }));
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
      expect.objectContaining({ type: "done", sessions: [], meta: {} }),
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
      progress: { agent: "codex", current: 1 },
    });
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        sessions: [session],
        meta: { fresh: { id: "fresh", sourcePath: "/fresh" } },
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
      expect.objectContaining({ type: "done", sessions: [updated] }),
    );
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
        sessions: [unchanged, updated, outsideWindow],
        changedIds: ["changed", "moved", "missing", "removed"],
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
      expect.objectContaining({ type: "done", sessions: [reparsed], changedIds: ["legacy"] }),
    );
  });
});
