import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import {
  createRegisteredAgents,
  filterSessions,
  getAgentLastFullSyncAt,
  isAgentCacheInitialized,
  loadCachedSessions,
  markAgentFullSyncCompleted,
  scanSessions,
  FileSystemSessionSource,
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  sessionSignature,
  sortSessions,
  type AgentScanProgress,
  type BaseAgent,
  type ScanResult,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHeadChange,
  type SessionHead,
} from "@codesesh/core";
import type { SearchIndexWorkerJob, SearchIndexWorkerMessage } from "./search-index-worker.js";
import type { ScanRefreshWorkerMessage } from "./scan-refresh-worker.js";
import { SessionWatcher, resolveAgentWatchTargets } from "./session-watcher.js";

export { resolveAgentWatchTargets };
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
  backfill: BackfillStatus;
}

/**
 * Full-history reconciliation runs independently of the main scan phase above:
 * startup only syncs the display window, so a low-priority background pass
 * (capped at one agent at a time) periodically re-checks the rest of history.
 */
export interface BackfillStatus {
  active: boolean;
  pendingAgents: string[];
  currentAgent?: string;
  completedAgents: string[];
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

interface AgentRefreshState {
  timer: NodeJS.Timeout | null;
  inFlight: boolean;
  pendingRerun: boolean;
  lastRefreshAt: number;
  pendingPathCount: number;
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const PENDING_REFRESH_DELAY_MS = 100;
const NEW_SESSION_EVENT_WINDOW_MS = 250;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;
/** Old files rarely change, but it's not impossible — reconcile full history at most this often. */
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

function buildRefreshDiff(
  agentName: string,
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
  candidateChangedIds: string[] = [],
): SessionRefreshDiff {
  const { changes, removedSessionIds, counts } = computeSessionDiff(
    previousSessions,
    nextSessions,
    candidateChangedIds,
    sessionSignature,
  );

  if (counts.new === 0 && counts.updated === 0 && counts.removed === 0) {
    return { event: null, changedSessions: changes, removedSessionIds };
  }

  return {
    changedSessions: changes,
    removedSessionIds,
    event: {
      type: "sessions-updated",
      changedAgents: [agentName],
      newSessions: counts.new,
      updatedSessions: counts.updated,
      removedSessions: counts.removed,
      totalSessions: nextSessions.length,
      timestamp: Date.now(),
      changedSessionHeads: changes.map(({ session }) => ({ agentName, session })),
      removedSessionRefs: removedSessionIds.map((sessionId) => ({ agentName, sessionId })),
    },
  };
}

function restoreAgentCacheMeta(agent: BaseAgent, meta: Record<string, SessionCacheMeta>): void {
  agent.setSessionMetaMap(new Map(Object.entries(meta)));
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
    backfill: { active: false, pendingAgents: [], completedAgents: [] },
  };
  private backfillQueue: string[] = [];
  private backfillRunning = false;
  private refreshStates = new Map<string, AgentRefreshState>();
  private watcher: SessionWatcher | null = null;
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

