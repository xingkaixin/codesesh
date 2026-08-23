import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachMissingProjectIdentities,
  FileSystemSessionSource,
  type AgentScanOptions,
  type IdentifiedSessionHead,
  type AgentRoots,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionDetail,
  type SessionHead,
  type SessionSourceRef,
} from "@codesesh/core/runtime";
import { createSessionIdentity, toPublicSessionHead } from "@codesesh/core/contract";
import { AgentUnavailableDuringScanError } from "./scan-refresh-error.js";
import { buildScanRefreshDelta } from "./scan-refresh-delta.js";

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

const core = vi.hoisted(() => {
  const cachedSessions = vi.fn();
  return {
    readCachedSessions: vi.fn((agentName: string) => ({
      status: "success" as const,
      value: cachedSessions(agentName),
    })),
    closeCacheStorage: vi.fn(),
    createRegisteredAgents: vi.fn(),
    filterSessions: vi.fn((sessions: SessionHead[], _options: ScanOptions) => sessions),
    getAgentFullSyncCursor: vi.fn(() => null as string | null),
    getAgentLastFullSyncAt: vi.fn(),
    readAgentCacheInitialization: vi.fn(),
    readAgentLastFullSyncAt: vi.fn(),
    resolveAgentRoots: vi.fn((): AgentRoots => ({
      claudecode: "/tmp/claude",
      codex: "/tmp/codex",
      cursor: "/tmp/cursor",
      kimi: "/tmp/kimi",
      opencode: "/tmp/opencode",
      pi: "/tmp/pi",
      zcode: "/tmp/zcode",
    })),
    isAgentCacheInitialized: vi.fn(),
    cachedSessions,
    markAgentCacheInitialized: vi.fn(),
    markAgentFullSyncProgress: vi.fn(() => true),
    markAgentFullSyncStarted: vi.fn(() => true),
    markAgentFullSyncCompleted: vi.fn(() => true),
    scanSessions: vi.fn(),
    saveCachedSessions: vi.fn(),
    saveCachedSessionChanges: vi.fn(),
    syncSessionSearchIndex: vi.fn(),
    syncSessionSearchIndexChanges: vi.fn(),
  };
});

