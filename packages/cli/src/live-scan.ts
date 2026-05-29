import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createRegisteredAgents,
  computeIdentity,
  filterSessions,
  getCursorDataPath,
  isAgentCacheInitialized,
  loadCachedSessions,
  realFs,
  resolveProviderRoots,
  scanSessions,
  type AgentScanProgress,
  type BaseAgent,
  type ScanResult,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionSourceRef,
  type SessionHeadChange,
  type SessionHead,
} from "@codesesh/core";
import type { SearchIndexWorkerJob, SearchIndexWorkerMessage } from "./search-index-worker.js";
import type { ScanRefreshWorkerMessage } from "./scan-refresh-worker.js";
import { appLogger, logSearchIndexSync } from "./logging.js";

export interface SessionsUpdatedEvent {
  type: "sessions-updated";
  changedAgents: string[];
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
  totalSessions: number;
  timestamp: number;
  changedSessionHeads: Array<{ agentName: string; session: SessionHead }>;
  removedSessionRefs: Array<{ agentName: string; sessionId: string }>;
}

export interface ScanStatusEvent {
  type: "scan-status";
  active: boolean;
  phase: "idle" | "indexing" | "initializing" | "scanning";
  pendingAgents: string[];
  scanningAgents: string[];
  completedAgents: string[];
  agentStatuses: Record<string, AgentScanStatus>;
  totalAgents: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

export interface AgentScanStatus {
  agentName: string;
  status: "pending" | "scanning" | "complete";
  total?: number;
  processed?: number;
  sessions?: number;
  startedAt?: number;
  updatedAt: number;
  completedAt?: number;
}

type StoreListener = (event: SessionsUpdatedEvent) => void;
type ScanStatusListener = (event: ScanStatusEvent) => void;

interface WatchTarget {
  path: string;
  root?: string;
}

interface WatchScope {
  agentName: string;
  targetPath: string;
}

interface StablePathState {
  path: string;
  agentNames: Set<string>;
  lastMtimeMs: number | null;
  lastSize: number | null;
  stableSince: number;
  timer: NodeJS.Timeout | null;
}

interface SessionRefreshDiff {
  event: SessionsUpdatedEvent | null;
  changedSessions: SessionHeadChange[];
  removedSessionIds: string[];
}

interface SearchIndexJobBatch {
  context: string;
  jobs: SearchIndexWorkerJob[];
  resolve: () => void;
  reject: (error: Error) => void;
}

interface LiveScanStoreOptions {
  deferInitialRefresh?: boolean;
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const PENDING_REFRESH_DELAY_MS = 100;
const WRITE_STABILITY_THRESHOLD_MS = 250;
const WRITE_STABILITY_POLL_MS = 100;
const NEW_SESSION_EVENT_WINDOW_MS = 250;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;

function sortSessions(sessions: SessionHead[]): SessionHead[] {
  return [...sessions].sort(
    (a, b) => (b.time_updated ?? b.time_created) - (a.time_updated ?? a.time_created),
  );
}

function sessionSignature(session: SessionHead): string {
  return JSON.stringify([
    session.title,
    session.directory,
    session.time_created,
    session.time_updated ?? session.time_created,
    session.stats.message_count,
    session.stats.total_input_tokens,
    session.stats.total_output_tokens,
    session.stats.total_cost,
    session.stats.total_tokens ?? 0,
  ]);
}

function buildAgentCacheMeta(
  agent: BaseAgent,
  sessionIds?: Set<string>,
): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  const meta: Record<string, SessionCacheMeta> = {};
  if (!metaMap) return meta;

  for (const [id, data] of metaMap.entries()) {
    if (sessionIds && !sessionIds.has(id)) continue;
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }

  return meta;
}

function attachMissingProjectIdentities(sessions: SessionHead[]): SessionHead[] {
  const identities = new Map<string, ReturnType<typeof computeIdentity>>();

  return sessions.map((session) => {
    if (session.project_identity) return session;

    const directory = session.directory || "";
    let identity = identities.get(directory);
    if (!identity) {
      identity = computeIdentity(directory, realFs);
      identities.set(directory, identity);
    }

    return { ...session, project_identity: identity };
  });
}

function buildRefreshDiff(
  agentName: string,
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
  candidateChangedIds: string[] = [],
): SessionRefreshDiff {
  const previousMap = new Map(previousSessions.map((session) => [session.id, session]));
  const nextMap = new Map(nextSessions.map((session) => [session.id, session]));
  const candidateChangedIdSet = new Set(candidateChangedIds);
  const changedSessions: SessionHeadChange[] = [];
  const removedSessionIds: string[] = [];

  let newSessions = 0;
  let updatedSessions = 0;
  let removedSessions = 0;

  nextSessions.forEach((session, index) => {
    const id = session.id;
    const previous = previousMap.get(id);
    if (!previous) {
      newSessions += 1;
      changedSessions.push({ session, sortIndex: index });
      return;
    }
    const hasSignatureChange = sessionSignature(previous) !== sessionSignature(session);
    const hasContentChange = candidateChangedIdSet.has(id);
    if (hasSignatureChange || hasContentChange) {
      updatedSessions += 1;
    }
    if (hasContentChange || hasSignatureChange) {
      changedSessions.push({ session, sortIndex: index });
    }
  });

  for (const id of previousMap.keys()) {
    if (!nextMap.has(id)) {
      removedSessions += 1;
      removedSessionIds.push(id);
    }
  }

  if (newSessions === 0 && updatedSessions === 0 && removedSessions === 0) {
    return { event: null, changedSessions, removedSessionIds };
  }

  return {
    changedSessions,
    removedSessionIds,
    event: {
      type: "sessions-updated",
      changedAgents: [agentName],
      newSessions,
      updatedSessions,
      removedSessions,
      totalSessions: nextSessions.length,
      timestamp: Date.now(),
      changedSessionHeads: changedSessions.map(({ session }) => ({ agentName, session })),
      removedSessionRefs: removedSessionIds.map((sessionId) => ({ agentName, sessionId })),
    },
  };
}

function restoreAgentCacheMeta(agent: BaseAgent, meta: Record<string, SessionCacheMeta>): void {
  agent.setSessionMetaMap?.(new Map(Object.entries(meta)));
}

function toAbsolutePath(path: string): string {
  return isAbsolute(path) ? path : resolve(path);
}

function closestWatchablePath(targetPath: string): string | null {
  if (!isAbsolute(targetPath) && !existsSync(targetPath)) {
    return null;
  }

  let current = toAbsolutePath(targetPath);

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
}

function getWatchRoot(path: string): string {
  const stat = statSync(path);
  return stat.isDirectory() ? path : dirname(path);
}

function isRecursiveWatchSupported(
  platform = process.platform,
  nodeVersion = process.versions.node,
): boolean {
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (platform !== "linux" && platform !== "aix" && platform !== "ibmi") {
    return false;
  }

  const [major = 0, minor = 0] = nodeVersion.split(".").map((part) => Number(part));
  return major > 19 || (major === 19 && minor >= 1);
}

function isRecursiveWatchUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"
  );
}