  private getRefreshState(agentName: string): AgentRefreshState {
    let state = this.refreshStates.get(agentName);
    if (!state) {
      state = {
        timer: null,
        inFlight: false,
        pendingRerun: false,
        lastRefreshAt: 0,
        pendingPathCount: 0,
      };
      this.refreshStates.set(agentName, state);
    }
    return state;
  }

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
      this.watcher = new SessionWatcher();
      this.watcher.onAgentsChanged((agentNames) => {
        for (const agentName of agentNames) {
          this.getRefreshState(agentName).pendingPathCount += 1;
          const delayMs =
            (this.byAgent[agentName]?.length ?? 0) === 0
              ? EMPTY_AGENT_REFRESH_DEBOUNCE_MS
              : REFRESH_DEBOUNCE_MS;
          this.scheduleRefresh(agentName, delayMs);
        }
      });
      this.watcher.start(this.agents.map((agent) => agent.name));
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
      for (const agent of this.agents) {
        if (this.needsBackfill(agent)) {
          this.enqueueBackfill(agent.name);
        }
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
      backfill: {
        ...this.scanStatus.backfill,
        pendingAgents: [...this.scanStatus.backfill.pendingAgents],
        completedAgents: [...this.scanStatus.backfill.completedAgents],
      },
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
    for (const state of this.refreshStates.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }

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

    if (this.watcher) {
      await this.watcher.dispose();
      this.watcher = null;
    }
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
      ...this.scanStatus,
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

  private updateBackfillStatus(patch: Partial<BackfillStatus>): void {
    this.updateScanStatus({
      ...this.scanStatus,
      backfill: { ...this.scanStatus.backfill, ...patch },
      updatedAt: Date.now(),
    });
  }

  /**
   * Only FileSystemSessionSource agents pay the O(history) enumeration cost this
   * guards against: database agents already do a cheap single-file mtime check.
   * With no startup window configured, the regular refresh path already walks
   * full history, so backfill would be redundant.
   */
  private needsBackfill(agent: BaseAgent): boolean {
    if (this.startupScanOptions.from == null && this.startupScanOptions.to == null) return false;
    if (!(agent instanceof FileSystemSessionSource)) return false;
    if (!agent.isAvailable()) return false;
    const lastSyncAt = getAgentLastFullSyncAt(agent.name);
    return lastSyncAt == null || Date.now() - lastSyncAt > BACKFILL_INTERVAL_MS;
  }

  private enqueueBackfill(agentName: string): void {
    if (
      this.backfillQueue.includes(agentName) ||
      this.scanStatus.backfill.currentAgent === agentName
    ) {
      return;
    }
    this.backfillQueue.push(agentName);
    this.updateBackfillStatus({ active: true, pendingAgents: [...this.backfillQueue] });
    this.pumpBackfillQueue();
  }

  private pumpBackfillQueue(): void {
    if (this.backfillRunning) return;
    const agentName = this.backfillQueue.shift();
    if (!agentName) return;

    this.backfillRunning = true;
    this.updateBackfillStatus({ currentAgent: agentName, pendingAgents: [...this.backfillQueue] });

    void this.runBackfill(agentName).finally(() => {
      this.backfillRunning = false;
      this.updateBackfillStatus({
        currentAgent: undefined,
        completedAgents: [...new Set([...this.scanStatus.backfill.completedAgents, agentName])],
        active: this.backfillQueue.length > 0,
      });
      this.pumpBackfillQueue();
    });
  }

  /** Unbounded per-source sync to reconcile the full session history, not just the display window. */
  private async runBackfill(agentName: string): Promise<void> {
    const startedAt = performance.now();
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent || !(agent instanceof FileSystemSessionSource) || !agent.isAvailable()) {
      return;
    }

    const cached = loadCachedSessions(agentName);
    const baseline = cached?.sessions ?? this.byAgent[agentName] ?? [];
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    if (cached) {
      restoreAgentCacheMeta(agent, cached.meta);
    }

    try {
      const result = await this.scanAgentInWorker(
        agent,
        baseline,
        null,
        {},
        { sourceSync: true, meta },
      );
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      const filtered = this.applyFilters(fullSessions);
      const diff = buildRefreshDiff(
        agentName,
        this.byAgent[agentName] ?? [],
        filtered,
        result.changedIds ?? [],
      );

      this.byAgent[agentName] = sortSessions(filtered);
      this.rebuildSessions();

      await this.enqueueSearchIndexJobs("scan.backfill", [
        {
          kind: "full",
          context: "scan.backfill",
          agentName,
          sessions: fullSessions,
          meta: buildAgentCacheMeta(agent),
          saveCache: true,
        },
      ]);
      markAgentFullSyncCompleted(agentName);

      if (diff.event) {
        diff.event.totalSessions = this.sessions.length;
        this.emit(diff.event);
      }
      appLogger.info("scan.backfill.done", {
        agent: agentName,
        duration_ms: Math.round(performance.now() - startedAt),
        sessions: fullSessions.length,
        changed: result.changedIds?.length ?? 0,
      });
    } catch (error) {
      appLogger.error("scan.backfill.error", { agent: agentName, error });
      console.error(`[${agentName}] Backfill failed:`, error);
    }
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
      this.getRefreshState(agent.name).lastRefreshAt =
        result.cacheTimestamps?.[agent.name] ?? Date.now();
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

  private scheduleRefresh(agentName: string, delayMs = REFRESH_DEBOUNCE_MS): void {
    appLogger.debug("scan.refresh.schedule", { agent: agentName, delay_ms: delayMs });
    const state = this.getRefreshState(agentName);
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }

    state.timer = setTimeout(() => {
      state.timer = null;
      void this.refreshAgent(agentName);
    }, delayMs);
  }