const workerThreads = vi.hoisted(() => ({
  deferSearchIndexWorkers: false,
  deferScanRefreshWorkers: false,
  workers: [] as Array<{
    url: URL;
    workerData: any;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    emitMessage: (message: unknown) => void;
    emitDone: () => void;
    emitError: (error: Error) => void;
    emitExit: (code: number) => void;
  }>,
  Worker: vi.fn(function (this: unknown, url: URL, options?: { workerData?: unknown }) {
    const workerData = (options?.workerData ?? {}) as any;
    const isSearchWorker = Boolean(workerData.jobs);
    const isScanWorker = Boolean(workerData.agentName);
    const deferMessages =
      (isSearchWorker && workerThreads.deferSearchIndexWorkers) ||
      (isScanWorker && workerThreads.deferScanRefreshWorkers);
    const messageHandlers: Array<(message: unknown) => void> = [];
    const exitHandlers: Array<(code: number) => void> = [];
    const errorHandlers: Array<(error: Error) => void> = [];
    let scanBaseline = isScanWorker
      ? {
          sessions: workerData.previousSessions ?? [],
          meta: workerData.meta ?? {},
          generation: workerData.generation ?? 0,
        }
      : null;
    let stagedScanBaseline: {
      requestId: number;
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      generation: number;
    } | null = null;
    let scanAgent: any;
    const dispatch = (data: any) => {
      queueMicrotask(() => {
        if (data?.type === "commit") {
          const staged = stagedScanBaseline;
          if (
            scanBaseline &&
            staged &&
            staged.requestId === data.requestId &&
            staged.generation === data.generation &&
            scanBaseline.generation === data.generation
          ) {
            scanBaseline = {
              sessions: staged.sessions,
              meta: staged.meta,
              generation: data.generation + 1,
            };
            stagedScanBaseline = null;
          }
          return;
        }
        for (const handler of messageHandlers) {
          try {
            if (data?.agentName) {
              if (!scanBaseline || scanBaseline.generation !== (data.generation ?? 0)) {
                throw new Error("worker generation mismatch");
              }
              if (stagedScanBaseline) throw new Error("worker result is awaiting commit");
              const runData = {
                ...data,
                previousSessions: data.previousSessions ?? scanBaseline.sessions,
                meta: data.meta ?? scanBaseline.meta,
              };
              const agent = (scanAgent ??= core
                .createRegisteredAgents()
                .find((item: any) => item.name === runData.agentName));
              agent?.restoreSessionCacheMeta?.(runData.meta);
              let sessions: SessionHead[] = [];
              let changedIds: string[] | undefined;
              let sourceFailures = [];
              let explicitRemovedSessionIds: string[] = [];
              if (agent?.isAvailable?.() !== false) {
                if (runData.operation?.kind === "recompute-derived") {
                  sessions = runData.previousSessions;
                } else if (agent?.sessionSourceAccess?.kind === "enumerated") {
                  const result = agent.sessionSourceAccess.synchronize(
                    { sessions: runData.previousSessions, meta: runData.meta },
                    {
                      kind: runData.operation?.kind === "full-scan" ? "reload" : "refresh",
                      scanOptions: runData.scanOptions,
                    },
                  );
                  sessions = result.sessions;
                  changedIds = result.changedSessionIds;
                  sourceFailures = result.sourceFailures;
                  explicitRemovedSessionIds = result.explicitRemovedSessionIds;
                } else {
                  sessions = agent?.scan?.({
                    ...runData.scanOptions,
                    onProgress: () => undefined,
                  });
                }
              }
              const sessionIds = new Set(sessions.map((session) => session.reference.sessionId));
              const nextMeta = agent?.snapshotSessionCacheMeta?.(sessionIds) ?? {};
              const completeness =
                runData.scanOptions?.from == null &&
                runData.scanOptions?.to == null &&
                sourceFailures.length === 0
                  ? "complete"
                  : "partial";
              const delta = buildScanRefreshDelta({
                previousSessions: runData.previousSessions,
                sessions,
                previousMeta: runData.meta,
                nextMeta,
                changedIds,
                completeness,
                explicitRemovedSessionIds,
              });
              stagedScanBaseline = {
                requestId: runData.requestId,
                sessions,
                meta: nextMeta,
                generation: runData.generation ?? 0,
              };
              handler({
                type: "done",
                requestId: runData.requestId,
                generation: runData.generation ?? 0,
                ...delta,
                sourceFailures,
                completeness,
                explicitRemovedSessionIds,
                durationMs: 0,
              });
              continue;
            }
          } catch (error) {
            handler({
              type: "error",
              requestId: data.requestId,
              generation: data.generation ?? 0,
              error: error instanceof Error ? error.message : String(error),
              durationMs: 0,
            });
            continue;
          }
          const jobs = data?.jobs ?? [];
          handler({
            type: "done",
            context: data?.context ?? "",
            durationMs: 0,
            sessions: jobs.length,
            failedAgents: [],
          });
        }
      });
    };
    const worker = {
      url,
      workerData,
      on: vi.fn((event: string, handler: (message: unknown) => void) => {
        if (event === "message") {
          messageHandlers.push(handler);
          if (!deferMessages) dispatch(workerData);
        }
        if (event === "exit") {
          exitHandlers.push(handler);
          if (isSearchWorker && !workerThreads.deferSearchIndexWorkers) {
            queueMicrotask(() => handler(0));
          }
        }
        if (event === "error") errorHandlers.push(handler as (error: Error) => void);
        return worker;
      }),
      once: vi.fn((event: string, handler: (message: unknown) => void) => {
        if (event === "exit") {
          exitHandlers.push(handler);
          if (isSearchWorker && !workerThreads.deferSearchIndexWorkers) {
            queueMicrotask(() => handler(0));
          }
        }
        return worker;
      }),
      postMessage: vi.fn((data: unknown) => {
        if (!workerThreads.deferScanRefreshWorkers) dispatch(data);
      }),
      terminate: vi.fn(async () => {
        for (const handler of exitHandlers) handler(0);
      }),
      emitMessage: (message: unknown) => {
        for (const handler of messageHandlers) handler(message);
      },
      emitDone: () => {
        for (const handler of messageHandlers) {
          handler({
            type: "done",
            context: workerData?.context ?? "",
            durationMs: 0,
            sessions: workerData?.jobs?.length ?? 0,
            failedAgents: [],
          });
        }
        for (const handler of exitHandlers) handler(0);
      },
      emitError: (error: Error) => {
        for (const handler of errorHandlers) handler(error);
      },
      emitExit: (code: number) => {
        for (const handler of exitHandlers) handler(code);
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

vi.mock("@codesesh/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime")>();
  return {
    ...actual,
    closeCacheStorage: core.closeCacheStorage,
    createRegisteredAgents: core.createRegisteredAgents,
    filterSessions: core.filterSessions,
    getAgentFullSyncCursor: core.getAgentFullSyncCursor,
    getAgentLastFullSyncAt: core.getAgentLastFullSyncAt,
    isAgentCacheInitialized: core.isAgentCacheInitialized,
    readAgentCacheInitialization: core.readAgentCacheInitialization,
    readAgentLastFullSyncAt: core.readAgentLastFullSyncAt,
    readCachedSessions: core.readCachedSessions,
    markAgentCacheInitialized: core.markAgentCacheInitialized,
    markAgentFullSyncProgress: core.markAgentFullSyncProgress,
    markAgentFullSyncStarted: core.markAgentFullSyncStarted,
    markAgentFullSyncCompleted: core.markAgentFullSyncCompleted,
    resolveAgentRoots: core.resolveAgentRoots,
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

import { LiveScanStore, type SessionsUpdatedEvent } from "./live-scan.js";
import { appLogger } from "./logging.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import { ThreadWorkerRunner } from "./worker-runner.js";

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

function makeSession(id: string, overrides: Partial<SessionHead> = {}): IdentifiedSessionHead {
  const identity = createSessionIdentity(
    overrides.reference ?? { agentName: "codex", sessionId: id },
  );
  const session: SessionHead = {
    ...identity,
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
    ...identity,
  };
  return attachMissingProjectIdentities([session])[0]!;
}

const projectIdentity = {
  kind: "path" as const,
  key: FIXTURE_DIR,
  displayName: FIXTURE_DIR_NAME,
};

function watchPlanFor(name: string) {
  const roots = core.resolveAgentRoots();
  return {
    status: "supported" as const,
    targets:
      name === "codex"
        ? [
            { path: join(roots.codex!, "sessions") },
            { path: join(roots.codex!, "session_index.jsonl") },
          ]
        : [],
  };
}

function makeAgent(name: string, overrides: Record<string, unknown> = {}) {
  const agent: Record<string, unknown> = {
    name,
    displayName: name,
    isAvailable: vi.fn(() => true),
    getSessionData: vi.fn(() => ({
      reference: { agentName: name, sessionId: "session" },
      title: "session",
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
    getSessionWatchPlan: vi.fn(() => watchPlanFor(name)),
    getSessionCacheMeta: vi.fn(),
    snapshotSessionCacheMeta: vi.fn(() => ({
      session: { id: "session", sourcePath: "/tmp/s" },
    })),
    restoreSessionCacheMeta: vi.fn(),
    removeSessionCacheMeta: vi.fn(),
    // Database-style agents detect changes via checkForChanges and rescan via
    // incrementalScan (which delegates to scan), mirroring DatabaseSessionSource.
    checkForChanges: vi.fn(() => ({ hasChanges: true, changedIds: [], timestamp: 0 })),
    commitChangeCheck: vi.fn(),
    incrementalScan: vi.fn(() => (agent.scan as () => SessionHead[])()),
  };
  agent.scan = vi.fn(() => []);
  Object.assign(agent, overrides);
  agent.sessionSourceAccess ??= {
    kind: "aggregate",
    checkForChanges: (...args: unknown[]) =>
      (agent.checkForChanges as (...values: unknown[]) => unknown)(...args),
    commitChangeCheck: () => (agent.commitChangeCheck as () => void)(),
    incrementalScan: (...args: unknown[]) =>
      (agent.incrementalScan as (...values: unknown[]) => unknown)(...args),
  };
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
    getSessionCacheMeta?: (sessionId: string) => SessionCacheMeta | undefined;
    snapshotSessionCacheMeta?: () => Record<string, SessionCacheMeta>;
    restoreSessionCacheMeta?: (meta: Readonly<Record<string, SessionCacheMeta>>) => void;
    removeSessionCacheMeta?: (sessionIds: Iterable<string>) => void;
  } = {},
) {
  const agent = Object.create(FileSystemSessionSource.prototype) as InstanceType<
    typeof FileSystemSessionSource
  >;
  Object.defineProperty(agent, "sessionMetaMap", { value: new Map(), writable: true });
  Object.defineProperty(agent, "name", { value: name, configurable: true });
  Object.defineProperty(agent, "displayName", { value: name, configurable: true });
  agent.isAvailable = vi.fn(() => true);
  agent.scan = vi.fn(() => []);
  agent.getSessionData = vi.fn(() => ({}) as SessionDetail);
  agent.getSessionWatchPlan = vi.fn(() => watchPlanFor(name));
  agent.listSessionSources = overrides.listSessionSources ?? vi.fn(() => []);
  agent.scanSessionSource = overrides.scanSessionSource ?? vi.fn(() => null);
  agent.getSessionCacheMeta = overrides.getSessionCacheMeta ?? vi.fn();
  agent.snapshotSessionCacheMeta = overrides.snapshotSessionCacheMeta ?? vi.fn(() => ({}));
  agent.restoreSessionCacheMeta = overrides.restoreSessionCacheMeta ?? vi.fn();
  agent.removeSessionCacheMeta = overrides.removeSessionCacheMeta ?? vi.fn();
  Object.defineProperty(agent, "sessionSourceAccess", {
    value: {
      kind: "enumerated",
      synchronize: (...args: Parameters<typeof agent.synchronizeSessionSources>) =>
        agent.synchronizeSessionSources(...args),
      count: (options?: AgentScanOptions) => agent.listSessionSources(options).length,
    },
    configurable: true,
  });
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
    core.getAgentLastFullSyncAt.mockReturnValue(Date.now());
    core.isAgentCacheInitialized.mockReturnValue(true);
    core.readAgentCacheInitialization.mockImplementation(() => ({
      status: "success",
      value: core.isAgentCacheInitialized(),
    }));
    core.readAgentLastFullSyncAt.mockImplementation(() => ({
      status: "success",
      value: core.getAgentLastFullSyncAt(),
    }));
    core.cachedSessions.mockReturnValue(null);
    core.markAgentCacheInitialized.mockReset();
    core.markAgentFullSyncStarted.mockReset();
    core.resolveAgentRoots.mockReturnValue({
      claudecode: "/tmp/claude",
      codex: "/tmp/codex",
      cursor: "/tmp/cursor",
      kimi: "/tmp/kimi",
      opencode: "/tmp/opencode",
      pi: "/tmp/pi",
      zcode: "/tmp/zcode",
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

    const store = new LiveScanStore({
      watchEnabled: false,
      scanOptions: { agents: ["codex", "kimi"] },
    });
    await store.initialize();

    const snapshot = store.getSnapshot();
    expect(core.scanSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ["codex", "kimi"],
        useCache: true,
        writeCache: undefined,
        includeSmartTags: undefined,
      }),
    );
    expect(snapshot.agents.map((agent) => agent.name)).toEqual(["codex", "kimi"]);
    expect(snapshot.byAgent.codex!.map((session) => session.reference.sessionId)).toEqual([
      "newer",
      "older",
    ]);
    expect(snapshot.byAgent.kimi).toEqual([]);
    expect(snapshot.sessions.map((session) => session.reference.sessionId)).toEqual([
      "newer",
      "older",
    ]);
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

  it("serves initial memory results while preserving cache failure diagnostics", async () => {
    const codex = makeAgent("codex");
    const fresh = makeSession("fresh", { time_updated: 2_000 });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [fresh],
      byAgent: { codex: [fresh] },
      agents: [codex],
      cacheFailures: { codex: { agentName: "codex", operation: "write" } },
    });

    const store = new LiveScanStore({ watchEnabled: false });
    await store.initialize();

    expect(store.getSnapshot().sessions).toEqual([fresh]);
    expect(store.getSnapshot().cacheFailures).toEqual({
      codex: { agentName: "codex", operation: "write" },
    });
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

    const store = new LiveScanStore({ watchEnabled: false, deferInitialRefresh: true });
    const events: unknown[] = [];
    const statusEvents: unknown[] = [];
    store.subscribe((event) => events.push(event));
    store.subscribeScanStatus((event) => statusEvents.push(event));

    await store.initialize();

    expect(core.scanSessions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        useCache: true,
        cacheOnly: true,
        writeCache: false,
        includeSmartTags: false,
      }),
    );
    expect(workerThreads.workers).toHaveLength(0);
    expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
      "cached",
    ]);

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
    expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
      "fresh",
    ]);
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
      restoreSessionCacheMeta: vi.fn(),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [recent],
      byAgent: { codex: [recent] },
      agents: [codex],
      cacheTimestamps: { codex: 1000 },
    });
    core.cachedSessions.mockReturnValue({
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

    const store = new LiveScanStore({
      watchEnabled: false,
      startupScanOptions: { from: 3000 },
      deferInitialRefresh: true,
    });
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).toHaveBeenCalledWith(1000, [old, recent]);
    expect(codex.restoreSessionCacheMeta).toHaveBeenCalledWith({
      old: { id: "old", sourcePath: "/tmp/old" },
      recent: { id: "recent", sourcePath: "/tmp/recent" },
    });
    expect(codex.scan).not.toHaveBeenCalled();
    expect(codex.incrementalScan).not.toHaveBeenCalled();
    expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
      "recent",
    ]);
    expect(workerThreads.workers).toHaveLength(1);
    expect(workerThreads.workers[0]?.workerData).toMatchObject({
      operation: { kind: "recompute-derived" },
    });
  });

  it("publishes the startup window before backfilling a database agent", async () => {
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
    core.isAgentCacheInitialized.mockReturnValue(false);
    core.getAgentLastFullSyncAt.mockReturnValue(null);
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

    const store = new LiveScanStore({
      watchEnabled: false,
      startupScanOptions: { from: 3000 },
      deferInitialRefresh: true,
    });
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(core.cachedSessions).toHaveBeenCalledWith("codex");
    expect(codex.scan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        from: 3000,
        onProgress: expect.any(Function),
      }),
    );
    expect((codex.scan as ReturnType<typeof vi.fn>).mock.calls[1]?.[0]?.from).toBeUndefined();
    await vi.waitFor(() =>
      expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
        "recent",
        "old",
      ]),
    );
    const backfillJob = workerThreads.workers.filter((worker) => worker.workerData.jobs).at(-1)
      ?.workerData.jobs;
    expect(backfillJob).toEqual([
      expect.objectContaining({
        kind: "full",
        context: "scan.backfill",
        agentName: "codex",
        sessions: [
          { ...old, project_identity: projectIdentity },
          { ...recent, project_identity: projectIdentity },
        ],
        saveCache: true,
      }),
    ]);
    const scanWorkers = workerThreads.workers.filter(
      (worker) => worker.workerData.agentName === "codex",
    );
    expect(scanWorkers).toHaveLength(1);
    const reusedRunRequests = scanWorkers[0]!.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.type === "run");
    expect(reusedRunRequests).toHaveLength(1);
    expect(reusedRunRequests[0]).not.toHaveProperty("previousSessions");
    expect(reusedRunRequests[0]).not.toHaveProperty("meta");
    expect(JSON.stringify(reusedRunRequests[0]).length).toBeLessThan(512);
    expect(core.markAgentFullSyncStarted).toHaveBeenCalledWith("codex");
  });

  it("does not infer cache truncation from raw source and session counts", async () => {
    const cached = makeSession("cached");
    const codex = makeFileSystemAgent("codex", {
      listSessionSources: vi.fn(() =>
        ["cached", "missing-1", "missing-2"].map((sessionId) => ({
          sessionId,
          sourcePath: `/tmp/${sessionId}`,
          fingerprint: sessionId,
        })),
      ),
    });
    core.getAgentLastFullSyncAt.mockReturnValue(Date.now());
    core.cachedSessions.mockReturnValue({
      sessions: [cached],
      meta: {},
      timestamp: Date.now(),
    });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [cached],
      byAgent: { codex: [cached] },
      agents: [codex],
    });

    const store = new LiveScanStore({
      watchEnabled: false,
      startupScanOptions: { from: 3000 },
      deferInitialRefresh: true,
    });
    await store.initialize();

    store.startBackgroundRefresh();

    await vi.waitFor(() => expect(store.getScanStatus().active).toBe(false));
    expect(core.markAgentFullSyncStarted).not.toHaveBeenCalled();
  });

  it("rejects a scan worker that exits successfully before sending done", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const agent = makeFileSystemAgent("codex");
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const refresh = runner.run(agent.name, {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const worker = workerThreads.workers.at(-1)!;
    worker.emitExit(0);

    await expect(refresh).rejects.toThrow("exited before completing (code 0)");
    expect(warn).toHaveBeenCalledWith("scan.refresh_worker.exit_before_done", {
      agent: "codex",
      code: 0,
    });

    workerThreads.deferScanRefreshWorkers = false;
    const retry = await runner.run(agent.name, {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    expect(retry.result).toEqual({
      sessions: [],
      meta: {},
      changedIds: [],
      sourceFailures: [],
      completeness: "complete",
      explicitRemovedSessionIds: [],
    });
    retry.commit();
  });

  it("rehydrates an unavailable-agent error from the scan worker", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));
    const refresh = runner.run("codex", {
      previousSessions: [makeSession("retained")],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const worker = workerThreads.workers.at(-1)!;

    worker.emitMessage({
      type: "error",
      requestId: worker.workerData.requestId,
      generation: worker.workerData.generation,
      error: "Agent codex became unavailable during scan",
      errorCode: "agent-unavailable-during-scan",
      durationMs: 0,
    });

    await expect(refresh).rejects.toBeInstanceOf(AgentUnavailableDuringScanError);
    expect(runner.activeCount).toBe(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await runner.shutdown();
    workerThreads.deferScanRefreshWorkers = false;
  });

  it("consumes scan worker logs without settling the active request", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const consumeWorkerMessage = vi
      .spyOn(appLogger, "consumeWorkerMessage")
      .mockImplementation((message) =>
        Boolean(message && typeof message === "object" && "event" in message),
      );
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));
    const refresh = runner.run("codex", {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const worker = workerThreads.workers.at(-1)!;
    const logMessage = { type: "codesesh.worker-log", event: "scan.worker" };

    worker.emitMessage(logMessage);

    expect(consumeWorkerMessage).toHaveBeenCalledWith(logMessage);
    expect(runner.activeCount).toBe(1);

    worker.emitMessage({
      type: "done",
      requestId: worker.workerData.requestId,
      generation: worker.workerData.generation,
      changes: [],
      removedSessionIds: [],
      meta: {},
      removedMetaIds: [],
      sourceFailures: [],
      completeness: "complete",
      explicitRemovedSessionIds: [],
      durationMs: 0,
    });

    const run = await refresh;
    expect(run.result).toEqual({
      sessions: [],
      meta: {},
      changedIds: [],
      sourceFailures: [],
      completeness: "complete",
      explicitRemovedSessionIds: [],
    });
    run.commit();
    await runner.shutdown();
  });

  it("rejects a scan worker request when its checkpoint cannot commit", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const agent = makeFileSystemAgent("codex");
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const refresh = runner.run(agent.name, {
      previousSessions: [],
      operation: { kind: "full-scan", checkpoint: "durable" },
      scanOptions: {},
      meta: {},
      onCheckpoint: () => {
        throw new Error("checkpoint rejected");
      },
    });
    const worker = workerThreads.workers.at(-1)!;
    worker.emitMessage({
      type: "checkpoint",
      requestId: worker.workerData.requestId,
      generation: worker.workerData.generation,
      checkpoint: { stage: "scanned", sessions: [], meta: {}, completeness: "complete" },
    });

    await expect(refresh).rejects.toThrow("checkpoint rejected");
    expect(runner.activeCount).toBe(0);
    await runner.shutdown();
    workerThreads.deferScanRefreshWorkers = false;
  });

  it("reconstructs an ordered snapshot from a scan worker delta", async () => {
    const removed = makeSession("removed");
    const retained = makeSession("retained");
    const added = makeSession("added", { time_updated: 2000 });
    let meta = new Map<string, SessionCacheMeta>();
    const agent = makeAgent("codex", {
      scan: vi.fn(() => {
        meta = new Map([
          ["added", { id: "added", sourcePath: "/added" }],
          ["retained", { id: "retained", sourcePath: "/retained" }],
        ]);
        return [added, retained];
      }),
      snapshotSessionCacheMeta: vi.fn(() => Object.fromEntries(meta)),
      restoreSessionCacheMeta: vi.fn((next: Readonly<Record<string, SessionCacheMeta>>) => {
        meta = new Map(Object.entries(next));
      }),
    });
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const run = await runner.run("codex", {
      previousSessions: [removed, retained],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {
        removed: { id: "removed", sourcePath: "/removed" },
        retained: { id: "retained", sourcePath: "/retained" },
      },
    });

    expect(run.result).toEqual({
      sessions: [added, retained],
      meta: {
        added: { id: "added", sourcePath: "/added" },
        retained: { id: "retained", sourcePath: "/retained" },
      },
      changedIds: ["added", "removed"],
      sourceFailures: [],
      completeness: "complete",
      explicitRemovedSessionIds: [],
    });
    expect(runner.activeCount).toBe(1);
    run.commit();
    expect(runner.activeCount).toBe(0);
    await runner.shutdown();
  });

  it("sends only operation fields after committing an Agent baseline", async () => {
    const session = makeSession("stateful");
    const agent = makeAgent("codex", { scan: vi.fn(() => [session]) });
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const first = await runner.run("codex", {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    await expect(
      runner.run("codex", {
        previousSessions: first.result.sessions,
        operation: { kind: "recompute-derived" },
        scanOptions: {},
        meta: first.result.meta,
      }),
    ).rejects.toThrow("Scan refresh worker for codex is busy");
    first.commit();
    const worker = workerThreads.workers.at(-1)!;

    const second = await runner.run("codex", {
      previousSessions: first.result.sessions,
      operation: { kind: "recompute-derived" },
      scanOptions: {},
      meta: first.result.meta,
    });
    const runRequest = worker.postMessage.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === "run");

    expect(runRequest).toMatchObject({
      type: "run",
      generation: 1,
      pricingGenerationId: expect.any(Number),
      operation: { kind: "recompute-derived" },
    });
    expect(runRequest).not.toHaveProperty("previousSessions");
    expect(runRequest).not.toHaveProperty("meta");
    expect(second.result.sessions).toEqual([session]);
    expect(core.createRegisteredAgents).toHaveBeenCalledTimes(1);

    second.commit();
    worker.emitExit(1);
    const replacement = await runner.run("codex", {
      previousSessions: second.result.sessions,
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: second.result.meta,
    });
    const replacementWorker = workerThreads.workers.at(-1)!;
    expect(replacementWorker).not.toBe(worker);
    expect(replacementWorker.workerData.previousSessions).toEqual(second.result.sessions);
    replacement.commit();
    await runner.shutdown();
  });

  it("discards an uncommitted result and restores from the next main-thread baseline", async () => {
    const lastKnownGood = makeSession("last-known-good");
    const candidate = makeSession("candidate");
    const agent = makeAgent("codex", { scan: vi.fn(() => [candidate]) });
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const candidateRun = await runner.run("codex", {
      previousSessions: [lastKnownGood],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const discardedWorker = workerThreads.workers.at(-1)!;
    candidateRun.discard();

    expect(discardedWorker.terminate).toHaveBeenCalledTimes(1);
    const replacementRun = await runner.run("codex", {
      previousSessions: [lastKnownGood],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const replacementWorker = workerThreads.workers.at(-1)!;
    expect(replacementWorker).not.toBe(discardedWorker);
    expect(replacementWorker.workerData.previousSessions).toEqual([lastKnownGood]);
    expect(replacementWorker.workerData.generation).toBe(0);

    replacementRun.commit();
    await runner.shutdown();
  });

  it("rejects a stale generation result and recreates the worker", async () => {
    workerThreads.deferScanRefreshWorkers = true;
    const agent = makeAgent("codex", { scan: vi.fn(() => []) });
    core.createRegisteredAgents.mockReturnValue([agent]);
    const runner = new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));

    const refresh = runner.run("codex", {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    const staleWorker = workerThreads.workers.at(-1)!;
    staleWorker.emitMessage({
      type: "done",
      requestId: staleWorker.workerData.requestId,
      generation: 1,
      changes: [],
      removedSessionIds: [],
      meta: {},
      removedMetaIds: [],
      sourceFailures: [],
      durationMs: 0,
    });

    await expect(refresh).rejects.toThrow(
      "Scan refresh generation mismatch: expected 0, received 1",
    );
    expect(staleWorker.terminate).toHaveBeenCalledTimes(1);

    workerThreads.deferScanRefreshWorkers = false;
    const replacementRun = await runner.run("codex", {
      previousSessions: [],
      operation: { kind: "full-scan" },
      scanOptions: {},
      meta: {},
    });
    expect(workerThreads.workers.at(-1)).not.toBe(staleWorker);
    replacementRun.commit();
    await runner.shutdown();
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
      restoreSessionCacheMeta: vi.fn(),
      snapshotSessionCacheMeta: vi.fn((sessionIds?: ReadonlySet<string>) =>
        Object.fromEntries(
          Object.entries({
            old: { id: "old", sourcePath: "/tmp/old" },
            recent: { id: "recent", sourcePath: "/tmp/recent" },
          }).filter(([sessionId]) => !sessionIds || sessionIds.has(sessionId)),
        ),
      ),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValueOnce({
      sessions: [recent],
      byAgent: { codex: [recent] },
      agents: [codex],
      cacheTimestamps: { codex: 1000 },
    });
    core.cachedSessions.mockReturnValue({
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

    const store = new LiveScanStore({
      watchEnabled: false,
      startupScanOptions: { from: 3000 },
      deferInitialRefresh: true,
    });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();

    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).toHaveBeenCalledWith(1000, [old, recent]);
    expect(codex.incrementalScan).toHaveBeenCalledWith([old, recent], ["old"], undefined, {
      from: 3000,
    });
    expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
      "recent",
      "old",
    ]);
    expect(events).toEqual([]);
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        publicationId: expect.stringMatching(/^scan\.refresh:codex:/),
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
      listSessionSources: vi.fn(() => [
        { sessionId: "session", sourcePath: "/tmp/s", fingerprint: "next" },
        { sessionId: "added", sourcePath: "/tmp/added", fingerprint: "new" },
      ]),
      scanSessionSource,
      snapshotSessionCacheMeta: vi.fn(() => ({
        session: { id: "session", sourcePath: "/tmp/s", sourceFingerprint: "next" },
        added: { id: "added", sourcePath: "/tmp/added", sourceFingerprint: "new" },
      })),
      restoreSessionCacheMeta: vi.fn(),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });
    core.cachedSessions.mockReturnValue({
      sessions: [previous],
      meta: {
        session: { id: "session", sourcePath: "/tmp/s", sourceFingerprint: "old" },
      },
      timestamp: 1000,
    });

    const store = new LiveScanStore({ watchEnabled: false });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(250);

    expect(scanSessionSource).toHaveBeenCalledTimes(2);
    expect(scanSessionSource).toHaveBeenCalledWith("/tmp/s", expect.any(Object));
    expect(scanSessionSource).toHaveBeenCalledWith("/tmp/added", expect.any(Object));
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        publicationId: expect.stringMatching(/^scan\.refresh:codex:/),
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

  it("rescans Codex cache entries when the fingerprint format changes", async () => {
    const previous = makeSession("session", { title: "same title", time_updated: 1000 });
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
    let meta: Record<string, SessionCacheMeta> = {
      session: {
        id: "session",
        sourcePath: "/tmp/s",
        sourceFingerprint: legacyFingerprint,
        sourceMtimeMs: 1234,
      },
    };
    const scanSessionSource = vi.fn(() => {
      meta = {
        session: {
          id: "session",
          sourcePath: "/tmp/s",
          sourceFingerprint: currentFingerprint,
          sourceMtimeMs: 1234,
        },
      };
      return makeSession("session", { title: "same title" });
    });
    const codex = makeFileSystemAgent("codex", {
      listSessionSources: vi.fn(() => [
        {
          sessionId: "session",
          sourcePath: "/tmp/s",
          fingerprint: currentFingerprint,
        },
      ]),
      scanSessionSource,
      snapshotSessionCacheMeta: vi.fn(() => meta),
      restoreSessionCacheMeta: vi.fn((next) => {
        meta = { ...next };
      }),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });
    core.cachedSessions.mockReturnValue({
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

    const store = new LiveScanStore({ watchEnabled: false });
    await store.initialize();
    const scanWorkerCountBeforeRefresh = workerThreads.workers.filter(
      (worker) => worker.workerData.agentName,
    ).length;
    store.startBackgroundRefresh();
    await vi.waitFor(() =>
      expect(workerThreads.workers.filter((worker) => worker.workerData.agentName)).toHaveLength(
        scanWorkerCountBeforeRefresh + 1,
      ),
    );
    await vi.waitFor(() => expect(scanSessionSource).toHaveBeenCalledOnce());

    expect(scanSessionSource).toHaveBeenCalledWith("/tmp/s", expect.any(Object));
    expect(
      workerThreads.workers.filter((worker) => worker.workerData.agentName).at(-1)?.workerData
        .agentName,
    ).toBe("codex");
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
      snapshotSessionCacheMeta: vi.fn((sessionIds?: ReadonlySet<string>) =>
        Object.fromEntries(
          Object.entries({
            session: { id: "session", sourcePath: "/tmp/s" },
            unrelated: { id: "unrelated", sourcePath: "/tmp/unrelated" },
          }).filter(([sessionId]) => !sessionIds || sessionIds.has(sessionId)),
        ),
      ),
    });

    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [previous],
      byAgent: { codex: [previous] },
      agents: [codex],
    });

    const store = new LiveScanStore({ watchEnabled: false });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(250);

    expect(codex.checkForChanges).toHaveBeenCalledWith(expect.any(Number), [previous]);
    expect(codex.incrementalScan).toHaveBeenCalledWith(
      previous ? [previous] : [],
      ["session", "added"],
      undefined,
      {},
    );
    expect(core.saveCachedSessions).not.toHaveBeenCalled();
    expect(core.saveCachedSessionChanges).not.toHaveBeenCalled();
    expect(core.syncSessionSearchIndex).not.toHaveBeenCalled();
    expect(core.syncSessionSearchIndexChanges).not.toHaveBeenCalled();
    expect(workerThreads.workers.at(-1)?.workerData.jobs).toEqual([
      {
        kind: "changes",
        context: "scan.refresh",
        agentName: "codex",
        publicationId: expect.stringMatching(/^scan\.refresh:codex:/),
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
          {
            reference: { agentName: "codex", sessionId: updatedWithProject.reference.sessionId },
            session: toPublicSessionHead(updatedWithProject),
          },
          {
            reference: { agentName: "codex", sessionId: addedWithProject.reference.sessionId },
            session: toPublicSessionHead(addedWithProject),
          },
        ],
        removedSessionRefs: [],
      }),
    ]);
    expect(store.getSnapshot().sessions.map((session) => session.reference.sessionId)).toEqual([
      "session",
      "added",
    ]);
  });

  it("keeps the previous snapshot private until the refresh index commits", async () => {
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

    const store = new LiveScanStore({ watchEnabled: false });
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const listener = vi.fn();
    store.subscribe(listener);

    store.startBackgroundRefresh();
    await vi.waitFor(() =>
      expect(
        workerThreads.workers.some(
          (worker) => worker.workerData.jobs?.[0]?.context === "scan.refresh",
        ),
      ).toBe(true),
    );
    const refreshWorker = workerThreads.workers.find(
      (worker) => worker.workerData.jobs?.[0]?.context === "scan.refresh",
    )!;

    expect(store.getSnapshot().sessions[0]?.title).toBe("old");
    expect(listener).not.toHaveBeenCalled();

    refreshWorker.emitDone();
    await vi.waitFor(() => expect(store.getSnapshot().sessions[0]?.title).toBe("new"));

    expect(store.getSnapshot().sessions[0]?.title).toBe("new");
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sessions-updated", updatedSessions: 1 }),
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

    const store = new LiveScanStore({ watchEnabled: false });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    store.startBackgroundRefresh();
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events).toEqual([
      expect.objectContaining({
        type: "sessions-updated",
        changedAgents: ["codex"],
        newSessions: 0,
        updatedSessions: 1,
        removedSessions: 0,
        changedSessionHeads: [
          {
            reference: { agentName: "codex", sessionId: previousWithProject.reference.sessionId },
            session: toPublicSessionHead(previousWithProject),
          },
        ],
        removedSessionRefs: [],
      }),
    ]);
  });

  // CS-138: an unreachable agent was never scanned, so an empty result proves
  // nothing. Publishing it would delete every session the agent ever had —
  // a moved database file or an unmounted share would wipe the history.
  it("keeps sessions when an agent becomes unavailable", async () => {
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

    const store = new LiveScanStore({ watchEnabled: false });
    const events: unknown[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    const workerCount = workerThreads.workers.length;
    store.startBackgroundRefresh();
    await vi.waitFor(() => expect(store.getScanStatus().active).toBe(false));

    expect(core.saveCachedSessions).not.toHaveBeenCalled();
    expect(workerThreads.workers).toHaveLength(workerCount);
    expect(events).toEqual([]);
    expect(store.getSnapshot().sessions).toEqual([previous]);
  });

  it("uses native recursive watch and waits for appended files to stabilize", async () => {
    vi.useFakeTimers();
    stubProcessRuntime("darwin", "18.0.0");
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-watch-"));
    const codexRoot = join(tempDir, "codex");
    const sessionsDir = join(codexRoot, "sessions");
    const sessionFile = join(sessionsDir, "new.jsonl");
    mkdirSync(sessionsDir, { recursive: true });
    core.resolveAgentRoots.mockReturnValue({
      claudecode: join(tempDir, "claude"),
      codex: codexRoot,
      cursor: join(tempDir, "cursor"),
      kimi: join(tempDir, "kimi"),
      opencode: join(tempDir, "opencode"),
      pi: join(tempDir, "pi"),
      zcode: join(tempDir, "zcode"),
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

    const store = new LiveScanStore({ watchEnabled: true, scanOptions: { agents: ["codex"] } });
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
    core.resolveAgentRoots.mockReturnValue({
      claudecode: join(tempDir, "claude"),
      codex: codexRoot,
      cursor: join(tempDir, "cursor"),
      kimi: join(tempDir, "kimi"),
      opencode: join(tempDir, "opencode"),
      pi: join(tempDir, "pi"),
      zcode: join(tempDir, "zcode"),
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

    const store = new LiveScanStore({ watchEnabled: true, scanOptions: { agents: ["codex"] } });
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
    core.resolveAgentRoots.mockReturnValue({
      claudecode: join(tempDir, "claude"),
      codex: codexRoot,
      cursor: join(tempDir, "cursor"),
      kimi: join(tempDir, "kimi"),
      opencode: join(tempDir, "opencode"),
      pi: join(tempDir, "pi"),
      zcode: join(tempDir, "zcode"),
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

    const store = new LiveScanStore({ watchEnabled: true, scanOptions: { agents: ["codex"] } });
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
    const existingKimi = makeSession("kimi-old", {
      reference: { agentName: "kimi", sessionId: "kimi-old" },
    });
    const codex = makeAgent("codex", {
      checkForChanges: vi
        .fn()
        .mockReturnValueOnce({
          hasChanges: true,
          changedIds: ["codex-new"],
          timestamp: 3000,
        })
        .mockReturnValue({ hasChanges: false, timestamp: 4000 }),
      incrementalScan: vi.fn(() => [existingCodex, makeSession("codex-new")]),
    });
    const kimi = makeAgent("kimi", {
      checkForChanges: vi
        .fn()
        .mockReturnValueOnce({ hasChanges: false, timestamp: 3000 })
        .mockReturnValue({
          hasChanges: true,
          changedIds: ["kimi-new"],
          timestamp: 4000,
        }),
      incrementalScan: vi.fn(() => [
        existingKimi,
        makeSession("kimi-new", {
          reference: { agentName: "kimi", sessionId: "kimi-new" },
        }),
      ]),
    });
    core.createRegisteredAgents.mockReturnValue([codex, kimi]);
    core.scanSessions.mockResolvedValue({
      sessions: [existingCodex, existingKimi],
      byAgent: { codex: [existingCodex], kimi: [existingKimi] },
      agents: [codex, kimi],
    });

    const store = new LiveScanStore({ watchEnabled: false });
    const events: SessionsUpdatedEvent[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(3));
    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual([]);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([
      expect.objectContaining({
        changedAgents: ["codex", "kimi"],
        newSessions: 2,
        updatedSessions: 0,
        removedSessions: 0,
        totalSessions: 4,
        changedSessionHeads: [
          {
            reference: { agentName: "codex", sessionId: "codex-new" },
            session: expect.objectContaining({
              reference: { agentName: "codex", sessionId: "codex-new" },
            }),
          },
          {
            reference: { agentName: "kimi", sessionId: "kimi-new" },
            session: expect.objectContaining({
              reference: { agentName: "kimi", sessionId: "kimi-new" },
            }),
          },
        ],
        removedSessionRefs: [],
      }),
    ]);
  });

  it("keeps notifying later subscribers when an earlier one throws", async () => {
    vi.useFakeTimers();
    const existing = makeSession("codex-old");
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: ["codex-new"],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [existing, makeSession("codex-new")]),
    });
    core.createRegisteredAgents.mockReturnValue([codex]);
    core.scanSessions.mockResolvedValue({
      sessions: [existing],
      byAgent: { codex: [existing] },
      agents: [codex],
    });

    const store = new LiveScanStore({ watchEnabled: false });
    store.subscribe(() => {
      throw new Error("subscriber boom");
    });
    const events: SessionsUpdatedEvent[] = [];
    store.subscribe((event) => events.push(event));
    await store.initialize();
    store.startBackgroundRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(store.getSnapshot().sessions).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(250);

    expect(events).toEqual([expect.objectContaining({ changedAgents: ["codex"] })]);
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

    const store = new LiveScanStore({ watchEnabled: false });
    await store.initialize();
    const listener = vi.fn();
    store.subscribe(listener);
    store.startBackgroundRefresh();
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
    expect(store.getSnapshot().sessions).toEqual([existing]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not start a pending search-index batch while shutting down", async () => {
    const codexBefore = makeSession("codex-session", { title: "codex before" });
    const codexAfter = makeSession("codex-session", { title: "codex after" });
    const kimiBefore = makeSession("kimi-session", {
      reference: { agentName: "kimi", sessionId: "kimi-session" },
      title: "kimi before",
    });
    const kimiAfter = makeSession("kimi-session", {
      reference: { agentName: "kimi", sessionId: "kimi-session" },
      title: "kimi after",
    });
    const codex = makeAgent("codex", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: [codexAfter.reference.sessionId],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [codexAfter]),
    });
    const kimi = makeAgent("kimi", {
      checkForChanges: vi.fn(() => ({
        hasChanges: true,
        changedIds: [kimiAfter.reference.sessionId],
        timestamp: 3000,
      })),
      incrementalScan: vi.fn(() => [kimiAfter]),
    });
    core.createRegisteredAgents.mockReturnValue([codex, kimi]);
    core.scanSessions.mockResolvedValue({
      sessions: [codexBefore, kimiBefore],
      byAgent: { codex: [codexBefore], kimi: [kimiBefore] },
      agents: [codex, kimi],
    });
    vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new LiveScanStore({ watchEnabled: false, deferInitialRefresh: true });
    await store.initialize();
    workerThreads.deferSearchIndexWorkers = true;
    const listener = vi.fn();
    store.subscribe(listener);
    store.startBackgroundRefresh();
    await vi.waitFor(() =>
      expect(
        workerThreads.workers.some((worker) =>
          worker.workerData.jobs?.some((job: { agentName?: string }) => job.agentName === "codex"),
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(kimi.incrementalScan).toHaveBeenCalledOnce());

    await store.shutdown();

    expect(
      workerThreads.workers.some((worker) =>
        worker.workerData.jobs?.some((job: { agentName?: string }) => job.agentName === "kimi"),
      ),
    ).toBe(false);
    expect(store.getSnapshot().sessions.map((session) => session.title)).toEqual([
      "codex before",
      "kimi before",
    ]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("coalesces pending search-index changes to the latest session state", async () => {
    workerThreads.deferSearchIndexWorkers = true;
    const runner = new SearchIndexJobRunner();
    const active = runner.enqueue("scan.refresh", [
      {
        kind: "full",
        context: "scan.refresh",
        agentName: "codex",
        sessions: [],
        meta: {},
        completeness: "complete",
        removedSessionIds: [],
      },
    ]);
    const pending = [1, 2, 3].map((version) =>
      runner.enqueue("scan.refresh", [
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
    activeWorker.emitMessage({
      type: "done",
      context: "scan.refresh",
      durationMs: 0,
      sessions: 1,
      failedAgents: [],
    });

    const searchIndexWorkers = workerThreads.workers.filter((worker) => worker.workerData.jobs);
    expect(searchIndexWorkers).toEqual([activeWorker]);
    const nextBatch = activeWorker.postMessage.mock.calls.at(-1)?.[0] as
      | { jobs?: unknown[] }
      | undefined;
    expect(nextBatch?.jobs).toEqual([
      expect.objectContaining({
        kind: "changes",
        changes: [
          expect.objectContaining({
            session: expect.objectContaining({
              reference: { agentName: "codex", sessionId: "active" },
              title: "version 3",
            }),
          }),
        ],
      }),
    ]);

    activeWorker.emitMessage({
      type: "done",
      context: "scan.refresh",
      durationMs: 0,
      sessions: 1,
      failedAgents: [],
    });
    expect(await outcomes).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("makes repeated shutdown calls share one worker termination", async () => {
    workerThreads.deferSearchIndexWorkers = true;
    const runner = new SearchIndexJobRunner();
    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
      completeness: "complete" as const,
      removedSessionIds: [],
    };
    const batch = runner.enqueue("scan.refresh", [job]);
    const outcome = batch.catch((error: Error) => error);
    const worker = workerThreads.workers.at(-1)!;

    await Promise.all([runner.shutdown(), runner.shutdown()]);

    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(await outcome).toBeInstanceOf(Error);
    await expect(runner.enqueue("scan.refresh", [job])).rejects.toThrow(
      "Live scan store shut down",
    );
  });

  it("settles a worker error once when shutdown follows", async () => {
    workerThreads.deferSearchIndexWorkers = true;
    const runner = new SearchIndexJobRunner();
    const job = {
      kind: "full" as const,
      context: "scan.refresh",
      agentName: "codex",
      sessions: [],
      meta: {},
      completeness: "complete" as const,
      removedSessionIds: [],
    };
    const batch = runner.enqueue("scan.refresh", [job]);
    const outcome = Promise.allSettled([batch]);
    const worker = workerThreads.workers.at(-1)!;

    worker.emitError(new Error("index failed"));
    await runner.shutdown();

    expect(await outcome).toEqual([
      expect.objectContaining({ status: "rejected", reason: new Error("index failed") }),
    ]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(workerThreads.workers.filter((item) => item.workerData.jobs)).toHaveLength(1);
  });
});