function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const path = relative(parentPath, childPath);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function isRelatedPath(changedPath: string, targetPath: string): boolean {
  return isSameOrChildPath(targetPath, changedPath) || isSameOrChildPath(changedPath, targetPath);
}

function mergeEvents(
  previous: SessionsUpdatedEvent,
  next: SessionsUpdatedEvent,
): SessionsUpdatedEvent {
  const changedSessionHeads = new Map<string, { agentName: string; session: SessionHead }>();
  const removedSessionRefs = new Map<string, { agentName: string; sessionId: string }>();
  const sessionKey = (agentName: string, sessionId: string) => `${agentName}\0${sessionId}`;
  const addChanged = (item: { agentName: string; session: SessionHead }) => {
    const key = sessionKey(item.agentName, item.session.id);
    removedSessionRefs.delete(key);
    changedSessionHeads.set(key, item);
  };
  const addRemoved = (item: { agentName: string; sessionId: string }) => {
    const key = sessionKey(item.agentName, item.sessionId);
    changedSessionHeads.delete(key);
    removedSessionRefs.set(key, item);
  };

  for (const item of previous.changedSessionHeads) addChanged(item);
  for (const item of previous.removedSessionRefs) addRemoved(item);
  for (const item of next.changedSessionHeads) addChanged(item);
  for (const item of next.removedSessionRefs) addRemoved(item);

  return {
    type: "sessions-updated",
    changedAgents: Array.from(new Set([...previous.changedAgents, ...next.changedAgents])),
    newSessions: previous.newSessions + next.newSessions,
    updatedSessions: previous.updatedSessions + next.updatedSessions,
    removedSessions: previous.removedSessions + next.removedSessions,
    totalSessions: next.totalSessions,
    timestamp: next.timestamp,
    changedSessionHeads: [...changedSessionHeads.values()],
    removedSessionRefs: [...removedSessionRefs.values()],
  };
}

function mergeScopes(target: WatchScope[], scopes: WatchScope[]): void {
  for (const scope of scopes) {
    if (
      !target.some(
        (item) => item.agentName === scope.agentName && item.targetPath === scope.targetPath,
      )
    ) {
      target.push(scope);
    }
  }
}

function resolveWatchEventPath(watchPath: string, filename: string | Buffer | null): string {
  const filenameText = filename?.toString();
  if (!filenameText) {
    return watchPath;
  }
  return isAbsolute(filenameText) ? filenameText : join(watchPath, filenameText);
}

export function resolveAgentWatchTargets(agentName: string): WatchTarget[] {
  const roots = resolveProviderRoots();
  const cursorDataPath = getCursorDataPath();

  switch (agentName) {
    case "claudecode":
      return [
        { root: roots.claudeRoot, path: join(roots.claudeRoot, "projects") },
        { path: "data/claudecode" },
      ];
    case "codex":
      return [
        { path: join(roots.codexRoot, "sessions") },
        { path: join(roots.codexRoot, "session_index.jsonl") },
      ];
    case "cursor":
      return cursorDataPath
        ? [
            {
              root: cursorDataPath,
              path: join(cursorDataPath, "globalStorage", "state.vscdb"),
            },
            { root: cursorDataPath, path: join(cursorDataPath, "workspaceStorage") },
          ]
        : [];
    case "kimi":
      return [
        { root: roots.kimiRoot, path: join(roots.kimiRoot, "sessions") },
        { path: "data/kimi" },
      ];
    case "opencode":
      return [
        { root: roots.opencodeRoot, path: join(roots.opencodeRoot, "opencode.db") },
        { root: "data/opencode", path: "data/opencode/opencode.db" },
      ];
    default:
      return [];
  }
}

