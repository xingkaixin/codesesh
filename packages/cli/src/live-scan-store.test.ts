import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core";

const core = vi.hoisted(() => ({
  createRegisteredAgents: vi.fn(),
  filterSessions: vi.fn((sessions: SessionHead[]) => sessions),
  getCursorDataPath: vi.fn(() => "/tmp/cursor"),
  resolveProviderRoots: vi.fn(() => ({
    claudeRoot: "/tmp/claude",
    codexRoot: "/tmp/codex",
    kimiRoot: "/tmp/kimi",
    opencodeRoot: "/tmp/opencode",
  })),
  scanSessions: vi.fn(),
  saveCachedSessions: vi.fn(),
  syncSessionSearchIndex: vi.fn(),
}));

vi.mock("@codesesh/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core")>();
  return {
    ...actual,
    createRegisteredAgents: core.createRegisteredAgents,
    filterSessions: core.filterSessions,
    getCursorDataPath: core.getCursorDataPath,
    resolveProviderRoots: core.resolveProviderRoots,
    scanSessions: core.scanSessions,
    saveCachedSessions: core.saveCachedSessions,
    syncSessionSearchIndex: core.syncSessionSearchIndex,
  };
});

vi.mock("chokidar", () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    })),
  },
}));

import { LiveScanStore, resolveAgentWatchTargets } from "./live-scan.js";

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/tmp/project",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function makeAgent(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    displayName: name,
    isAvailable: vi.fn(() => true),
    scan: vi.fn(() => []),
    getSessionData: vi.fn(() => ({
      id: "session",
      title: "session",
      slug: `${name}/session`,
      directory: "/tmp/project",
      time_created: 1000,
      time_updated: 1000,
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
      messages: [],
    })),
    getSessionMetaMap: vi.fn(() => new Map([["session", { id: "session", sourcePath: "/tmp/s" }]])),
    ...overrides,
  };
}

describe("LiveScanStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    core.filterSessions.mockImplementation((sessions: SessionHead[]) => sessions);
  });

  it("initializes a sorted snapshot for allowed registered agents", async () => {
    const codex = makeAgent("codex");
    const kimi = makeAgent("kimi");
    const older = makeSession("older", { time_updated: 1000 });
    const newer = makeSession("newer", { time_updated: 2000 });

    core.createRegisteredAgents.mockReturnValue([codex, kimi]);
    core.scanSessions.mockResolvedValue({
      sessions: [older, newer],
      byAgent: { codex: [older, newer] },
      agents: [codex],
    });

    const store = new LiveScanStore(false, { agents: ["codex", "kimi"] });
    await store.initialize();

    const snapshot = store.getSnapshot();
    expect(core.scanSessions).toHaveBeenCalledWith({
      agents: ["codex", "kimi"],
      useCache: true,
      smartRefresh: false,
      writeCache: undefined,
      includeSmartTags: undefined,
    });
    expect(snapshot.agents.map((agent) => agent.name)).toEqual(["codex", "kimi"]);
    expect(snapshot.byAgent.codex.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(snapshot.byAgent.kimi).toEqual([]);
    expect(snapshot.sessions.map((session) => session.id)).toEqual(["newer", "older"]);
  });

  it("emits refresh events and persists changed agent sessions", async () => {
    const previous = makeSession("session", { title: "old", time_updated: 1000 });
    const updated = makeSession("session", { title: "new", time_updated: 2000 });
    const added = makeSession("added", { time_updated: 1500 });
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["session", "added"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [updated, added]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    await (store as any).runRefresh("codex");

    expect(codex.checkForChanges).toHaveBeenCalledWith(expect.any(Number), [previous]);
    expect(codex.incrementalScan).toHaveBeenCalledWith(previous ? [previous] : [], [
      "session",
      "added",
    ]);
    expect(core.saveCachedSessions).toHaveBeenCalledWith("codex", [updated, added], {
      session: { id: "session", sourcePath: "/tmp/s" },
    });
    expect(core.syncSessionSearchIndex).toHaveBeenCalledWith(
      "codex",
      [updated, added],
      expect.any(Function),
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "sessions-updated",
        changedAgents: ["codex"],
        newSessions: 1,
        updatedSessions: 1,
        removedSessions: 0,
        totalSessions: 2,
      }),
    ]);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["session", "added"]);
  });

  it("removes sessions when an agent becomes unavailable", async () => {
    const previous = makeSession("session");
    const codex = makeAgent("codex", {
      isAvailable: vi.fn(() => false),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    await (store as any).runRefresh("codex");

    expect(core.saveCachedSessions).toHaveBeenCalledWith("codex", [], {
      session: { id: "session", sourcePath: "/tmp/s" },
    });
    expect(events).toEqual([
      expect.objectContaining({
        newSessions: 0,
        updatedSessions: 0,
        removedSessions: 1,
        totalSessions: 0,
      }),
    ]);
    expect(store.getSnapshot().sessions).toEqual([]);
  });
});

describe("resolveAgentWatchTargets", () => {
  it("resolves cursor and opencode watch targets", () => {
    expect(resolveAgentWatchTargets("cursor")).toEqual([
      { path: join("/tmp/cursor", "globalStorage", "state.vscdb") },
      { path: join("/tmp/cursor", "workspaceStorage"), depth: 2 },
    ]);
    expect(resolveAgentWatchTargets("opencode")).toEqual([
      { path: join("/tmp/opencode", "opencode.db") },
      { path: "data/opencode/opencode.db" },
    ]);
    expect(resolveAgentWatchTargets("unknown")).toEqual([]);
  });
});
