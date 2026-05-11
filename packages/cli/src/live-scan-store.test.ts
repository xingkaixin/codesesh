import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core";

const fsWatch = vi.hoisted(() => ({
  watch: vi.fn(),
  watchers: [] as Array<{
    path: string;
    options: { recursive?: boolean };
    listener: (eventType: string, filename: string | Buffer | null) => void;
    on: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>,
}));

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

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    watch: fsWatch.watch,
  };
});

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

import { LiveScanStore, resolveAgentWatchTargets, type SessionsUpdatedEvent } from "./live-scan.js";
import { appLogger } from "./logging.js";

let restoreRuntime: (() => void) | null = null;

function stubProcessRuntime(platform: NodeJS.Platform, nodeVersion: string): void {
  restoreRuntime?.();
  const originalPlatform = process.platform;
  const originalNodeVersion = process.versions.node;
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process.versions, "node", { configurable: true, value: nodeVersion });
  restoreRuntime = () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
    Object.defineProperty(process.versions, "node", {
      configurable: true,
      value: originalNodeVersion,
    });
  };
}

function registerMockWatcher(
  path: string,
  options: { recursive?: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) {
  const watcher = {
    path,
    options,
    listener,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  fsWatch.watchers.push(watcher);
  return {
    on: watcher.on,
    close: watcher.close,
  };
}

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
    fsWatch.watchers.length = 0;
    fsWatch.watch.mockImplementation(
      (
        path: string,
        options: { recursive?: boolean },
        listener: (eventType: string, filename: string | Buffer | null) => void,
      ) => registerMockWatcher(path, options, listener),
    );
    core.getCursorDataPath.mockReturnValue("/tmp/cursor");
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: "/tmp/claude",
      codexRoot: "/tmp/codex",
      kimiRoot: "/tmp/kimi",
      opencodeRoot: "/tmp/opencode",
    });
    core.filterSessions.mockImplementation((sessions: SessionHead[]) => sessions);
  });

  afterEach(() => {
    restoreRuntime?.();
    restoreRuntime = null;
    vi.useRealTimers();
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
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(250);

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

  it("marks search index sync as bulk when many paths are pending", async () => {
    const previous = makeSession("session", { title: "old", time_updated: 1000 });
    const updated = makeSession("session", { title: "new", time_updated: 2000 });
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["session"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [updated]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    (store as any).pendingRefreshPathCounts.set("codex", 101);
    await (store as any).runRefresh("codex");

    expect(core.syncSessionSearchIndex).toHaveBeenLastCalledWith(
      "codex",
      [updated],
      expect.any(Function),
      { isBulk: true },
    );
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

  it("uses native recursive watch and waits for appended files to stabilize", async () => {
    vi.useFakeTimers();
    stubProcessRuntime("darwin", "18.0.0");
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-watch-"));
    const codexRoot = join(tempDir, "codex");
    const sessionsDir = join(codexRoot, "sessions");
    const sessionFile = join(sessionsDir, "new.jsonl");
    mkdirSync(sessionsDir, { recursive: true });
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: join(tempDir, "claude"),
      codexRoot,
      kimiRoot: join(tempDir, "kimi"),
      opencodeRoot: join(tempDir, "opencode"),
    });

    const existingSession = makeSession("existing");
    const newSession = makeSession("new");
    const codex = makeAgent("codex", {
      scan: vi.fn(() => [newSession]),
    });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existingSession],
      byAgent: { codex: [existingSession] },
      agents: [codex],
    });

    const store = new LiveScanStore(true, { agents: ["codex"] });
    const events: SessionsUpdatedEvent[] = [];
    store.subscribe((event) => events.push(event));

    await store.initialize();
    expect(fsWatch.watchers).toEqual([
      expect.objectContaining({
        path: codexRoot,
        options: { recursive: true },
      }),
    ]);

    writeFileSync(sessionFile, "partial");
    fsWatch.watchers[0]!.listener("change", join("sessions", "new.jsonl"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);

    appendFileSync(sessionFile, "\ncomplete");
    fsWatch.watchers[0]!.listener("change", join("sessions", "new.jsonl"));
    await Promise.resolve();
    expect(codex.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(codex.scan).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      expect.objectContaining({
        changedAgents: ["codex"],
        newSessions: 1,
      }),
    ]);

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses non-recursive directory watches on Node 18 Linux", async () => {
    vi.useFakeTimers();
    stubProcessRuntime("linux", "18.19.0");
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-watch-fallback-"));
    const codexRoot = join(tempDir, "codex");
    const sessionsDir = join(codexRoot, "sessions");
    const dayDir = join(sessionsDir, "2026", "05", "10");
    const sessionFile = join(dayDir, "new.jsonl");
    mkdirSync(dayDir, { recursive: true });
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: join(tempDir, "claude"),
      codexRoot,
      kimiRoot: join(tempDir, "kimi"),
      opencodeRoot: join(tempDir, "opencode"),
    });

    const existingSession = makeSession("existing");
    const codex = makeAgent("codex", {
      scan: vi.fn(() => [makeSession("new")]),
    });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existingSession],
      byAgent: { codex: [existingSession] },
      agents: [codex],
    });

    const store = new LiveScanStore(true, { agents: ["codex"] });
    await store.initialize();

    expect(fsWatch.watchers.some((watcher) => watcher.options.recursive)).toBe(false);
    expect(fsWatch.watchers.map((watcher) => watcher.path)).toEqual(
      expect.arrayContaining([codexRoot, sessionsDir, dayDir]),
    );

    writeFileSync(sessionFile, "complete");
    const dayWatcher = fsWatch.watchers.find((watcher) => watcher.path === dayDir);
    expect(dayWatcher).toBeDefined();
    dayWatcher!.listener("rename", "new.jsonl");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(codex.scan).toHaveBeenCalledTimes(1);

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs refresh failures and handles later watch events", async () => {
    vi.useFakeTimers();
    const logError = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-watch-error-"));
    const codexRoot = join(tempDir, "codex");
    const sessionsDir = join(codexRoot, "sessions");
    const sessionFile = join(sessionsDir, "new.jsonl");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionFile, "session");
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: join(tempDir, "claude"),
      codexRoot,
      kimiRoot: join(tempDir, "kimi"),
      opencodeRoot: join(tempDir, "opencode"),
    });

    const existingSession = makeSession("existing");
    const codex = makeAgent("codex", {
      scan: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("bad file");
        })
        .mockImplementationOnce(() => [makeSession("new")]),
    });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existingSession],
      byAgent: { codex: [existingSession] },
      agents: [codex],
    });

    const store = new LiveScanStore(true, { agents: ["codex"] });
    await store.initialize();

    fsWatch.watchers[0]!.listener("change", join("sessions", "new.jsonl"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    appendFileSync(sessionFile, "\nretry");
    fsWatch.watchers[0]!.listener("change", join("sessions", "new.jsonl"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(codex.scan).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      "scan.refresh.error",
      expect.objectContaining({ agent: "codex", error: expect.any(Error) }),
    );

    await store.shutdown();
    rmSync(tempDir, { recursive: true, force: true });
    consoleError.mockRestore();
    logError.mockRestore();
  });

  it("merges new session events inside a short window", async () => {
    vi.useFakeTimers();
    const existingCodex = makeSession("codex-old");
    const existingKimi = makeSession("kimi-old");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["codex-new"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existingCodex, makeSession("codex-new")]),
    });
    const kimi = makeAgent("kimi", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["kimi-new"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existingKimi, makeSession("kimi-new")]),
    });
    core.createRegisteredAgents.mockReturnValue([codex, kimi]);
    core.scanSessions.mockResolvedValue({
      sessions: [existingCodex, existingKimi],
      byAgent: { codex: [existingCodex], kimi: [existingKimi] },
      agents: [codex, kimi],
    });

    const store = new LiveScanStore(false);
    const events: SessionsUpdatedEvent[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    await (store as any).runRefresh("codex");
    await (store as any).runRefresh("kimi");

    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([
      expect.objectContaining({
        changedAgents: ["codex", "kimi"],
        newSessions: 2,
        updatedSessions: 0,
        removedSessions: 0,
        totalSessions: 4,
      }),
    ]);
  });
});

describe("resolveAgentWatchTargets", () => {
  it("resolves cursor and opencode watch targets", () => {
    expect(resolveAgentWatchTargets("cursor")).toEqual([
      {
        root: "/tmp/cursor",
        path: join("/tmp/cursor", "globalStorage", "state.vscdb"),
      },
      { root: "/tmp/cursor", path: join("/tmp/cursor", "workspaceStorage") },
    ]);
    expect(resolveAgentWatchTargets("opencode")).toEqual([
      { root: "/tmp/opencode", path: join("/tmp/opencode", "opencode.db") },
      { root: "data/opencode", path: "data/opencode/opencode.db" },
    ]);
    expect(resolveAgentWatchTargets("unknown")).toEqual([]);
  });
});
