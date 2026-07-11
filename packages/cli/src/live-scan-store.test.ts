import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileSystemSessionSource,
  type AgentScanOptions,
  type ChangeCheckResult,
  type ProviderRoots,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionData,
  type SessionHead,
  type SessionSourceRef,
} from "@codesesh/core";

// Isolated temp directory for session fixtures so computeIdentity always
// resolves to a "path" identity regardless of manifests in /tmp.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-lsstore-"));
const FIXTURE_DIR_NAME = FIXTURE_DIR.split(/[\\/]/).pop()!;

const fsWatch = vi.hoisted(() => ({
  watch: vi.fn(),
  existsSync: vi.fn(),
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
  filterSessions: vi.fn((sessions: SessionHead[], _options: ScanOptions) => sessions),
  getCursorDataPath: vi.fn(() => "/tmp/cursor"),
  resolveProviderRoots: vi.fn(
    (): ProviderRoots => ({
      claudeRoot: "/tmp/claude",
      codexRoot: "/tmp/codex",
      kimiRoot: "/tmp/kimi",
      opencodeRoot: "/tmp/opencode",
      piRoot: "/tmp/pi",
      zcodeRoot: "/tmp/zcode",
    }),
  ),
  isAgentCacheInitialized: vi.fn(),
  loadCachedSessions: vi.fn(),
  markAgentCacheInitialized: vi.fn(),
  scanSessions: vi.fn(),
  saveCachedSessions: vi.fn(),
  saveCachedSessionChanges: vi.fn(),
  syncSessionSearchIndex: vi.fn(),
  syncSessionSearchIndexChanges: vi.fn(),
}));

