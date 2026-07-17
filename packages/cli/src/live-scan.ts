import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createRegisteredAgents,
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
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import { ScanStatusModel } from "./scan-status-model.js";
import { BackfillCoordinator } from "./backfill-coordinator.js";
import { RefreshCoordinator, type AgentOperationResult } from "./refresh-coordinator.js";
import { SessionWatcher, resolveAgentWatchTargets } from "./session-watcher.js";
import { ThreadWorkerRunner, type WorkerRunner } from "./worker-runner.js";

export { resolveAgentWatchTargets };
import { appLogger, logSearchIndexSync } from "./logging.js";
import type {
  AgentScanStatus,
  BackfillStatus,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";

export type { AgentScanStatus, BackfillStatus, ScanStatusEvent, SessionsUpdatedEvent };

type StoreListener = (event: SessionsUpdatedEvent) => void;
type ScanStatusListener = (event: ScanStatusEvent) => void;

interface SessionRefreshDiff {
  event: SessionsUpdatedEvent | null;
  changedSessions: SessionHeadChange[];
  removedSessionIds: string[];
}

interface LiveScanStoreOptions {
  deferInitialRefresh?: boolean;
  workerRunner?: WorkerRunner;
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
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
  private scanStatus = new ScanStatusModel();
  private backfills = new BackfillCoordinator();
  private refreshes = new RefreshCoordinator();
  private watcher: SessionWatcher | null = null;
  private pendingEvent: SessionsUpdatedEvent | null = null;
  private pendingEventTimer: NodeJS.Timeout | null = null;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private workerRunner: WorkerRunner;
  private searchIndexJobs = new SearchIndexJobRunner();
  private shutdownPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    private readonly watchEnabled = true,
    private readonly scanOptions: ScanOptions = {},
    private readonly startupScanOptions: Pick<ScanOptions, "from" | "to"> = {},
    private readonly storeOptions: LiveScanStoreOptions = {},
  ) {
    this.workerRunner =
      storeOptions.workerRunner ??
      new ThreadWorkerRunner(new URL("./scan-refresh-worker.js", import.meta.url));
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
      await this.searchIndexJobs.enqueue(
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
          this.refreshes.recordChangedPaths(agentName);
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
    return this.scanStatus.snapshot();
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

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.shuttingDown = true;
    const activeOperations = {
      agent_operations: this.refreshes.activeOperationCount,
      refreshes: this.refreshes.activeRefreshCount,
      backfill_running: this.backfills.isRunning || undefined,
      scan_workers: this.workerRunner.activeCount,
    };
    if (activeOperations.agent_operations > 0 || activeOperations.scan_workers > 0) {
      appLogger.warn("scan.shutdown.active_operations", activeOperations);
    }
    const searchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.started", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: searchIndexSnapshot.pendingBatches,
    });
    if (this.pendingEventTimer) {
      clearTimeout(this.pendingEventTimer);
      this.pendingEventTimer = null;
    }
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
    this.backfills.clear();
    await this.searchIndexJobs.shutdown();
    await this.workerRunner.shutdown();
    await this.refreshes.shutdown();
    this.pendingEvent = null;

    if (this.watcher) {
      await this.watcher.dispose();
      this.watcher = null;
    }
    const stoppedSearchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.completed", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: stoppedSearchIndexSnapshot.pendingBatches,
    });
  }

  private emit(event: SessionsUpdatedEvent): void {
    if (this.shuttingDown) return;
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

  private startScanBatch(agentNames: string[], phase: ScanStatusEvent["phase"]): void {
    const sessionCounts = Object.fromEntries(
      agentNames.map((agentName) => [agentName, this.byAgent[agentName]?.length ?? 0]),
    );
    this.publishScanStatus(this.scanStatus.startBatch(agentNames, phase, sessionCounts));
  }

  private setScanPhase(phase: ScanStatusEvent["phase"]): void {
    this.publishScanStatus(this.scanStatus.setPhase(phase));
  }

  private beginAgentScan(agentName: string): void {
    if (!this.scanStatus.snapshot().active) this.startScanBatch([agentName], "scanning");
    this.publishScanStatus(
      this.scanStatus.beginAgent(agentName, this.byAgent[agentName]?.length ?? 0),
    );
  }

  private updateAgentScanProgress(agentName: string, progress: AgentScanProgress): void {
    this.publishScanStatus(this.scanStatus.updateAgent(agentName, progress));
  }

  private finishAgentScan(agentName: string): void {
    this.publishScanStatus(this.scanStatus.finishAgent(agentName, this.byAgent[agentName]?.length));
  }

  private finishScanBatch(): void {
    this.publishScanStatus(this.scanStatus.finishBatch());
  }

  private updateBackfillStatus(patch: Partial<BackfillStatus>): void {
    this.publishScanStatus(this.scanStatus.updateBackfill(patch));
  }

  private publishScanStatus(event: ScanStatusEvent | null): void {
    if (!event || this.shuttingDown) return;
    for (const listener of this.scanStatusListeners) listener(event);
  }

  /**
   * With no startup window configured, the regular refresh path already walks
   * full history, so backfill would be redundant.
   */
  private needsBackfill(agent: BaseAgent): boolean {
    if (this.startupScanOptions.from == null && this.startupScanOptions.to == null) return false;
    if (!agent.isAvailable()) return false;
    const lastSyncAt = getAgentLastFullSyncAt(agent.name);
    return lastSyncAt == null || Date.now() - lastSyncAt > BACKFILL_INTERVAL_MS;
  }

  private enqueueBackfill(agentName: string): void {
    if (this.shuttingDown) return;
    const status = this.backfills.enqueue(agentName);
    if (!status) return;
    this.updateBackfillStatus(status);
    this.pumpBackfillQueue();
  }

  private pumpBackfillQueue(): void {
    if (this.shuttingDown) return;
    const work = this.backfills.take();
    if (!work) return;
    this.updateBackfillStatus(work.status);

    void this.runBackfill(work.agentName).then((result) => {
      if (this.shuttingDown) return;
      this.updateBackfillStatus(this.backfills.complete(work.agentName, result === "committed"));
      this.pumpBackfillQueue();
    });
  }

  /** Unbounded per-source sync to reconcile the full session history, not just the display window. */
  private runBackfill(agentName: string): Promise<AgentOperationResult> {
    return this.refreshes.serialize(agentName, "backfill", () => this.performBackfill(agentName));
  }

  private async performBackfill(agentName: string): Promise<AgentOperationResult> {
    const startedAt = performance.now();
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent || !agent.isAvailable()) {
      return "skipped";
    }

    const cached = loadCachedSessions(agentName);
    const baseline = cached?.sessions ?? this.byAgent[agentName] ?? [];
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    if (cached) {
      restoreAgentCacheMeta(agent, cached.meta);
    }

    try {
      const result = await this.workerRunner.run(agent.name, {
        previousSessions: baseline,
        changedIds: null,
        scanOptions: {},
        sourceSync: agent instanceof FileSystemSessionSource,
        meta,
        onProgress: (progress) => this.updateAgentScanProgress(agent.name, progress),
      });
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      const diff = buildRefreshDiff(
        agentName,
        this.byAgent[agentName] ?? [],
        fullSessions,
        result.changedIds ?? [],
      );

      this.byAgent[agentName] = sortSessions(fullSessions);
      this.rebuildSessions();

      await this.searchIndexJobs.enqueue("scan.backfill", [
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
      return "committed";
    } catch (error) {
      appLogger.error("scan.backfill.error", { agent: agentName, error });
      console.error(`[${agentName}] Backfill failed:`, error);
      return "failed";
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

  private getSmartTagWorkerUrl(): URL | null {
    const workerUrl = new URL("./smart-tag-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) {
      return null;
    }
    return workerUrl;
  }

  private runWorker(
    agent: BaseAgent,
    previousSessions: SessionHead[],
    changedIds: string[] | null,
    scanOptions: Pick<ScanOptions, "from" | "to" | "fast">,
    workerOptions: { sourceSync?: boolean; meta?: Record<string, SessionCacheMeta> } = {},
  ) {
    return this.workerRunner.run(agent.name, {
      previousSessions,
      changedIds,
      scanOptions,
      sourceSync: workerOptions.sourceSync,
      meta: workerOptions.meta ?? buildAgentCacheMeta(agent),
      onProgress: (progress) => this.updateAgentScanProgress(agent.name, progress),
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
      this.refreshes.setLastRefreshAt(
        agent.name,
        result.cacheTimestamps?.[agent.name] ?? Date.now(),
      );
    }

    this.rebuildSessions();
  }

  private getAllowedAgents(): Set<string> | null {
    if (!this.scanOptions.agents?.length) {
      return null;
    }
    return new Set(this.scanOptions.agents.map((agent) => agent.toLowerCase()));
  }

  /**
   * Throttles rather than debounces: a pending timer only gets replaced by a
   * request with an earlier deadline. Plain debounce (reset on every call)
   * would let a steady stream of events — each arriving before the adaptive
   * backoff elapses — push the deadline out forever and starve the refresh.
   */
  private scheduleRefresh(agentName: string, delayMs = REFRESH_DEBOUNCE_MS): void {
    this.refreshes.schedule(agentName, delayMs, () => this.refreshAgent(agentName));
  }

  private async refreshAgent(agentName: string): Promise<void> {
    await this.refreshes.runRefresh(agentName, async () => {
      this.beginAgentScan(agentName);
      try {
        return await this.runRefresh(agentName);
      } catch (error) {
        appLogger.error("scan.refresh.error", { agent: agentName, error });
        console.error(`[${agentName}] Session refresh failed:`, error);
        return "failed";
      } finally {
        this.finishAgentScan(agentName);
        const agent = this.agents.find((item) => item.name === agentName);
        if (agent && this.needsBackfill(agent)) this.enqueueBackfill(agentName);
      }
    });
  }

  private async runRefresh(agentName: string): Promise<Exclude<AgentOperationResult, "failed">> {
    const startedAt = performance.now();
    const pendingPathCount = this.refreshes.takePendingPathCount(agentName);
    const agent = this.agents.find((item) => item.name === agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return "skipped";
    }

    const previousSessions = this.byAgent[agentName] ?? [];
    const cached = loadCachedSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? this.refreshes.lastRefreshAt(agentName);
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
    let diffDuration = 0;
    let persistDuration = 0;
    let searchIndexDuration = 0;
    let persistentJobKind: SearchIndexWorkerJob["kind"] | undefined;

    const availabilityStartedAt = performance.now();
    const isAvailable = agent.isAvailable();
    availabilityDuration = performance.now() - availabilityStartedAt;

    if (!isAvailable) {
      nextSessions = [];
      this.refreshes.setLastRefreshAt(agentName, Date.now());
    } else if (!isInitialized) {
      // First-ever scan is bounded to the display window so startup stays fast;
      // needsBackfill() picks up the rest of history in the background.
      this.setScanPhase("initializing");
      const scanStartedAt = performance.now();
      const result = await this.runWorker(agent, previousSessions, null, this.startupScanOptions);
      nextSessions = result.sessions;
      agent.setSessionMetaMap?.(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      this.refreshes.setLastRefreshAt(agentName, Date.now());
    } else if (cached && agent instanceof FileSystemSessionSource) {
      // File-system agents refresh via precise per-source fingerprint sync,
      // bounded to the display window; the background backfill pass
      // periodically reconciles sessions outside it. Database agents lack
      // per-file fingerprints and fall through to the checkForChanges branch below.
      const scanStartedAt = performance.now();
      const result = await this.runWorker(agent, cached.sessions, null, this.startupScanOptions, {
        sourceSync: true,
        meta: cached.meta,
      });
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
      this.refreshes.setLastRefreshAt(agentName, Date.now());
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

      this.refreshes.setLastRefreshAt(agentName, checkResult.timestamp);
      if (!checkResult.hasChanges) {
        appLogger.debug("scan.refresh.unchanged", {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
        });
        return "unchanged";
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
      const result = await this.runWorker(agent, previousSessions, null, {});
      nextSessions = result.sessions;
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      fullScanSessions = attachMissingProjectIdentities(nextSessions);
      nextSessions = fullScanSessions;
      scanDuration = performance.now() - scanStartedAt;
      this.refreshes.setLastRefreshAt(agentName, Date.now());
    }

    nextSessions = attachMissingProjectIdentities(nextSessions);

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
      const persist = this.searchIndexJobs.enqueue("scan.refresh", [persistentJob]);
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
    const totalDurationMs = performance.now() - startedAt;
    this.refreshes.setLastRefreshDuration(agentName, totalDurationMs);
    appLogger.info("scan.refresh.done", {
      agent: agentName,
      duration_ms: Math.round(totalDurationMs),
      sessions: nextSessions.length,
      new_sessions: event?.newSessions ?? 0,
      updated_sessions: event?.updatedSessions ?? 0,
      removed_sessions: event?.removedSessions ?? 0,
      pending_paths: pendingPathCount,
      availability_ms: Math.round(availabilityDuration),
      check_ms: Math.round(checkDuration),
      scan_ms: Math.round(scanDuration),
      diff_ms: Math.round(diffDuration),
      persist_ms: Math.round(persistDuration),
      search_index_ms: Math.round(searchIndexDuration),
      persistent_index_worker_job: persistentJobKind,
      persistent_index_skipped: !persistentJob || undefined,
    });
    return "committed";
  }
}