  private async refreshAgent(agentName: string): Promise<void> {
    const state = this.getRefreshState(agentName);
    if (state.inFlight) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      state.pendingRerun = true;
      return;
    }

    state.inFlight = true;
    this.beginAgentScan(agentName);

    try {
      await this.runRefresh(agentName);
    } catch (error) {
      appLogger.error("scan.refresh.error", { agent: agentName, error });
      console.error(`[${agentName}] Session refresh failed:`, error);
    } finally {
      state.inFlight = false;
      this.finishAgentScan(agentName);

      if (state.pendingRerun) {
        state.pendingRerun = false;
        this.scheduleRefresh(agentName, PENDING_REFRESH_DELAY_MS);
      }
    }
  }

  private async runRefresh(agentName: string): Promise<void> {
    const startedAt = performance.now();
    const state = this.getRefreshState(agentName);
    const pendingPathCount = state.pendingPathCount;
    state.pendingPathCount = 0;
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return;
    }

    const previousSessions = this.byAgent[agentName] ?? [];
    const cached = loadCachedSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? state.lastRefreshAt;
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
      state.lastRefreshAt = Date.now();
    } else if (!isInitialized) {
      // First-ever scan is bounded to the display window so startup stays fast;
      // needsBackfill() picks up the rest of history in the background.
      this.setScanPhase("initializing");
      const scanStartedAt = performance.now();
      const result = await this.scanAgentInWorker(
        agent,
        previousSessions,
        null,
        this.startupScanOptions,
      );
      nextSessions = result.sessions;
      agent.setSessionMetaMap?.(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      state.lastRefreshAt = Date.now();
    } else if (cached && agent instanceof FileSystemSessionSource) {
      // File-system agents refresh via precise per-source fingerprint sync,
      // bounded to the display window; the background backfill pass
      // periodically reconciles sessions outside it. Database agents lack
      // per-file fingerprints and fall through to the checkForChanges branch below.
      const scanStartedAt = performance.now();
      const result = await this.scanAgentInWorker(
        agent,
        cached.sessions,
        null,
        this.startupScanOptions,
        {
          sourceSync: true,
          meta: cached.meta,
        },
      );
      nextSessions = result.sessions;
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      preciseChangedIds = result.changedIds ?? [];
      usedIncrementalScan = true;
      persistenceDiff = buildRefreshDiff(
        agentName,
        cached.sessions,
        attachMissingProjectIdentities(nextSessions),
        preciseChangedIds,
      );
      scanDuration = performance.now() - scanStartedAt;
      state.lastRefreshAt = Date.now();
      if (preciseChangedIds.length === 0) {
        appLogger.debug("scan.refresh.unchanged", {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } else if (refreshBaseline.length > 0) {
      const checkStartedAt = performance.now();
      const checkResult = await Promise.resolve(
        agent.checkForChanges(cacheTimestamp, refreshBaseline),
      );
      checkDuration = performance.now() - checkStartedAt;

      state.lastRefreshAt = checkResult.timestamp;
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
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      state.lastRefreshAt = Date.now();
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