const workerThreads = vi.hoisted(() => ({
  deferSearchIndexWorkers: false,
  deferScanRefreshWorkers: false,
  workers: [] as Array<{
    url: URL;
    workerData: any;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    emitDone: () => void;
    emitError: (error: Error) => void;
    emitExit: (code: number) => void;
  }>,
  Worker: vi.fn(function (this: unknown, url: URL, options?: { workerData?: unknown }) {
    const workerData = options?.workerData as any;
    const deferredSearchWorker = workerThreads.deferSearchIndexWorkers && workerData?.jobs;
    const deferredScanWorker = workerThreads.deferScanRefreshWorkers && workerData?.agentName;
    const deferredMessageHandlers: Array<(message: unknown) => void> = [];
    const deferredExitHandlers: Array<(code: number) => void> = [];
    const deferredErrorHandlers: Array<(error: Error) => void> = [];
    const runSourceSync = (agent: any) => {
      const parseSourceFingerprint = (fingerprint: string) => {
        try {
          const parsed = JSON.parse(fingerprint);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      };
      const sourceFingerprintMatches = (source: any, cachedSession: SessionHead, cached: any) => {
        if (cached?.sourceFingerprint === source.fingerprint) return true;
        const current = parseSourceFingerprint(source.fingerprint);
        return (
          Boolean(current) &&
          typeof cached?.sourceMtimeMs === "number" &&
          cached.sourceMtimeMs === current![2] &&
          (current![4] == null || cachedSession.title === current![4])
        );
      };
      const sessionMap = new Map(
        (workerData.previousSessions ?? []).map((session: SessionHead) => [session.id, session]),
      );
      const changedIds = new Set<string>();
      const sources = agent.listSessionSources();
      const currentIds = new Set(sources.map((source: any) => source.sessionId));

      for (const source of sources) {
        const cachedSession = sessionMap.get(source.sessionId);
        const cached = workerData.meta?.[source.sessionId];
        if (
          cachedSession &&
          cached?.sourcePath === source.sourcePath &&
          sourceFingerprintMatches(source, cachedSession as SessionHead, cached)
        ) {
          continue;
        }
        const next = agent.scanSessionSource(source.sourcePath);
        changedIds.add(source.sessionId);
        if (next) sessionMap.set(next.id, next);
        else sessionMap.delete(source.sessionId);
      }

      for (const session of workerData.previousSessions ?? []) {
        if (!currentIds.has(session.id)) {
          sessionMap.delete(session.id);
          changedIds.add(session.id);
        }
      }

      return { sessions: [...sessionMap.values()], changedIds: [...changedIds] };
    };
    const serializeMeta = (agent: any) =>
      Object.fromEntries(agent.getSessionMetaMap?.()?.entries?.() ?? []);
    const worker = {
      url,
      workerData,
      on: vi.fn((event: string, handler: (message: unknown) => void) => {
        if (event === "message") {
          if (deferredSearchWorker || deferredScanWorker) {
            deferredMessageHandlers.push(handler);
            return worker;
          }
          queueMicrotask(() => {
            try {
              if (workerData?.agentName) {
                const agent = core
                  .createRegisteredAgents()
                  .find((item: any) => item.name === workerData.agentName);
                agent?.setSessionMetaMap?.(new Map(Object.entries(workerData.meta ?? {})));
                let sessions: SessionHead[] = [];
                let changedIds: string[] | undefined;
                if (agent?.isAvailable?.() !== false) {
                  if (
                    workerData.sourceSync &&
                    agent?.listSessionSources &&
                    agent?.scanSessionSource
                  ) {
                    const result = runSourceSync(agent);
                    sessions = result.sessions as SessionHead[];
                    changedIds = result.changedIds;
                  } else if (workerData.changedIds && agent?.incrementalScan) {
                    sessions = agent.incrementalScan(
                      workerData.previousSessions,
                      workerData.changedIds,
                    );
                  } else {
                    sessions = agent?.scan?.({
                      ...workerData.scanOptions,
                      onProgress: () => undefined,
                    });
                  }
                }
                handler({
                  type: "done",
                  sessions,
                  meta: serializeMeta(agent),
                  changedIds,
                  durationMs: 0,
                });
                return;
              }
            } catch (error) {
              handler({
                type: "error",
                error: error instanceof Error ? error.message : String(error),
                durationMs: 0,
              });
              return;
            }
            const jobs = workerData?.jobs ?? [];
            handler({
              type: "done",
              context: workerData?.context ?? "",
              durationMs: 0,
              sessions: jobs.length,
            });
          });
        }
        if (event === "exit") {
          if (deferredSearchWorker || deferredScanWorker) deferredExitHandlers.push(handler);
          else queueMicrotask(() => handler(0));
        }
        if (event === "error" && (deferredSearchWorker || deferredScanWorker)) {
          deferredErrorHandlers.push(handler);
        }
        return worker;
      }),
      once: vi.fn((event: string, handler: (message: unknown) => void) => {
        if (event === "exit") {
          if (deferredSearchWorker || deferredScanWorker) deferredExitHandlers.push(handler);
          else queueMicrotask(() => handler(0));
        }
        return worker;
      }),
      unref: vi.fn(),
      terminate: vi.fn(async () => {
        for (const handler of deferredExitHandlers) handler(0);
      }),
      emitDone: () => {
        for (const handler of deferredMessageHandlers) {
          handler({
            type: "done",
            context: workerData?.context ?? "",
            durationMs: 0,
            sessions: workerData?.jobs?.length ?? 0,
          });
        }
        for (const handler of deferredExitHandlers) handler(0);
      },
      emitError: (error: Error) => {
        for (const handler of deferredErrorHandlers) handler(error);
      },
      emitExit: (code: number) => {
        for (const handler of deferredExitHandlers) handler(code);
      },
    };
    workerThreads.workers.push(worker);
    return worker;
  }),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  fsWatch.existsSync.mockImplementation((path: Parameters<typeof actual.existsSync>[0]) =>
    String(path).endsWith("search-index-worker.js") ? true : actual.existsSync(path),
  );
  return {
    ...actual,
    existsSync: fsWatch.existsSync,
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
    isAgentCacheInitialized: core.isAgentCacheInitialized,
    loadCachedSessions: core.loadCachedSessions,
    markAgentCacheInitialized: core.markAgentCacheInitialized,
    resolveProviderRoots: core.resolveProviderRoots,
    scanSessions: core.scanSessions,
    saveCachedSessions: core.saveCachedSessions,
    saveCachedSessionChanges: core.saveCachedSessionChanges,
    syncSessionSearchIndex: core.syncSessionSearchIndex,
    syncSessionSearchIndexChanges: core.syncSessionSearchIndexChanges,
  };
});

vi.mock("node:worker_threads", () => ({
  Worker: workerThreads.Worker,
}));

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
    directory: FIXTURE_DIR,
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

const projectIdentity = {
  kind: "path" as const,
  key: FIXTURE_DIR,
  displayName: FIXTURE_DIR_NAME,
};

function makeAgent(name: string, overrides: Record<string, unknown> = {}) {
  const agent: Record<string, unknown> = {
    name,
    displayName: name,
    isAvailable: vi.fn(() => true),
    getSessionData: vi.fn(() => ({
      id: "session",
      title: "session",
      slug: `${name}/session`,
      directory: FIXTURE_DIR,
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
    setSessionMetaMap: vi.fn(),
    // Database-style agents detect changes via checkForChanges and rescan via
    // incrementalScan (which delegates to scan), mirroring DatabaseSessionSource.
    checkForChanges: vi.fn(() => ({ hasChanges: true, changedIds: [], timestamp: 0 })),
    incrementalScan: vi.fn(() => (agent.scan as () => SessionHead[])()),
  };
  agent.scan = vi.fn(() => []);
  Object.assign(agent, overrides);
  return agent;
}

/**
 * Builds a mock agent that is a real FileSystemSessionSource instance, so the
 * live-scan refresh routes it through the source-sync path. Each primitive is
 * overridable via vi.fn.
 */
function makeFileSystemAgent(
  name: string,
  overrides: {
    listSessionSources?: (options?: AgentScanOptions) => SessionSourceRef[];
    scanSessionSource?: (sourcePath: string) => SessionHead | null;
    getSessionMetaMap?: () => Map<string, SessionCacheMeta>;
    setSessionMetaMap?: (meta: Map<string, SessionCacheMeta>) => void;
    checkForChanges?: (sinceTimestamp: number, cachedSessions: SessionHead[]) => ChangeCheckResult;
    incrementalScan?: (cachedSessions: SessionHead[], changedIds: string[]) => SessionHead[];
  } = {},
) {
  const agent = Object.create(FileSystemSessionSource.prototype) as InstanceType<
    typeof FileSystemSessionSource
  >;
  Object.defineProperty(agent, "name", { value: name, configurable: true });
  Object.defineProperty(agent, "displayName", { value: name, configurable: true });
  agent.isAvailable = vi.fn(() => true);
  agent.scan = vi.fn(() => []);
  agent.getSessionData = vi.fn(() => ({}) as SessionData);
  agent.listSessionSources = overrides.listSessionSources ?? vi.fn(() => []);
  agent.scanSessionSource = overrides.scanSessionSource ?? vi.fn(() => null);
  agent.getSessionMetaMap = overrides.getSessionMetaMap ?? vi.fn(() => new Map());
  agent.setSessionMetaMap = overrides.setSessionMetaMap ?? vi.fn();
  agent.checkForChanges =
    overrides.checkForChanges ??
    vi.fn(() => ({ hasChanges: false, changedIds: [], timestamp: Date.now() }));
  agent.incrementalScan = overrides.incrementalScan ?? vi.fn((cached: SessionHead[]) => cached);
  return agent;
}

describe("LiveScanStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsWatch.watchers.length = 0;
    workerThreads.workers.length = 0;
    workerThreads.deferSearchIndexWorkers = false;
    workerThreads.deferScanRefreshWorkers = false;
    fsWatch.watch.mockImplementation(
      (
        path: string,
        options: { recursive?: boolean },
        listener: (eventType: string, filename: string | Buffer | null) => void,
      ) => registerMockWatcher(path, options, listener),
    );
    core.getCursorDataPath.mockReturnValue("/tmp/cursor");
    core.isAgentCacheInitialized.mockReturnValue(true);
    core.loadCachedSessions.mockReturnValue(null);
    core.markAgentCacheInitialized.mockReset();
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: "/tmp/claude",
      codexRoot: "/tmp/codex",
      kimiRoot: "/tmp/kimi",
      opencodeRoot: "/tmp/opencode",
      piRoot: "/tmp/pi",
      zcodeRoot: "/tmp/zcode",
    });
    core.filterSessions.mockImplementation((sessions: SessionHead[]) => sessions);
  });

  afterEach(() => {
    restoreRuntime?.();
    restoreRuntime = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    expect(core.scanSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ["codex", "kimi"],
        useCache: true,
        smartRefresh: false,
        writeCache: undefined,
        includeSmartTags: undefined,
      }),
    );
    expect(snapshot.agents.map((agent) => agent.name)).toEqual(["codex", "kimi"]);
    expect(snapshot.byAgent.codex!.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(snapshot.byAgent.kimi).toEqual([]);
    expect(snapshot.sessions.map((session) => session.id)).toEqual(["newer", "older"]);
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      expect.objectContaining({
        kind: "full",
        context: "scan.initial",
        agentName: "codex",
        sessions: [newer, older],
      }),
      expect.objectContaining({
        kind: "full",
        context: "scan.initial",
        agentName: "kimi",
        sessions: [],
      }),
    ]);
  });

  it("can initialize from cache and refresh sessions in the background", async () => {
    vi.useFakeTimers();
    const cached = makeSession("cached", { title: "cached", time_updated: 1000 });
    const fresh = makeSession("fresh", { title: "fresh", time_updated: 2000 });
    const codex = makeAgent("codex", {
      scan: vi.fn(() => [fresh]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [cached],
      byAgent: { codex: [cached] },
      agents: [codex],
      cacheTimestamps: { codex: 500 },
    });

    const store = new LiveScanStore(false, {}, {}, { deferInitialRefresh: true });
    const events: unknown[] = [];
    const statusEvents: unknown[] = [];
    store.subscribe((event) => events.push(event));
    store.subscribeScanStatus((event) => statusEvents.push(event));

    await store.initialize();

    expect(core.scanSessions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        useCache: true,
        smartRefresh: false,
        cacheOnly: true,
        writeCache: false,
        includeSmartTags: false,
      }),
    );
    expect(workerThreads.workers).toHaveLength(0);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["cached"]);

    store.startBackgroundRefresh();
    expect(statusEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: "scan-status",
        active: true,
        phase: "scanning",
        pendingAgents: ["codex"],
        totalAgents: 1,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.scan).toHaveBeenCalled();
    expect(workerThreads.workers.find((worker) => worker.workerData.jobs)?.workerData.jobs).toEqual(
      [
        expect.objectContaining({
          kind: "changes",
          context: "scan.refresh",
          agentName: "codex",
          changes: [{ session: { ...fresh, project_identity: projectIdentity }, sortIndex: 0 }],
          removedSessionIds: ["cached"],
        }),
      ],
    );
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["fresh"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(events).toEqual([
      expect.objectContaining({
        type: "sessions-updated",
        changedAgents: ["codex"],
        newSessions: 1,
        removedSessions: 1,
        totalSessions: 1,
      }),
    ]);
    expect(statusEvents.at(-1)).toEqual(
      expect.objectContaining({
        type: "scan-status",
        active: false,
        phase: "idle",
        completedAgents: ["codex"],
        totalAgents: 1,
      }),
    );
  });

  it("uses full cache change checks for a cached startup time window", async () => {
    vi.useFakeTimers();
    const old = makeSession("old", { time_updated: 1000 });
    const recent = makeSession("recent", { time_updated: 5000 });
    const codex = makeAgent("codex", {
      scan: vi.fn(() => [old, recent]),
      checkForChanges: vi.fn(() => ({
        hasChanges: false,
        timestamp: 2000,
      })),
      incrementalScan: vi.fn(() => [old, recent]),
      setSessionMetaMap: vi.fn(),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [recent],
      byAgent: { codex: [recent] },
      agents: [codex],
      cacheTimestamps: { codex: 1000 },
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [old, recent],
      byAgent: { codex: [old, recent] },
      meta: {
        old: { id: "old", sourcePath: "/tmp/old" },
        recent: { id: "recent", sourcePath: "/tmp/recent" },
      },
      timestamp: 1000,
    });
    core.filterSessions.mockImplementation((sessions: SessionHead[], options: { from?: number }) =>
      options.from == null
        ? sessions
        : sessions.filter(
            (session) => (session.time_updated ?? session.time_created) >= options.from!,
          ),
    );

    const store = new LiveScanStore(false, {}, { from: 3000 }, { deferInitialRefresh: true });
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).toHaveBeenCalledWith(1000, [old, recent]);
    expect(codex.setSessionMetaMap).toHaveBeenCalledWith(
      new Map([
        ["old", { id: "old", sourcePath: "/tmp/old" }],
        ["recent", { id: "recent", sourcePath: "/tmp/recent" }],
      ]),
    );
    expect(codex.scan).not.toHaveBeenCalled();
    expect(codex.incrementalScan).not.toHaveBeenCalled();
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["recent"]);
    expect(workerThreads.workers).toHaveLength(0);
  });

  it("builds a full cache before applying the startup time window when no cache is available", async () => {
    vi.useFakeTimers();
    const old = makeSession("old", { time_updated: 1000 });
    const recent = makeSession("recent", { time_updated: 5000 });
    const codex = makeAgent("codex", {
      scan: vi.fn((options?: { from?: number }) => (options?.from ? [recent] : [old, recent])),
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["recent"],
        timestamp: 2000,
      })),
      incrementalScan: vi.fn(() => [recent]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [],
      byAgent: {},
      agents: [codex],
    });
    core.filterSessions.mockImplementation((sessions: SessionHead[], options: { from?: number }) =>
      options.from == null
        ? sessions
        : sessions.filter(
            (session) => (session.time_updated ?? session.time_created) >= options.from!,
          ),
    );

    const store = new LiveScanStore(false, {}, { from: 3000 }, { deferInitialRefresh: true });
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(core.loadCachedSessions).toHaveBeenCalledWith("codex");
    expect(codex.scan).toHaveBeenCalledWith(
      expect.objectContaining({
        onProgress: expect.any(Function),
      }),
    );
    expect((codex.scan as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty("from");
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["recent"]);
    expect(workerThreads.workers.find((worker) => worker.workerData.jobs)?.workerData.jobs).toEqual(
      [
        expect.objectContaining({
          kind: "full",
          context: "scan.refresh",
          agentName: "codex",
          sessions: [
            { ...old, project_identity: projectIdentity },
            { ...recent, project_identity: projectIdentity },
          ],
          saveCache: true,
        }),
      ],
    );
    expect(workerThreads.workers).toHaveLength(2);
  });

  it("serializes refresh behind an in-flight backfill for the same agent", async () => {
    const initial = makeSession("session", { title: "initial", time_updated: 1000 });
    const stale = makeSession("session", { title: "stale backfill", time_updated: 2000 });
    const fresh = makeSession("session", { title: "fresh refresh", time_updated: 3000 });
    const codex = makeFileSystemAgent("codex");
    let releaseBackfill: ((result: unknown) => void) | undefined;

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      agents: [codex],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      meta: {},
      timestamp: 1000,
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    const logInfo = vi.spyOn(appLogger, "info").mockImplementation(() => undefined);
    const scanAgentInWorker = vi
      .spyOn(store as any, "scanAgentInWorker")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseBackfill = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessions: [fresh], meta: {}, changedIds: [fresh.id] });

    const backfill = (store as any).runBackfill("codex");
    await vi.waitFor(() => expect(scanAgentInWorker).toHaveBeenCalledTimes(1));

    const refresh = (store as any).refreshAgent("codex");
    await Promise.resolve();
    expect(scanAgentInWorker).toHaveBeenCalledTimes(1);

    releaseBackfill!({ sessions: [stale], meta: {}, changedIds: [stale.id] });
    await backfill;
    await refresh;

    expect(store.getSnapshot().sessions[0]?.title).toBe("fresh refresh");
    expect(
      logInfo.mock.calls
        .filter(([event]) => String(event).startsWith("scan.agent_operation."))
        .map(([event, fields]) => [event, fields?.operation, fields?.generation, fields?.result]),
    ).toEqual([
      ["scan.agent_operation.started", "backfill", 1, undefined],
      ["scan.agent_operation.completed", "backfill", 1, "committed"],
      ["scan.agent_operation.started", "refresh", 2, undefined],
      ["scan.agent_operation.completed", "refresh", 2, "committed"],
    ]);
  });

  it("runs a queued refresh after a backfill failure", async () => {
    const initial = makeSession("session", { title: "initial", time_updated: 1000 });
    const fresh = makeSession("session", { title: "fresh", time_updated: 2000 });
    const codex = makeFileSystemAgent("codex");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      agents: [codex],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      meta: {},
      timestamp: 1000,
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    vi.spyOn(store as any, "scanAgentInWorker")
      .mockRejectedValueOnce(new Error("backfill failed"))
      .mockResolvedValueOnce({ sessions: [fresh], meta: {}, changedIds: [fresh.id] });

    const backfill = (store as any).runBackfill("codex");
    const refresh = (store as any).refreshAgent("codex");
    await Promise.all([backfill, refresh]);

    expect(consoleError).toHaveBeenCalledWith("[codex] Backfill failed:", expect.any(Error));
    expect(store.getSnapshot().sessions[0]?.title).toBe("fresh");
  });

  it("allows another agent to refresh while a backfill is in flight", async () => {
    const codexInitial = makeSession("codex-session", { slug: "codex/codex-session" });
    const kimiInitial = makeSession("kimi-session", {
      slug: "kimi/kimi-session",
      title: "kimi initial",
    });
    const kimiFresh = makeSession("kimi-session", {
      slug: "kimi/kimi-session",
      title: "kimi fresh",
      time_updated: 2000,
    });
    const codex = makeFileSystemAgent("codex");
    const kimi = makeAgent("kimi", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: [kimiFresh.id],
        timestamp: 2000,
      })),
      incrementalScan: vi.fn(() => [kimiFresh]),
    });
    let releaseBackfill: ((result: unknown) => void) | undefined;

    core.createRegisteredAgents.mockReturnValue([codex, kimi]);
    core.scanSessions.mockResolvedValue({
      sessions: [codexInitial, kimiInitial],
      byAgent: { codex: [codexInitial], kimi: [kimiInitial] },
      agents: [codex, kimi],
    });
    core.loadCachedSessions.mockReturnValue(null);

    const store = new LiveScanStore(false);
    await store.initialize();
    const scanAgentInWorker = vi.spyOn(store as any, "scanAgentInWorker").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseBackfill = resolve;
        }),
    );

    const backfill = (store as any).runBackfill("codex");
    await vi.waitFor(() => expect(scanAgentInWorker).toHaveBeenCalledTimes(1));

    await (store as any).refreshAgent("kimi");
    expect(store.getSnapshot().byAgent.kimi![0]?.title).toBe("kimi fresh");

    releaseBackfill!({ sessions: [codexInitial], meta: {}, changedIds: [] });
    await backfill;
  });

  it("coalesces refresh schedules received while backfill is active", async () => {
    vi.useFakeTimers();
    const initial = makeSession("session", { title: "initial", time_updated: 1000 });
    const backfilled = makeSession("session", { title: "backfilled", time_updated: 2000 });
    const refreshed = makeSession("session", { title: "refreshed", time_updated: 3000 });
    const rerun = makeSession("session", { title: "rerun", time_updated: 4000 });
    const codex = makeFileSystemAgent("codex");
    let releaseBackfill: ((result: unknown) => void) | undefined;

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      agents: [codex],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [initial],
      byAgent: { codex: [initial] },
      meta: {},
      timestamp: 1000,
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    const scanAgentInWorker = vi
      .spyOn(store as any, "scanAgentInWorker")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseBackfill = resolve;
          }),
      )
      .mockResolvedValueOnce({ sessions: [refreshed], meta: {}, changedIds: [refreshed.id] })
      .mockResolvedValueOnce({ sessions: [rerun], meta: {}, changedIds: [rerun.id] });

    const backfill = (store as any).runBackfill("codex");
    await vi.waitFor(() => expect(scanAgentInWorker).toHaveBeenCalledTimes(1));

    (store as any).getRefreshState("codex").pendingPathCount += 1;
    (store as any).scheduleRefresh("codex", 0);
    await vi.advanceTimersByTimeAsync(0);
    (store as any).getRefreshState("codex").pendingPathCount += 2;
    (store as any).scheduleRefresh("codex", 0);
    (store as any).scheduleRefresh("codex", 0);
    await vi.advanceTimersByTimeAsync(0);

    expect(scanAgentInWorker).toHaveBeenCalledTimes(1);
    releaseBackfill!({ sessions: [backfilled], meta: {}, changedIds: [backfilled.id] });
    await backfill;
    await vi.waitFor(() => expect(scanAgentInWorker).toHaveBeenCalledTimes(2));

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(scanAgentInWorker).toHaveBeenCalledTimes(3));
    expect(store.getSnapshot().sessions[0]?.title).toBe("rerun");
  });

  it("rejects a scan worker that exits successfully before sending done", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const store = new LiveScanStore(false);
    const agent = makeFileSystemAgent("codex");
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    core.createRegisteredAgents.mockReturnValue([agent]);

    const refresh = (store as any).scanAgentInWorker(agent, [], null, {});
    const worker = workerThreads.workers.at(-1)!;
    worker.emitExit(0);

    await expect(refresh).rejects.toThrow("exited before completing (code 0)");
    expect(warn).toHaveBeenCalledWith("scan.refresh_worker.exit_before_done", {
      agent: "codex",
      code: 0,
    });

    workerThreads.deferScanRefreshWorkers = false;
    await expect((store as any).scanAgentInWorker(agent, [], null, {})).resolves.toEqual({
      sessions: [],
      meta: {},
      changedIds: undefined,
    });
  });

  it("persists incremental changes outside the startup time window", async () => {
    vi.useFakeTimers();
    const old = makeSession("old", { title: "old", time_updated: 1000 });
    const updatedOld = makeSession("old", { title: "updated", time_updated: 1000 });
    const recent = makeSession("recent", { time_updated: 5000 });
    const updatedOldWithProject = { ...updatedOld, project_identity: projectIdentity };
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["old"],
        timestamp: 2000,
      })),
      incrementalScan: vi.fn(() => [updatedOld, recent]),
      setSessionMetaMap: vi.fn(),
      getSessionMetaMap: vi.fn(
        () =>
          new Map([
            ["old", { id: "old", sourcePath: "/tmp/old" }],
            ["recent", { id: "recent", sourcePath: "/tmp/recent" }],
          ]),
      ),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [recent],
      byAgent: { codex: [recent] },
      agents: [codex],
      cacheTimestamps: { codex: 1000 },
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [old, recent],
      byAgent: { codex: [old, recent] },
      meta: {
        old: { id: "old", sourcePath: "/tmp/old" },
        recent: { id: "recent", sourcePath: "/tmp/recent" },
      },
      timestamp: 1000,
    });
    core.filterSessions.mockImplementation((sessions: SessionHead[], options: { from?: number }) =>
      options.from == null
        ? sessions
        : sessions.filter(
            (session) => (session.time_updated ?? session.time_created) >= options.from!,
          ),
    );

    const store = new LiveScanStore(false, {}, { from: 3000 }, { deferInitialRefresh: true });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).toHaveBeenCalledWith(1000, [old, recent]);
    expect(codex.incrementalScan).toHaveBeenCalledWith([old, recent], ["old"]);
    expect(store.getSnapshot().sessions.map((session) => session.id)).toEqual(["recent"]);
    expect(events).toEqual([]);
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        changes: [{ session: updatedOldWithProject, sortIndex: 0 }],
        removedSessionIds: [],
        meta: { old: { id: "old", sourcePath: "/tmp/old" } },
      },
    ]);
  });

  it("uses source fingerprints to refresh only changed file-backed sessions", async () => {
    vi.useFakeTimers();
    const previous = makeSession("session", { title: "old", time_updated: 1000 });
    const updated = makeSession("session", { title: "new", time_updated: 2000 });
    const added = makeSession("added", { time_updated: 2500 });
    const updatedWithProject = { ...updated, project_identity: projectIdentity };
    const addedWithProject = { ...added, project_identity: projectIdentity };
    const scanSessionSource = vi.fn((sourcePath: string) =>
      sourcePath === "/tmp/s" ? updated : added,
    );
    const codex = makeFileSystemAgent("codex", {
      checkForChanges: vi.fn(() => {
        throw new Error("checkForChanges should not run for source-backed agents");
      }),
      incrementalScan: vi.fn(),
      listSessionSources: vi.fn(() => [
        { sessionId: "session", sourcePath: "/tmp/s", fingerprint: "next" },
        { sessionId: "added", sourcePath: "/tmp/added", fingerprint: "new" },
      ]),
      scanSessionSource,
      getSessionMetaMap: vi.fn(
        () =>
          new Map([
            ["session", { id: "session", sourcePath: "/tmp/s", sourceFingerprint: "next" }],
            ["added", { id: "added", sourcePath: "/tmp/added", sourceFingerprint: "new" }],
          ]),
      ),
      setSessionMetaMap: vi.fn(),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [previous],
      meta: {
        session: { id: "session", sourcePath: "/tmp/s", sourceFingerprint: "old" },
      },
      timestamp: 1000,
    });

    const store = new LiveScanStore(false);
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    await (store as any).runRefresh("codex");
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).not.toHaveBeenCalled();
    expect(codex.incrementalScan).not.toHaveBeenCalled();
    expect(scanSessionSource).toHaveBeenCalledTimes(2);
    expect(scanSessionSource).toHaveBeenCalledWith("/tmp/s");
    expect(scanSessionSource).toHaveBeenCalledWith("/tmp/added");
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        changes: [
          { session: updatedWithProject, sortIndex: 0 },
          { session: addedWithProject, sortIndex: 1 },
        ],
        removedSessionIds: [],
        meta: {
          session: { id: "session", sourcePath: "/tmp/s", sourceFingerprint: "next" },
          added: { id: "added", sourcePath: "/tmp/added", sourceFingerprint: "new" },
        },
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        newSessions: 1,
        updatedSessions: 1,
        removedSessions: 0,
      }),
    ]);
  });

  it("does not rescan legacy Codex cache entries when only the fingerprint format changed", async () => {
    const previous = makeSession("session", { title: "same title", time_updated: 1000 });
    const scanSessionSource = vi.fn(() => makeSession("session", { title: "same title" }));
    const legacyFingerprint = JSON.stringify([
      "codex-head-v1",
      "codex-parser-v3",
      1234,
      5678,
      9999,
    ]);
    const currentFingerprint = JSON.stringify([
      "codex-head-v1",
      "codex-parser-v3",
      1234,
      5678,
      "same title",
    ]);
    const codex = makeFileSystemAgent("codex", {
      listSessionSources: vi.fn(() => [
        {
          sessionId: "session",
          sourcePath: "/tmp/s",
          fingerprint: currentFingerprint,
        },
      ]),
      scanSessionSource,
      getSessionMetaMap: vi.fn(
        () =>
          new Map([
            [
              "session",
              {
                id: "session",
                sourcePath: "/tmp/s",
                sourceFingerprint: legacyFingerprint,
                sourceMtimeMs: 1234,
              },
            ],
          ]),
      ),
      setSessionMetaMap: vi.fn(),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });
    core.loadCachedSessions.mockReturnValue({
      sessions: [previous],
      meta: {
        session: {
          id: "session",
          sourcePath: "/tmp/s",
          sourceFingerprint: legacyFingerprint,
          sourceMtimeMs: 1234,
        },
      },
      timestamp: 1000,
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    await (store as any).runRefresh("codex");

    expect(scanSessionSource).not.toHaveBeenCalled();
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      expect.objectContaining({
        kind: "changes",
        changes: [],
        removedSessionIds: [],
      }),
    ]);
  });

  it("emits refresh events and persists changed agent sessions", async () => {
    vi.useFakeTimers();
    const previous = makeSession("session", { title: "old", time_updated: 1000 });
    const updated = makeSession("session", { title: "new", time_updated: 2000 });
    const added = makeSession("added", { time_updated: 1500 });
    const updatedWithProject = { ...updated, project_identity: projectIdentity };
    const addedWithProject = { ...added, project_identity: projectIdentity };
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["session", "added"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [updated, added]),
      getSessionMetaMap: vi.fn(
        () =>
          new Map([
            ["session", { id: "session", sourcePath: "/tmp/s" }],
            ["unrelated", { id: "unrelated", sourcePath: "/tmp/unrelated" }],
          ]),
      ),
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
    expect(core.saveCachedSessions).not.toHaveBeenCalled();
    expect(core.saveCachedSessionChanges).not.toHaveBeenCalled();
    expect(core.syncSessionSearchIndex).not.toHaveBeenCalled();
    expect(core.syncSessionSearchIndexChanges).not.toHaveBeenCalled();
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        changes: [
          { session: updatedWithProject, sortIndex: 0 },
          { session: addedWithProject, sortIndex: 1 },
        ],
        removedSessionIds: [],
        meta: { session: { id: "session", sourcePath: "/tmp/s" } },
      },
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "sessions-updated",
        changedAgents: ["codex"],
        newSessions: 1,
        updatedSessions: 1,
        removedSessions: 0,
        totalSessions: 2,
        changedSessionHeads: [
          { agentName: "codex", session: updatedWithProject },
          { agentName: "codex", session: addedWithProject },
        ],
        removedSessionRefs: [],
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
    (store as any).getRefreshState("codex").pendingPathCount = 101;
    await (store as any).runRefresh("codex");

    expect(workerThreads.workers.at(-1)?.workerData.jobs[0]).toEqual(
      expect.objectContaining({
        kind: "changes",
        searchIndexOptions: { isBulk: true },
      }),
    );
  });

  it("emits an update event when changed session content keeps the same head signature", async () => {
    const previous = makeSession("session", { title: "same", time_updated: 1000 });
    const previousWithProject = { ...previous, project_identity: projectIdentity };
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["session"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [previous]),
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

    expect(events).toEqual([
      expect.objectContaining({
        type: "sessions-updated",
        changedAgents: ["codex"],
        newSessions: 0,
        updatedSessions: 1,
        removedSessions: 0,
        changedSessionHeads: [{ agentName: "codex", session: previousWithProject }],
        removedSessionRefs: [],
      }),
    ]);
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
    const workerCount = workerThreads.workers.length;
    await (store as any).runRefresh("codex");

    expect(core.saveCachedSessions).not.toHaveBeenCalled();
    expect(workerThreads.workers).toHaveLength(workerCount);
    expect(events).toEqual([
      expect.objectContaining({
        newSessions: 0,
        updatedSessions: 0,
        removedSessions: 1,
        totalSessions: 0,
        changedSessionHeads: [],
        removedSessionRefs: [{ agentName: "codex", sessionId: "session" }],
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
      piRoot: join(tempDir, "pi"),
      zcodeRoot: join(tempDir, "zcode"),
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
    expect(fsWatch.watchers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: sessionsDir,
          options: { recursive: true },
        }),
        expect.objectContaining({
          path: codexRoot,
          options: { recursive: true },
        }),
      ]),
    );
    const sessionsWatcher = fsWatch.watchers.find((watcher) => watcher.path === sessionsDir);
    expect(sessionsWatcher).toBeDefined();

    writeFileSync(sessionFile, "partial");
    sessionsWatcher!.listener("change", "new.jsonl");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);

    appendFileSync(sessionFile, "\ncomplete");
    sessionsWatcher!.listener("change", "new.jsonl");
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
      piRoot: join(tempDir, "pi"),
      zcodeRoot: join(tempDir, "zcode"),
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
      piRoot: join(tempDir, "pi"),
      zcodeRoot: join(tempDir, "zcode"),
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
        changedSessionHeads: [
          { agentName: "codex", session: expect.objectContaining({ id: "codex-new" }) },
          { agentName: "kimi", session: expect.objectContaining({ id: "kimi-new" }) },
        ],
        removedSessionRefs: [],
      }),
    ]);
  });

  it("coalesces refresh schedules for the same agent into a single run", async () => {
    vi.useFakeTimers();
    const existing = makeSession("existing");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["fresh"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existing, makeSession("fresh")]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    // Three schedule calls arrive within the debounce window; scheduleRefresh
    // throttles (keeps the earliest deadline) rather than debouncing, so the
    // later calls are no-ops and the run fires 200ms after the first call.
    (store as any).scheduleRefresh("codex");
    await vi.advanceTimersByTimeAsync(50);
    (store as any).scheduleRefresh("codex");
    await vi.advanceTimersByTimeAsync(50);
    (store as any).scheduleRefresh("codex");
    await vi.advanceTimersByTimeAsync(99);
    expect(codex.checkForChanges).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(codex.checkForChanges).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(codex.checkForChanges).toHaveBeenCalledTimes(1);
  });

  it("backs off the refresh delay after a slow scan to reduce scan duty cycle", async () => {
    vi.useFakeTimers();
    const existing = makeSession("existing");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["fresh"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existing, makeSession("fresh")]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    // Simulate a preceding scan that took 5s: the next refresh should be
    // delayed to ~4x that cost, well beyond the 200ms debounce floor.
    (store as any).getRefreshState("codex").lastRefreshDurationMs = 5_000;
    (store as any).scheduleRefresh("codex");

    await vi.advanceTimersByTimeAsync(19_999);
    expect(codex.checkForChanges).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(codex.checkForChanges).toHaveBeenCalledTimes(1);
  });

  it("still fires on a steady stream of events instead of being starved by the adaptive backoff", async () => {
    vi.useFakeTimers();
    const existing = makeSession("existing");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["fresh"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existing, makeSession("fresh")]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    (store as any).getRefreshState("codex").lastRefreshDurationMs = 5_000;

    // Writes every 3s never leave a 20s quiet gap. A plain debounce (reset on
    // every call) would push the deadline out forever; throttling on the
    // earliest deadline guarantees a refresh still fires around the 20s mark.
    for (let elapsed = 0; elapsed < 21_000; elapsed += 3_000) {
      (store as any).scheduleRefresh("codex");
      await vi.advanceTimersByTimeAsync(3_000);
    }

    expect(codex.checkForChanges).toHaveBeenCalledTimes(1);
  });

  it("uses the slower empty-agent debounce when the agent has no known sessions", async () => {
    vi.useFakeTimers();
    // An agent with zero cached sessions has no baseline to run
    // checkForChanges against, so a scheduled refresh falls through to a
    // full worker scan instead.
    const codex = makeAgent("codex", {
      scan: vi.fn(() => []),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [],
      byAgent: { codex: [] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    (store as any).scheduleRefresh("codex", 30_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(codex.scan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(29_800);
    expect(codex.scan).toHaveBeenCalledTimes(1);
  });

  it("queues a refresh requested while one is in flight and runs it after completion", async () => {
    vi.useFakeTimers();
    const existing = makeSession("existing");
    let resolveCheck: ((result: { hasChanges: boolean; timestamp: number }) => void) | null = null;
    const checkForChanges = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCheck = resolve;
          }),
      )
      .mockImplementationOnce(() => ({ hasChanges: false, timestamp: 4000 }));
    const codex = makeAgent("codex", {
      checkForChanges,
      incrementalScan: vi.fn(() => [existing, makeSession("fresh")]),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    const firstRefresh = (store as any).refreshAgent("codex");
    await Promise.resolve();
    expect(checkForChanges).toHaveBeenCalledTimes(1);

    // A second refresh request arrives while the first is still in flight;
    // it must be deferred rather than run concurrently.
    const secondRefresh = (store as any).refreshAgent("codex");
    await Promise.resolve();
    expect(checkForChanges).toHaveBeenCalledTimes(1);

    resolveCheck!({ hasChanges: true, timestamp: 3500 });
    await firstRefresh;
    await secondRefresh;
    expect(checkForChanges).toHaveBeenCalledTimes(1);

    // The deferred run is scheduled after a short delay, not run inline.
    await vi.advanceTimersByTimeAsync(99);
    expect(checkForChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(checkForChanges).toHaveBeenCalledTimes(2);
  });

  it("clears pending refresh timers on shutdown so no refresh runs afterward", async () => {
    vi.useFakeTimers();
    const existing = makeSession("existing");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({ hasChanges: false, timestamp: 3000 })),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();

    (store as any).scheduleRefresh("codex");
    await store.shutdown();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(codex.checkForChanges).not.toHaveBeenCalled();
  });

  it("terminates an active scan worker before shutdown completes", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const existing = makeSession("existing");
    const codex = makeFileSystemAgent("codex");
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    core.isAgentCacheInitialized.mockReturnValue(false);
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore(false);
    await store.initialize();
    const listener = vi.fn();
    store.subscribe(listener);
    const refresh = (store as any).refreshAgent("codex");
    await vi.waitFor(() =>
      expect(workerThreads.workers.some((worker) => worker.workerData.agentName)).toBe(true),
    );
    const worker = workerThreads.workers.find((item) => item.workerData.agentName)!;

    await store.shutdown();

    expect(warn).toHaveBeenCalledWith("scan.shutdown.active_operations", {
      agent_operations: 1,
      refreshes: 1,
      backfill_running: undefined,
      scan_workers: 1,
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await refresh;
    expect(store.getSnapshot().sessions).toEqual([existing]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not start a pending search-index batch while shutting down", async () => {
    core.createRegisteredAgents.mockReturnValue([]);
    core.scanSessions.mockResolvedValue({ sessions: [], byAgent: {}, agents: [] });

    const store = new LiveScanStore(false);
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
    };

    const current = (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);
    const pending = (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);
    const outcomes = Promise.allSettled([current, pending]);
    expect(workerThreads.workers.filter((worker) => worker.workerData.jobs)).toHaveLength(1);

    await store.shutdown();

    expect(workerThreads.workers.filter((worker) => worker.workerData.jobs)).toHaveLength(1);
    expect(await outcomes).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
      expect.objectContaining({ status: "rejected", reason: expect.any(Error) }),
    ]);
    expect((store as any).pendingSearchIndexJobs.batchCount).toBe(0);
    expect((store as any).searchIndexWorker).toBeNull();
  });

  it("coalesces pending search-index changes to the latest session state", async () => {
    core.createRegisteredAgents.mockReturnValue([]);
    core.scanSessions.mockResolvedValue({ sessions: [], byAgent: {}, agents: [] });

    const store = new LiveScanStore(false, {}, {}, { deferInitialRefresh: true });
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const active = (store as any).enqueueSearchIndexJobs("scan.refresh", [
      {
        kind: "full",
        context: "scan.refresh",
        agentName: "codex",
        sessions: [],
        meta: {},
      },
    ]);
    const pending = [1, 2, 3].map((version) =>
      (store as any).enqueueSearchIndexJobs("scan.refresh", [
        {
          kind: "changes",
          context: "scan.refresh",
          agentName: "codex",
          changes: [
            {
              session: makeSession("active", { title: `version ${version}` }),
              sortIndex: 0,
            },
          ],
          removedSessionIds: [],
          meta: {},
        },
      ]),
    );
    const outcomes = Promise.allSettled([active, ...pending]);

    const activeWorker = workerThreads.workers.find((worker) => worker.workerData.jobs)!;
    activeWorker.emitDone();

    const searchIndexWorkers = workerThreads.workers.filter((worker) => worker.workerData.jobs);
    expect(searchIndexWorkers).toHaveLength(2);
    expect(searchIndexWorkers[1]?.workerData.jobs).toEqual([
      expect.objectContaining({
        kind: "changes",
        changes: [
          expect.objectContaining({
            session: expect.objectContaining({ id: "active", title: "version 3" }),
          }),
        ],
      }),
    ]);

    searchIndexWorkers[1]!.emitDone();
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("makes repeated shutdown calls share one worker termination", async () => {
    core.createRegisteredAgents.mockReturnValue([]);
    core.scanSessions.mockResolvedValue({ sessions: [], byAgent: {}, agents: [] });

    const store = new LiveScanStore(false);
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
    };
    const batch = (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);
    const outcome = batch.catch((error: Error) => error);
    const worker = workerThreads.workers.at(-1)!;

    await Promise.all([store.shutdown(), store.shutdown()]);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(await outcome).toBeInstanceOf(Error);
    await expect((store as any).enqueueSearchIndexJobs("scan.refresh", [job])).rejects.toThrow(
      "Live scan store shut down",
    );
  });

  it("settles a worker error once when shutdown follows", async () => {
    core.createRegisteredAgents.mockReturnValue([]);
    core.scanSessions.mockResolvedValue({ sessions: [], byAgent: {}, agents: [] });

    const store = new LiveScanStore(false);
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
    };
    const batch = (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);
    const outcome = Promise.allSettled([batch]);
    const worker = workerThreads.workers.at(-1)!;

    worker.emitError(new Error("index failed"));
    await store.shutdown();

    expect(await outcome).toEqual([
      expect.objectContaining({ status: "rejected", reason: new Error("index failed") }),
    ]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(workerThreads.workers.filter((item) => item.workerData.jobs)).toHaveLength(1);
  });

  it("skips the FTS integrity check on search-index batches after the first one completes", async () => {
    core.createRegisteredAgents.mockReturnValue([]);
    core.scanSessions.mockResolvedValue({ sessions: [], byAgent: {}, agents: [] });

    const store = new LiveScanStore(false);
    await store.initialize();

    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
    };
    await (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);
    await (store as any).enqueueSearchIndexJobs("scan.refresh", [job]);

    const searchIndexWorkers = workerThreads.workers.filter((worker) => worker.workerData.jobs);
    expect(searchIndexWorkers).toHaveLength(2);
    expect(searchIndexWorkers[0]?.workerData.skipFtsIntegrityCheck).toBe(false);
    expect(searchIndexWorkers[1]?.workerData.skipFtsIntegrityCheck).toBe(true);
  });
});

describe("resolveAgentWatchTargets", () => {
  it("resolves cursor, OpenCode, and ZCode watch targets", () => {
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
    expect(resolveAgentWatchTargets("zcode")).toEqual([
      { root: "/tmp/zcode", path: join("/tmp/zcode", "cli", "db", "db.sqlite") },
    ]);
    core.resolveProviderRoots.mockReturnValue({
      claudeRoot: "/tmp/claude",
      codexRoot: "/tmp/codex",
      kimiRoot: "/tmp/kimi",
      opencodeRoot: "/tmp/opencode",
      piRoot: "/tmp/pi",
      zcodeRoot: null,
    });
    expect(resolveAgentWatchTargets("zcode")).toEqual([]);
    expect(resolveAgentWatchTargets("unknown")).toEqual([]);
  });
});
