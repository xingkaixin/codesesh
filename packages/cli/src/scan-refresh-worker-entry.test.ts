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
    matchesScanWindow: vi.fn((_mtimeMs: number) => true),
    FileSystemSessionSource,
  };
});

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", () => ({
  attachMissingProjectIdentities: mocks.attachMissingProjectIdentities,
  createRegisteredAgents: mocks.createRegisteredAgents,
  ensureSessionTagsSync: mocks.ensureSessionTagsSync,
  FileSystemSessionSource: mocks.FileSystemSessionSource,
  matchesScanWindow: mocks.matchesScanWindow,
}));

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
  mocks.matchesScanWindow.mockReturnValue(true);
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
    const compatible = makeSession("compatible", { title: "same title" });
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
        sessionId: "compatible",
        sourcePath: "/compatible",
        fingerprint: JSON.stringify(["v2", 1, 42, null, "same title"]),
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
    mocks.matchesScanWindow.mockImplementation((mtimeMs) => mtimeMs !== 5);
    setWorkerData({
      sourceSync: true,
      previousSessions: [unchanged, changed, removed, outsideWindow, compatible],
      scanOptions: { from: 1, fast: true },
      meta: {
        unchanged: { id: "unchanged", sourcePath: "/unchanged", sourceFingerprint: "same" },
        changed: { id: "changed", sourcePath: "/changed", sourceFingerprint: "old" },
        removed: { id: "removed", sourcePath: "/removed", sourceMtimeMs: 10 },
        outside: { id: "outside", sourcePath: "/outside", sourceMtimeMs: 5 },
        compatible: {
          id: "compatible",
          sourcePath: "/compatible",
          sourceFingerprint: "legacy",
          sourceMtimeMs: 42,
        },
      },
    });

    await runWorker();

    expect(scanSessionSource).toHaveBeenCalledTimes(2);
    expect(scanSessionSource).toHaveBeenCalledWith("/changed");
    expect(scanSessionSource).toHaveBeenCalledWith("/missing");
    expect(mocks.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "done",
        sessions: [unchanged, updated, outsideWindow, compatible],
        changedIds: ["changed", "missing", "removed"],
      }),
    );
  });
});