export class LiveScanStore {
  private agents: BaseAgent[] = [];
  private byAgent: Record<string, SessionHead[]> = {};
  private sessions: SessionHead[] = [];
  private listeners = new Set<StoreListener>();
  private scanStatusListeners = new Set<ScanStatusListener>();
  private scanStatus: Omit<ScanStatusEvent, "type"> = {
    active: false,
    phase: "idle",
    pendingAgents: [],
    scanningAgents: [],
    completedAgents: [],
    agentStatuses: {},
    totalAgents: 0,
    updatedAt: Date.now(),
  };
  private refreshTimers = new Map<string, NodeJS.Timeout>();
  private refreshTimestamps = new Map<string, number>();
  private refreshInFlight = new Set<string>();
  private pendingRefreshes = new Set<string>();
  private pendingRefreshPathCounts = new Map<string, number>();
  private watchers: FSWatcher[] = [];
  private fallbackWatchScopes = new Map<string, WatchScope[]>();
  private stablePaths = new Map<string, StablePathState>();
  private pendingEvent: SessionsUpdatedEvent | null = null;
  private pendingEventTimer: NodeJS.Timeout | null = null;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private searchIndexWorker: Worker | null = null;
  private pendingSearchIndexJobs: SearchIndexJobBatch[] = [];
  private shuttingDown = false;

  constructor(
    private readonly watchEnabled = true,
    private readonly scanOptions: ScanOptions = {},
    private readonly startupScanOptions: Pick<ScanOptions, "from" | "to"> = {},
    private readonly storeOptions: LiveScanStoreOptions = {},
  ) {}

  async initialize(): Promise<void> {
    const startedAt = performance.now();
    const deferInitialRefresh = this.storeOptions.deferInitialRefresh === true;
    appLogger.info("scan.initial.start", {
      watch_enabled: this.watchEnabled,
      agents: this.scanOptions.agents,
      use_cache: this.scanOptions.useCache ?? true,
      startup_from: this.startupScanOptions.from,
      startup_to: this.startupScanOptions.to,
      deferred: deferInitialRefresh || undefined,
    });
    const initialResult = await scanSessions({
      ...this.scanOptions,
      ...(deferInitialRefresh ? this.startupScanOptions : {}),
      useCache: this.scanOptions.useCache ?? true,
      smartRefresh: false,
      cacheOnly: deferInitialRefresh,
      writeCache: deferInitialRefresh ? false : this.scanOptions.writeCache,
      smartTagWorkerUrl: this.getSmartTagWorkerUrl() ?? undefined,
      includeSmartTags: deferInitialRefresh ? false : undefined,
    });
    this.applyScanResult(initialResult);
    const indexStartedAt = performance.now();
    if (!deferInitialRefresh) {
      await this.enqueueSearchIndexJobs(
        "scan.initial",
        this.buildFullSearchIndexJobs("scan.initial"),
      );
    }
    const indexDuration = performance.now() - indexStartedAt;
    appLogger.info("scan.initial.done", {
      duration_ms: Math.round(performance.now() - startedAt),
      index_ms: deferInitialRefresh ? undefined : Math.round(indexDuration),
      deferred: deferInitialRefresh || undefined,
      sessions: this.sessions.length,
      agents: Object.fromEntries(
        Object.entries(this.byAgent).map(([key, value]) => [key, value.length]),
      ),
      agent_timings: initialResult.timings
        ? Object.fromEntries(
            Object.entries(initialResult.timings).map(([name, t]) => [
              name,
              {
                total_ms: Math.round(t.total),
                cache_load_ms: t.cacheLoad != null ? Math.round(t.cacheLoad) : undefined,
                check_changes_ms: t.checkChanges != null ? Math.round(t.checkChanges) : undefined,
                scan_ms: t.scan != null ? Math.round(t.scan) : undefined,
                identity_ms: t.identity != null ? Math.round(t.identity) : undefined,
                tags_ms: t.tags != null ? Math.round(t.tags) : undefined,
              },
            ]),
          )
        : undefined,
    });
    if (this.watchEnabled) {
      this.startWatching();
    }
  }

  startBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) {
      return;
    }
    const agentNames = this.agents.map((agent) => agent.name);
    this.startScanBatch(agentNames, "scanning");
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null;
      for (const agentName of agentNames) {
        this.scheduleRefresh(agentName, 0);
      }
      if (agentNames.length === 0) {
        this.finishScanBatch();
      }
    }, 0);
  }

  getSnapshot(): ScanResult {
    return {
      sessions: this.sessions,
      byAgent: this.byAgent,
      agents: this.agents,
    };
  }

  getScanStatus(): ScanStatusEvent {
    return {
      type: "scan-status",
      ...this.scanStatus,
      pendingAgents: [...this.scanStatus.pendingAgents],
      scanningAgents: [...this.scanStatus.scanningAgents],
      completedAgents: [...this.scanStatus.completedAgents],
      agentStatuses: Object.fromEntries(
        Object.entries(this.scanStatus.agentStatuses).map(([agentName, status]) => [
          agentName,
          { ...status },
        ]),
      ),
    };
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  subscribeScanStatus(listener: ScanStatusListener): () => void {
    this.scanStatusListeners.add(listener);
    return () => {
      this.scanStatusListeners.delete(listener);
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.pendingRefreshPathCounts.clear();
    for (const state of this.stablePaths.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
    this.stablePaths.clear();

    if (this.pendingEventTimer) {
      clearTimeout(this.pendingEventTimer);
      this.pendingEventTimer = null;
    }
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
    if (this.searchIndexWorker) {
      await this.searchIndexWorker.terminate();
      this.searchIndexWorker = null;
    }
    for (const batch of this.pendingSearchIndexJobs) {
      batch.reject(new Error("Live scan store shut down"));
    }
    this.pendingSearchIndexJobs = [];
    this.pendingEvent = null;

    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    this.watchers = [];
    this.fallbackWatchScopes.clear();
  }

  private emit(event: SessionsUpdatedEvent): void {
    if (this.pendingEvent || event.newSessions > 0) {
      this.queueEvent(event);
      return;
    }

    this.emitNow(event);
  }

  private emitNow(event: SessionsUpdatedEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private emitScanStatus(): void {
    const event = this.getScanStatus();
    for (const listener of this.scanStatusListeners) {
      listener(event);
    }
  }

  private updateScanStatus(next: Omit<ScanStatusEvent, "type">): void {
    this.scanStatus = next;
    this.emitScanStatus();
  }

  private startScanBatch(agentNames: string[], phase: ScanStatusEvent["phase"]): void {
    const uniqueAgentNames = [...new Set(agentNames)];
    const now = Date.now();
    const agentStatuses = Object.fromEntries(
      uniqueAgentNames.map((agentName) => [
        agentName,
        {
          agentName,
          status: "pending" as const,
          processed: 0,
          sessions: this.byAgent[agentName]?.length ?? 0,
          updatedAt: now,
        },
      ]),
    );
    this.updateScanStatus({
      active: uniqueAgentNames.length > 0,
      phase: uniqueAgentNames.length > 0 ? phase : "idle",
      pendingAgents: uniqueAgentNames,
      scanningAgents: [],
      completedAgents: [],
      agentStatuses,
      totalAgents: uniqueAgentNames.length,
      startedAt: uniqueAgentNames.length > 0 ? now : undefined,
      updatedAt: now,
      completedAt: uniqueAgentNames.length > 0 ? undefined : now,
    });
  }

  private setScanPhase(phase: ScanStatusEvent["phase"]): void {
    if (!this.scanStatus.active) return;
    this.updateScanStatus({
      ...this.scanStatus,
      phase,
      updatedAt: Date.now(),
    });
  }

  private beginAgentScan(agentName: string): void {
    if (!this.scanStatus.active) {
      this.startScanBatch([agentName], "scanning");
    }

    const pendingAgents = this.scanStatus.pendingAgents.filter((agent) => agent !== agentName);
    const scanningAgents = [...new Set([...this.scanStatus.scanningAgents, agentName])];
    const completedAgents = this.scanStatus.completedAgents.filter((agent) => agent !== agentName);
    const existingStatus = this.scanStatus.agentStatuses[agentName];
    const agentStatuses = {
      ...this.scanStatus.agentStatuses,
      [agentName]: {
        agentName,
        status: "scanning" as const,
        total: existingStatus?.total,
        processed: existingStatus?.processed ?? 0,
        sessions: existingStatus?.sessions ?? this.byAgent[agentName]?.length ?? 0,
        startedAt: existingStatus?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
      },
    };
    this.updateScanStatus({
      ...this.scanStatus,
      active: true,
      phase: this.scanStatus.phase === "initializing" ? "initializing" : "scanning",
      pendingAgents,
      scanningAgents,
      completedAgents,
      agentStatuses,
      totalAgents: Math.max(
        this.scanStatus.totalAgents,
        pendingAgents.length + scanningAgents.length,
      ),
      updatedAt: Date.now(),
      completedAt: undefined,
    });
  }

  private updateAgentScanProgress(agentName: string, progress: AgentScanProgress): void {
    const status = this.scanStatus.agentStatuses[agentName];
    if (!status || status.status !== "scanning") return;
    this.updateScanStatus({
      ...this.scanStatus,
      agentStatuses: {
        ...this.scanStatus.agentStatuses,
        [agentName]: {
          ...status,
          total: progress.total ?? status.total,
          processed: progress.processed ?? status.processed,
          sessions: progress.sessions ?? status.sessions,
          updatedAt: Date.now(),
        },
      },
      updatedAt: Date.now(),
    });
  }

  private finishAgentScan(agentName: string): void {
    const pendingAgents = this.scanStatus.pendingAgents.filter((agent) => agent !== agentName);
    const scanningAgents = this.scanStatus.scanningAgents.filter((agent) => agent !== agentName);
    const completedAgents = [...new Set([...this.scanStatus.completedAgents, agentName])];
    const active = pendingAgents.length > 0 || scanningAgents.length > 0;
    const now = Date.now();
    const previousStatus = this.scanStatus.agentStatuses[agentName];
    const sessions = this.byAgent[agentName]?.length ?? previousStatus?.sessions ?? 0;
    const total = previousStatus?.total ?? previousStatus?.processed;

    this.updateScanStatus({
      ...this.scanStatus,
      active,
      phase: active ? "scanning" : "idle",
      pendingAgents,
      scanningAgents,
      completedAgents,
      agentStatuses: {
        ...this.scanStatus.agentStatuses,
        [agentName]: {
          agentName,
          status: "complete",
          total,
          processed: total,
          sessions,
          startedAt: previousStatus?.startedAt,
          updatedAt: now,
          completedAt: now,
        },
      },
      updatedAt: now,
      completedAt: active ? undefined : now,
    });
  }

  private finishScanBatch(): void {
    const now = Date.now();
    this.updateScanStatus({
      ...this.scanStatus,
      active: false,
      phase: "idle",
      pendingAgents: [],
      scanningAgents: [],
      agentStatuses: Object.fromEntries(
        Object.entries(this.scanStatus.agentStatuses).map(([agentName, status]) => [
          agentName,
          { ...status, status: "complete", completedAt: status.completedAt ?? now, updatedAt: now },
        ]),
      ),
      updatedAt: now,
      completedAt: now,
    });
  }

  private queueEvent(event: SessionsUpdatedEvent): void {
    this.pendingEvent = this.pendingEvent ? mergeEvents(this.pendingEvent, event) : event;
    if (this.pendingEventTimer) {
      return;
    }

    this.pendingEventTimer = setTimeout(() => {
      const pending = this.pendingEvent;
      this.pendingEvent = null;
      this.pendingEventTimer = null;
      if (pending) {
        this.emitNow(pending);
      }
    }, NEW_SESSION_EVENT_WINDOW_MS);
  }

  private rebuildSessions(): void {
    this.sessions = sortSessions(Object.values(this.byAgent).flat());
  }

  private getSearchIndexWorkerUrl(): URL | null {
    const workerUrl = new URL("./search-index-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) {
      return null;
    }
    return workerUrl;
  }

  private getSmartTagWorkerUrl(): URL | null {
    const workerUrl = new URL("./smart-tag-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) {
      return null;
    }
    return workerUrl;
  }

  private getScanRefreshWorkerUrl(): URL {
    return new URL("./scan-refresh-worker.js", import.meta.url);
  }

  private scanAgentInWorker(
    agent: BaseAgent,
    previousSessions: SessionHead[],
    changedIds: string[] | null,
    scanOptions: Pick<ScanOptions, "from" | "to" | "fast">,
    workerOptions: { sourceSync?: boolean; meta?: Record<string, SessionCacheMeta> } = {},
  ): Promise<{
    sessions: SessionHead[];
    meta: Record<string, SessionCacheMeta>;
    changedIds?: string[];
  }> {
    const workerUrl = this.getScanRefreshWorkerUrl();

    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, {
        workerData: {
          agentName: agent.name,
          previousSessions,
          changedIds,
          sourceSync: workerOptions.sourceSync,
          scanOptions,
          meta: workerOptions.meta ?? buildAgentCacheMeta(agent),
        },
      });
      worker.unref();

      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        callback();
      };

      worker.on("message", (message: ScanRefreshWorkerMessage) => {
        if (message.type === "progress") {
          this.updateAgentScanProgress(agent.name, message.progress);
          return;
        }
        if (message.type === "done") {
          finish(() =>
            resolve({
              sessions: message.sessions,
              meta: message.meta,
              changedIds: message.changedIds,
            }),
          );
          return;
        }
        finish(() => reject(new Error(message.error)));
      });
      worker.once("error", (error) => {
        finish(() => reject(error));
      });
      worker.once("exit", (code) => {
        if (!settled && code !== 0) {
          finish(() => reject(new Error(`Scan refresh worker exited with code ${code}`)));
        }
      });
    });
  }

  private buildFullSearchIndexJobs(context: string): SearchIndexWorkerJob[] {
    return this.agents.map((agent) => {
      const cached = loadCachedSessions(agent.name);
      if (cached) {
        return {
          kind: "full",
          context,
          agentName: agent.name,
          sessions: cached.sessions,
          meta: cached.meta,
        };
      }
      return {
        kind: "full",
        context,
        agentName: agent.name,
        sessions: this.byAgent[agent.name] ?? [],
        meta: buildAgentCacheMeta(agent),
      };
    });
  }

  private enqueueSearchIndexJobs(context: string, jobs: SearchIndexWorkerJob[]): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const batch: SearchIndexJobBatch = { context, jobs, resolve, reject };

      if (this.searchIndexWorker) {
        this.pendingSearchIndexJobs.push(batch);
        appLogger.debug("search_index.worker_queued", {
          context,
          jobs: jobs.length,
          pending_jobs: this.pendingSearchIndexJobs.length,
        });
        return;
      }

      this.startSearchIndexJobBatch(batch);
    });
  }

  private startSearchIndexJobBatch(batch: SearchIndexJobBatch): void {
    const workerUrl = this.getSearchIndexWorkerUrl();
    if (!workerUrl) {
      appLogger.warn("search_index.worker_missing", { context: batch.context });
      batch.resolve();
      return;
    }

    let settled = false;
    const worker = new Worker(workerUrl, {
      workerData: {
        context: batch.context,
        jobs: batch.jobs,
        agentNames: [],
        sessionsByAgent: {},
        metaByAgent: {},
      },
    });
    worker.unref();
    this.searchIndexWorker = worker;

    worker.on("message", (message: SearchIndexWorkerMessage) => {
      if (message.type === "sync-result") {
        logSearchIndexSync(message.context, message.result);
      } else if (message.type === "done") {
        appLogger.info(`${message.context}.done`, {
          duration_ms: Math.round(message.durationMs),
          sessions: message.sessions,
        });
        settled = true;
        batch.resolve();
      }
    });
    worker.on("error", (error) => {
      appLogger.error("search_index.worker_error", { context: batch.context, error });
      if (!settled) {
        settled = true;
        batch.reject(error);
      }
    });
    worker.on("exit", (code) => {
      this.searchIndexWorker = null;
      if (code !== 0) {
        appLogger.warn("search_index.worker_exit", { context: batch.context, code });
        if (!settled) {
          settled = true;
          batch.reject(new Error(`Search index worker exited with code ${code}`));
        }
      }
      if (this.pendingSearchIndexJobs.length > 0) {
        const pendingBatch = this.pendingSearchIndexJobs.shift()!;
        this.startSearchIndexJobBatch(pendingBatch);
      }
    });
  }

  private applyScanResult(result: ScanResult): void {
    const knownAgents = createRegisteredAgents();
    const agentMap = new Map<string, BaseAgent>();
    const allowedAgents = this.getAllowedAgents();

    for (const agent of result.agents) {
      agentMap.set(agent.name, agent);
    }
    for (const agent of knownAgents) {
      if (!agentMap.has(agent.name)) {
        agentMap.set(agent.name, agent);
      }
    }

    this.agents = [...agentMap.values()].filter((agent) => {
      if (!allowedAgents) {
        return true;
      }
      return allowedAgents.has(agent.name.toLowerCase());
    });

    this.byAgent = {};
    for (const agent of this.agents) {
      this.byAgent[agent.name] = sortSessions(result.byAgent[agent.name] ?? []);
      this.refreshTimestamps.set(agent.name, result.cacheTimestamps?.[agent.name] ?? Date.now());
    }

    this.rebuildSessions();
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) {
      return null;
    }
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }

  private applyFilters(sessions: SessionHead[]): SessionHead[] {
    return filterSessions(sessions, { ...this.scanOptions, ...this.startupScanOptions });
  }

  private canSyncSources(agent: BaseAgent): agent is BaseAgent & {
    listSessionSources: () => SessionSourceRef[];
    scanSessionSource: (sourcePath: string) => SessionHead | null;
  } {
    return Boolean(agent.listSessionSources && agent.scanSessionSource);
  }

  private async refreshInitialIndex(): Promise<void> {
    const startedAt = performance.now();
    const context = "scan.initial.background";

    try {
      await this.enqueueSearchIndexJobs(context, this.buildFullSearchIndexJobs(context));
      appLogger.info(`${context}.complete`, {
        duration_ms: Math.round(performance.now() - startedAt),
        sessions: this.sessions.length,
      });
    } catch (error) {
      if (this.shuttingDown) {
        return;
      }
      appLogger.error(`${context}.error`, { error });
      console.error("[search] Background index sync failed:", error);
    }
  }

  private startWatching(): void {
    const scopesByRoot = new Map<string, WatchScope[]>();

    for (const agent of this.agents) {
      const watchTargets = resolveAgentWatchTargets(agent.name);

      if (watchTargets.length === 0) {
        appLogger.debug("watch.skip", { agent: agent.name });
        continue;
      }

      for (const target of watchTargets) {
        const watchRootPath = closestWatchablePath(target.root ?? target.path);
        if (!watchRootPath) continue;

        let rootPath: string;
        try {
          rootPath = getWatchRoot(watchRootPath);
        } catch (error) {
          this.reportWatchError("watch.resolve.error", { path: watchRootPath, error });
          continue;
        }
        const targetPath = toAbsolutePath(target.path);
        const scopes = scopesByRoot.get(rootPath) ?? [];
        if (
          !scopes.some((scope) => scope.agentName === agent.name && scope.targetPath === targetPath)
        ) {
          scopes.push({ agentName: agent.name, targetPath });
        }
        scopesByRoot.set(rootPath, scopes);
      }
    }

    for (const [rootPath, scopes] of scopesByRoot.entries()) {
      const agents = Array.from(new Set(scopes.map((scope) => scope.agentName)));
      appLogger.info("watch.start", {
        root: rootPath,
        agents,
        targets: scopes.map((scope) => ({
          agent: scope.agentName,
          path: scope.targetPath,
        })),
      });

      if (isRecursiveWatchSupported()) {
        const started = this.watchDirectory(rootPath, scopes, true);
        if (started) {
          continue;
        }
      }

      this.watchDirectoryTree(rootPath, scopes);
    }
  }

  private watchDirectory(path: string, scopes: WatchScope[], recursive: boolean): boolean {
    try {
      const watcher = watch(path, { recursive }, (eventType, filename) => {
        queueMicrotask(() => {
          try {
            const activeScopes = recursive
              ? scopes
              : (this.fallbackWatchScopes.get(path) ?? scopes);
            this.handleWatchEvent(path, activeScopes, eventType, filename);
            if (!recursive) {
              this.watchNewDirectories(path, filename, activeScopes);
            }
          } catch (error) {
            this.reportWatchError("watch.event.error", { path, recursive, error });
          }
        });
      });

      watcher.on("error", (error) => {
        this.reportWatchError("watch.error", { path, recursive, error });
      });

      this.watchers.push(watcher);
      return true;
    } catch (error) {
      if (recursive && isRecursiveWatchUnavailable(error)) {
        appLogger.warn("watch.recursive_unavailable", { path, error });
        return false;
      }

      this.reportWatchError("watch.start.error", { path, recursive, error });
      return false;
    }
  }

  private watchDirectoryTree(rootPath: string, scopes: WatchScope[]): void {
    const pending = [rootPath];

    while (pending.length > 0) {
      const dirPath = pending.pop()!;
      this.watchFallbackDirectory(dirPath, scopes);

      try {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            pending.push(join(dirPath, entry.name));
          }
        }
      } catch (error) {
        this.reportWatchError("watch.scan.error", { path: dirPath, error });
      }
    }
  }

  private watchFallbackDirectory(path: string, scopes: WatchScope[]): void {
    const existingScopes = this.fallbackWatchScopes.get(path);
    if (existingScopes) {
      mergeScopes(existingScopes, scopes);
      return;
    }

    const storedScopes = [...scopes];
    this.fallbackWatchScopes.set(path, storedScopes);
    if (!this.watchDirectory(path, storedScopes, false)) {
      this.fallbackWatchScopes.delete(path);
    }
  }

  private watchNewDirectories(
    watchPath: string,
    filename: string | Buffer | null,
    scopes: WatchScope[],
  ): void {
    const path = resolveWatchEventPath(watchPath, filename);
    try {
      if (statSync(path).isDirectory()) {
        this.watchDirectoryTree(path, scopes);
      }
    } catch {}
  }

  private handleWatchEvent(
    watchPath: string,
    scopes: WatchScope[],
    eventType: string,
    filename: string | Buffer | null,
  ): void {
    const changedPath = resolveWatchEventPath(watchPath, filename);
    const agentNames = new Set(
      scopes
        .filter((scope) => isRelatedPath(changedPath, scope.targetPath))
        .map((scope) => scope.agentName),
    );

    if (agentNames.size === 0) {
      return;
    }

    appLogger.debug("watch.event", {
      event: eventType,
      path: changedPath,
      agents: Array.from(agentNames),
    });
    this.waitForStablePath(changedPath, agentNames);
  }

  private waitForStablePath(path: string, agentNames: Set<string>): void {
    const existing = this.stablePaths.get(path);
    if (existing) {
      for (const agentName of agentNames) {
        existing.agentNames.add(agentName);
      }
      return;
    }

    const state: StablePathState = {
      path,
      agentNames: new Set(agentNames),
      lastMtimeMs: null,
      lastSize: null,
      stableSince: Date.now(),
      timer: null,
    };
    this.stablePaths.set(path, state);
    this.pollStablePath(path);
  }

  private pollStablePath(path: string): void {
    const state = this.stablePaths.get(path);
    if (!state) {
      return;
    }

    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(path);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      this.stablePaths.delete(path);
      this.scheduleRefreshForAgents(state.agentNames);
      return;
    }

    const now = Date.now();
    const unchanged = state.lastSize === size && state.lastMtimeMs === mtimeMs;
    if (!unchanged) {
      state.lastSize = size;
      state.lastMtimeMs = mtimeMs;
      state.stableSince = now;
    }

    if (unchanged && now - state.stableSince >= WRITE_STABILITY_THRESHOLD_MS) {
      this.stablePaths.delete(path);
      this.scheduleRefreshForAgents(state.agentNames);
      return;
    }

    state.timer = setTimeout(() => this.pollStablePath(path), WRITE_STABILITY_POLL_MS);
  }

  private scheduleRefreshForAgents(agentNames: Set<string>): void {
    for (const agentName of agentNames) {
      this.pendingRefreshPathCounts.set(
        agentName,
        (this.pendingRefreshPathCounts.get(agentName) ?? 0) + 1,
      );
      const delayMs =
        (this.byAgent[agentName]?.length ?? 0) === 0
          ? EMPTY_AGENT_REFRESH_DEBOUNCE_MS
          : REFRESH_DEBOUNCE_MS;
      this.scheduleRefresh(agentName, delayMs);
    }
  }

  private reportWatchError(event: string, data: Record<string, unknown>): void {
    appLogger.error(event, data);
    console.error("[watch] File watcher failed:", data.error);
  }

  private scheduleRefresh(agentName: string, delayMs = REFRESH_DEBOUNCE_MS): void {
    appLogger.debug("scan.refresh.schedule", { agent: agentName, delay_ms: delayMs });
    const existing = this.refreshTimers.get(agentName);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.refreshTimers.delete(agentName);
      void this.refreshAgent(agentName);
    }, delayMs);

    this.refreshTimers.set(agentName, timer);
  }

  private async refreshAgent(agentName: string): Promise<void> {
    if (this.refreshInFlight.has(agentName)) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      this.pendingRefreshes.add(agentName);
      return;
    }

    this.refreshInFlight.add(agentName);
    this.beginAgentScan(agentName);

    try {
      await this.runRefresh(agentName);
    } catch (error) {
      appLogger.error("scan.refresh.error", { agent: agentName, error });
      console.error(`[${agentName}] Session refresh failed:`, error);
    } finally {
      this.refreshInFlight.delete(agentName);
      this.finishAgentScan(agentName);

      if (this.pendingRefreshes.delete(agentName)) {
        this.scheduleRefresh(agentName, PENDING_REFRESH_DELAY_MS);
      }
    }
  }

  private async runRefresh(agentName: string): Promise<void> {
    const startedAt = performance.now();
    const pendingPathCount = this.pendingRefreshPathCounts.get(agentName) ?? 0;
    this.pendingRefreshPathCounts.delete(agentName);
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return;
    }

    const previousSessions = this.byAgent[agentName] ?? [];
    const cached = loadCachedSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? this.refreshTimestamps.get(agentName) ?? 0;
    if (cached) {
      restoreAgentCacheMeta(agent, cached.meta);
    }
    const isInitialized = isAgentCacheInitialized(agentName);
    let nextSessions = previousSessions;
    let fullScanSessions: SessionHead[] | null = null;
    let preciseChangedIds: string[] | null = null;
    let usedIncrementalScan = false;
    let persistenceDiff: Pick<SessionRefreshDiff, "changedSessions" | "removedSessionIds"> | null =
      null;
    let availabilityDuration = 0;
    let checkDuration = 0;
    let scanDuration = 0;
    let filterDuration = 0;
    let diffDuration = 0;
    let persistDuration = 0;
    let searchIndexDuration = 0;
    let persistentJobKind: SearchIndexWorkerJob["kind"] | undefined;

    const availabilityStartedAt = performance.now();
    const isAvailable = agent.isAvailable();
    availabilityDuration = performance.now() - availabilityStartedAt;

    if (!isAvailable) {
      nextSessions = [];
      this.refreshTimestamps.set(agentName, Date.now());
    } else if (!isInitialized) {
      this.setScanPhase("initializing");
      const scanStartedAt = performance.now();
      const result = await this.scanAgentInWorker(agent, previousSessions, null, {});
      nextSessions = result.sessions;
      agent.setSessionMetaMap?.(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      this.refreshTimestamps.set(agentName, Date.now());
    } else if (cached && this.canSyncSources(agent)) {
      const scanStartedAt = performance.now();
      const result = await this.scanAgentInWorker(
        agent,
        cached.sessions,
        null,
        {},
        {
          sourceSync: true,
          meta: cached.meta,
        },
      );
      nextSessions = result.sessions;
      agent.setSessionMetaMap?.(new Map(Object.entries(result.meta)));
      preciseChangedIds = result.changedIds ?? [];
      usedIncrementalScan = true;
      persistenceDiff = buildRefreshDiff(
        agentName,
        cached.sessions,
        attachMissingProjectIdentities(nextSessions),
        preciseChangedIds,
      );
      scanDuration = performance.now() - scanStartedAt;
      this.refreshTimestamps.set(agentName, Date.now());
      if (preciseChangedIds.length === 0) {
        appLogger.debug("scan.refresh.unchanged", {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } else if (refreshBaseline.length > 0 && agent.checkForChanges && agent.incrementalScan) {
      const checkStartedAt = performance.now();
      const checkResult = await Promise.resolve(
        agent.checkForChanges(cacheTimestamp, refreshBaseline),
      );
      checkDuration = performance.now() - checkStartedAt;

      this.refreshTimestamps.set(agentName, checkResult.timestamp);
      if (!checkResult.hasChanges) {
        appLogger.debug("scan.refresh.unchanged", {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
        });
        return;
      }

      preciseChangedIds = checkResult.changedIds ?? null;
      usedIncrementalScan = Array.isArray(checkResult.changedIds);
      const scanStartedAt = performance.now();
      nextSessions = await Promise.resolve(
        agent.incrementalScan(refreshBaseline, checkResult.changedIds ?? []),
      );
      const nextBaseline = attachMissingProjectIdentities(nextSessions);
      persistenceDiff = buildRefreshDiff(
        agentName,
        refreshBaseline,
        nextBaseline,
        preciseChangedIds ?? [],
      );
      nextSessions = nextBaseline;
      scanDuration = performance.now() - scanStartedAt;
    } else {
      const scanStartedAt = performance.now();
      const result = await this.scanAgentInWorker(agent, previousSessions, null, {});
      nextSessions = result.sessions;
      agent.setSessionMetaMap?.(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      this.refreshTimestamps.set(agentName, Date.now());
    }

    nextSessions = attachMissingProjectIdentities(nextSessions);

    const filterStartedAt = performance.now();
    nextSessions = this.applyFilters(nextSessions);
    filterDuration = performance.now() - filterStartedAt;
    const diffStartedAt = performance.now();
    const diff = buildRefreshDiff(
      agentName,
      previousSessions,
      nextSessions,
      preciseChangedIds ?? [],
    );
    diffDuration = performance.now() - diffStartedAt;
    const searchIndexOptions =
      pendingPathCount >= SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD ? { isBulk: true } : undefined;
    const canPersistIncrementally = usedIncrementalScan;
    const persistentChanges = persistenceDiff?.changedSessions ?? diff.changedSessions;
    const persistentRemovedSessionIds =
      persistenceDiff?.removedSessionIds ?? diff.removedSessionIds;
    const changedSessionIds = canPersistIncrementally
      ? new Set(persistentChanges.map(({ session }) => session.id))
      : undefined;
    const cacheMeta = buildAgentCacheMeta(agent, changedSessionIds);
    const persistStartedAt = performance.now();
    const persistentJob: SearchIndexWorkerJob | null = canPersistIncrementally
      ? {
          kind: "changes",
          context: "scan.refresh",
          agentName,
          changes: persistentChanges,
          removedSessionIds: persistentRemovedSessionIds,
          meta: cacheMeta,
          ...(searchIndexOptions ? { searchIndexOptions } : {}),
        }
      : fullScanSessions
        ? {
            kind: "full",
            context: "scan.refresh",
            agentName,
            sessions: fullScanSessions,
            meta: buildAgentCacheMeta(agent),
            saveCache: true,
            ...(searchIndexOptions ? { searchIndexOptions } : {}),
          }
        : null;
    if (persistentJob) {
      persistentJobKind = persistentJob.kind;
      const persist = this.enqueueSearchIndexJobs("scan.refresh", [persistentJob]);
      if (!isInitialized && persistentJob.kind === "full") {
        await persist;
      } else {
        void persist.catch((error) => {
          appLogger.error("scan.refresh.persist.error", { agent: agentName, error });
          console.error(`[${agentName}] Session persistence failed:`, error);
        });
      }
    }
    persistDuration = performance.now() - persistStartedAt;
    const searchIndexStartedAt = performance.now();
    searchIndexDuration = performance.now() - searchIndexStartedAt;
    logSearchIndexSync("scan.refresh", null, { pending_paths: pendingPathCount });

    const event = diff.event;
    this.byAgent[agentName] = sortSessions(nextSessions);
    this.rebuildSessions();

    if (event) {
      event.totalSessions = this.sessions.length;
      this.emit(event);
    }
    appLogger.info("scan.refresh.done", {
      agent: agentName,
      duration_ms: Math.round(performance.now() - startedAt),
      sessions: nextSessions.length,
      new_sessions: event?.newSessions ?? 0,
      updated_sessions: event?.updatedSessions ?? 0,
      removed_sessions: event?.removedSessions ?? 0,
      pending_paths: pendingPathCount,
      availability_ms: Math.round(availabilityDuration),
      check_ms: Math.round(checkDuration),
      scan_ms: Math.round(scanDuration),
      filter_ms: Math.round(filterDuration),
      diff_ms: Math.round(diffDuration),
      persist_ms: Math.round(persistDuration),
      search_index_ms: Math.round(searchIndexDuration),
      persistent_index_worker_job: persistentJobKind,
      persistent_index_skipped: !persistentJob || undefined,
    });
  }
}
