import {
  FileSystemSessionSource,
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  computeSessionDiff,
  getAgentLastFullSyncAt,
  isAgentCacheInitialized,
  loadCachedSessions,
  markAgentFullSyncCompleted,
  sessionSignature,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type ScanResult,
  type SessionHead,
  type SessionHeadChange,
} from "@codesesh/core";
import type {
  BackfillStatus,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { ScanStatusModel } from "./scan-status-model.js";
import type { WorkerRunner } from "./worker-runner.js";

export type AgentOperationResult = "committed" | "failed" | "skipped" | "unchanged";

export interface AgentSessionsChanged {
  agentName: string;
  sessions: SessionHead[];
  event: SessionsUpdatedEvent | null;
}

export interface AgentSyncEngineOptions {
  snapshot: () => ScanResult;
  startupScanOptions?: Pick<ScanOptions, "from" | "to">;
  workerRunner: WorkerRunner;
}

type SessionsChangedListener = (change: AgentSessionsChanged) => void;
type StatusChangedListener = (event: ScanStatusEvent) => void;
type AgentOperationKind = "backfill" | "refresh";
type CachedSessions = NonNullable<ReturnType<typeof loadCachedSessions>>;

interface AgentRefreshState {
  timer: NodeJS.Timeout | null;
  timerDeadline: number;
  isRunning: boolean;
  hasPendingRerun: boolean;
  lastRefreshAt: number;
  lastRefreshDurationMs: number;
  pendingPathCount: number;
}

interface AgentOperationLifecycle {
  agentName: string;
  kind: AgentOperationKind;
  generation: number;
  startedAt: number;
}

interface SessionRefreshDiff {
  event: SessionsUpdatedEvent | null;
  changedSessions: SessionHeadChange[];
  removedSessionIds: string[];
}

interface RefreshStrategyResult {
  status: "continue" | "unchanged";
  nextSessions: SessionHead[];
  fullScanSessions: SessionHead[] | null;
  preciseChangedIds: string[] | null;
  usedIncrementalScan: boolean;
  persistenceDiff: Pick<SessionRefreshDiff, "changedSessions" | "removedSessionIds"> | null;
  checkDuration: number;
  scanDuration: number;
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const PENDING_REFRESH_DELAY_MS = 100;
const MAX_ADAPTIVE_REFRESH_DELAY_MS = 30_000;
const ADAPTIVE_REFRESH_DELAY_MULTIPLIER = 4;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;
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

function restoreAgentCacheMeta(agent: BaseAgent, cached: CachedSessions): void {
  agent.setSessionMetaMap(new Map(Object.entries(cached.meta)));
}

export class AgentSyncEngine {
  private refreshStates = new Map<string, AgentRefreshState>();
  private operationGenerations = new Map<string, number>();
  private operationTails = new Map<string, Promise<void>>();
  private backfillQueue: string[] = [];
  private currentBackfillAgent: string | undefined;
  private completedBackfillAgents: string[] = [];
  private failedBackfillAgents: string[] = [];
  private sessionsChangedListeners = new Set<SessionsChangedListener>();
  private statusChangedListeners = new Set<StatusChangedListener>();
  private scanStatus = new ScanStatusModel();
  private searchIndexJobs = new SearchIndexJobRunner();
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private readonly options: AgentSyncEngineOptions) {}

  initialize(cacheTimestamps: Record<string, number> = {}): void {
    for (const agent of this.options.snapshot().agents) {
      this.state(agent.name).lastRefreshAt = cacheTimestamps[agent.name] ?? Date.now();
    }
  }

  status(): ScanStatusEvent {
    return this.scanStatus.snapshot();
  }

  subscribeSessionsChanged(listener: SessionsChangedListener): () => void {
    this.sessionsChangedListeners.add(listener);
    return () => this.sessionsChangedListeners.delete(listener);
  }

  subscribeStatusChanged(listener: StatusChangedListener): () => void {
    this.statusChangedListeners.add(listener);
    return () => this.statusChangedListeners.delete(listener);
  }

  async syncInitialIndex(): Promise<void> {
    await this.searchIndexJobs.enqueue(
      "scan.initial",
      this.buildFullSearchIndexJobs("scan.initial"),
    );
  }

  handleAgentsChanged(agentNames: Iterable<string>): void {
    const snapshot = this.options.snapshot();
    for (const agentName of agentNames) {
      this.state(agentName).pendingPathCount += 1;
      const delayMs =
        (snapshot.byAgent[agentName]?.length ?? 0) === 0
          ? EMPTY_AGENT_REFRESH_DEBOUNCE_MS
          : REFRESH_DEBOUNCE_MS;
      this.scheduleRefresh(agentName, delayMs);
    }
  }

  startBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) return;
    const agentNames = this.options.snapshot().agents.map((agent) => agent.name);
    this.startScanBatch(agentNames, "scanning");
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null;
      for (const agentName of agentNames) this.scheduleRefresh(agentName, 0);
      if (agentNames.length === 0) this.finishScanBatch();
    }, 0);
  }

  async refresh(agentName: string): Promise<void> {
    await this.runCoalescedRefresh(agentName);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const activeOperations = {
      agent_operations: this.operationTails.size,
      refreshes: [...this.refreshStates.values()].filter((state) => state.isRunning).length,
      backfill_running: this.currentBackfillAgent != null || undefined,
      scan_workers: this.options.workerRunner.activeCount,
    };
    if (activeOperations.agent_operations > 0 || activeOperations.scan_workers > 0) {
      appLogger.warn("scan.shutdown.active_operations", activeOperations);
    }
    for (const state of this.refreshStates.values()) {
      if (!state.timer) continue;
      clearTimeout(state.timer);
      state.timer = null;
      state.timerDeadline = 0;
    }
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
    this.backfillQueue.length = 0;
    this.currentBackfillAgent = undefined;
    const searchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.started", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: searchIndexSnapshot.pendingBatches,
    });
    await this.searchIndexJobs.shutdown();
    await this.options.workerRunner.shutdown();
    await Promise.allSettled(this.operationTails.values());
    const stoppedSearchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.completed", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: stoppedSearchIndexSnapshot.pendingBatches,
    });
  }

  private startScanBatch(agentNames: string[], phase: ScanStatusEvent["phase"]): void {
    const snapshot = this.options.snapshot();
    const sessionCounts = Object.fromEntries(
      agentNames.map((agentName) => [agentName, snapshot.byAgent[agentName]?.length ?? 0]),
    );
    this.publishStatus(this.scanStatus.startBatch(agentNames, phase, sessionCounts));
  }

  private setScanPhase(phase: ScanStatusEvent["phase"]): void {
    this.publishStatus(this.scanStatus.setPhase(phase));
  }

  private beginAgentScan(agentName: string): void {
    const snapshot = this.options.snapshot();
    if (!this.scanStatus.snapshot().active) this.startScanBatch([agentName], "scanning");
    this.publishStatus(
      this.scanStatus.beginAgent(agentName, snapshot.byAgent[agentName]?.length ?? 0),
    );
  }

  private updateAgentScanProgress(agentName: string, progress: AgentScanProgress): void {
    this.publishStatus(this.scanStatus.updateAgent(agentName, progress));
  }

  private finishAgentScan(agentName: string): void {
    const count = this.options.snapshot().byAgent[agentName]?.length;
    this.publishStatus(this.scanStatus.finishAgent(agentName, count));
  }

  private finishScanBatch(): void {
    this.publishStatus(this.scanStatus.finishBatch());
  }

  private publishBackfillStatus(): void {
    this.publishStatus(this.scanStatus.updateBackfill(this.backfillStatus()));
  }

  private publishStatus(event: ScanStatusEvent | null): void {
    if (!event || this.isShuttingDown) return;
    for (const listener of this.statusChangedListeners) listener(event);
  }

  private emitSessionsChanged(change: AgentSessionsChanged): void {
    if (this.isShuttingDown) return;
    for (const listener of this.sessionsChangedListeners) listener(change);
  }

  private scheduleRefresh(agentName: string, delayMs: number): void {
    if (this.isShuttingDown) return;
    const state = this.state(agentName);
    const adaptiveDelayMs = Math.min(
      state.lastRefreshDurationMs * ADAPTIVE_REFRESH_DELAY_MULTIPLIER,
      MAX_ADAPTIVE_REFRESH_DELAY_MS,
    );
    const effectiveDelayMs = Math.max(delayMs, adaptiveDelayMs);
    const deadline = Date.now() + effectiveDelayMs;
    if (state.timer) {
      if (deadline >= state.timerDeadline) return;
      clearTimeout(state.timer);
    }
    appLogger.debug("scan.refresh.schedule", { agent: agentName, delay_ms: effectiveDelayMs });
    state.timerDeadline = deadline;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runCoalescedRefresh(agentName);
    }, effectiveDelayMs);
  }

  private async runCoalescedRefresh(agentName: string): Promise<void> {
    const state = this.state(agentName);
    if (state.isRunning) {
      appLogger.debug("scan.refresh.pending", { agent: agentName });
      state.hasPendingRerun = true;
      return;
    }
    state.isRunning = true;
    try {
      await this.serialize(agentName, "refresh", () => this.performRefresh(agentName));
    } finally {
      state.isRunning = false;
      if (state.hasPendingRerun && !this.isShuttingDown) {
        state.hasPendingRerun = false;
        this.scheduleRefresh(agentName, PENDING_REFRESH_DELAY_MS);
      }
    }
  }

  private async performRefresh(agentName: string): Promise<AgentOperationResult> {
    this.beginAgentScan(agentName);
    try {
      return await this.runRefresh(agentName);
    } catch (error) {
      appLogger.error("scan.refresh.error", { agent: agentName, error });
      console.error(`[${agentName}] Session refresh failed:`, error);
      return "failed";
    } finally {
      this.finishAgentScan(agentName);
      const agent = this.findAgent(agentName);
      if (agent && this.needsBackfill(agent)) this.enqueueBackfill(agentName);
    }
  }

  private async runRefresh(agentName: string): Promise<Exclude<AgentOperationResult, "failed">> {
    const startedAt = performance.now();
    const state = this.state(agentName);
    const pendingPathCount = state.pendingPathCount;
    state.pendingPathCount = 0;
    const agent = this.findAgent(agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return "skipped";
    }
    const previousSessions = this.options.snapshot().byAgent[agentName] ?? [];
    const cached = loadCachedSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? state.lastRefreshAt;
    if (cached) restoreAgentCacheMeta(agent, cached);
    const isInitialized = isAgentCacheInitialized(agentName);
    const availabilityStartedAt = performance.now();
    const isAvailable = agent.isAvailable();
    const availabilityDuration = performance.now() - availabilityStartedAt;
    let strategyResult: RefreshStrategyResult;
    if (!isAvailable) {
      strategyResult = this.refreshUnavailableAgent(agentName);
    } else if (!isInitialized) {
      strategyResult = await this.initializeAgent(agent, previousSessions);
    } else if (cached && agent instanceof FileSystemSessionSource) {
      strategyResult = await this.syncAgentSources(agent, cached, startedAt);
    } else if (refreshBaseline.length > 0) {
      strategyResult = await this.refreshChangedAgent(
        agent,
        refreshBaseline,
        cacheTimestamp,
        startedAt,
      );
    } else {
      strategyResult = await this.scanAgentFully(agent, previousSessions);
    }
    if (strategyResult.status === "unchanged") return "unchanged";

    const nextSessions = attachMissingProjectIdentities(strategyResult.nextSessions);
    const diffStartedAt = performance.now();
    const diff = buildRefreshDiff(
      agentName,
      previousSessions,
      nextSessions,
      strategyResult.preciseChangedIds ?? [],
    );
    const diffDuration = performance.now() - diffStartedAt;
    const searchIndexOptions =
      pendingPathCount >= SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD ? { isBulk: true } : undefined;
    const persistentChanges =
      strategyResult.persistenceDiff?.changedSessions ?? diff.changedSessions;
    const persistentRemovedSessionIds =
      strategyResult.persistenceDiff?.removedSessionIds ?? diff.removedSessionIds;
    const changedSessionIds = strategyResult.usedIncrementalScan
      ? new Set(persistentChanges.map(({ session }) => session.id))
      : undefined;
    const persistStartedAt = performance.now();
    const persistentJob: SearchIndexWorkerJob | null = strategyResult.usedIncrementalScan
      ? {
          kind: "changes",
          context: "scan.refresh",
          agentName,
          changes: persistentChanges,
          removedSessionIds: persistentRemovedSessionIds,
          meta: buildAgentCacheMeta(agent, changedSessionIds),
          ...(searchIndexOptions ? { searchIndexOptions } : {}),
        }
      : strategyResult.fullScanSessions
        ? {
            kind: "full",
            context: "scan.refresh",
            agentName,
            sessions: strategyResult.fullScanSessions,
            meta: buildAgentCacheMeta(agent),
            saveCache: true,
            ...(searchIndexOptions ? { searchIndexOptions } : {}),
          }
        : null;
    if (persistentJob) {
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
    const persistDuration = performance.now() - persistStartedAt;
    logSearchIndexSync("scan.refresh", null, { pending_paths: pendingPathCount });
    this.emitSessionsChanged({ agentName, sessions: nextSessions, event: diff.event });

    const totalDurationMs = performance.now() - startedAt;
    state.lastRefreshDurationMs = totalDurationMs;
    appLogger.info("scan.refresh.done", {
      agent: agentName,
      duration_ms: Math.round(totalDurationMs),
      sessions: nextSessions.length,
      new_sessions: diff.event?.newSessions ?? 0,
      updated_sessions: diff.event?.updatedSessions ?? 0,
      removed_sessions: diff.event?.removedSessions ?? 0,
      pending_paths: pendingPathCount,
      availability_ms: Math.round(availabilityDuration),
      check_ms: Math.round(strategyResult.checkDuration),
      scan_ms: Math.round(strategyResult.scanDuration),
      diff_ms: Math.round(diffDuration),
      persist_ms: Math.round(persistDuration),
      search_index_ms: 0,
      persistent_index_worker_job: persistentJob?.kind,
      persistent_index_skipped: !persistentJob || undefined,
    });
    return "committed";
  }

  private refreshUnavailableAgent(agentName: string): RefreshStrategyResult {
    this.state(agentName).lastRefreshAt = Date.now();
    return this.refreshStrategyResult([]);
  }

  private async initializeAgent(
    agent: BaseAgent,
    previousSessions: SessionHead[],
  ): Promise<RefreshStrategyResult> {
    this.setScanPhase("initializing");
    const scanStartedAt = performance.now();
    const result = await this.runWorker(agent, previousSessions, null, this.startupScanOptions());
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    this.state(agent.name).lastRefreshAt = Date.now();
    return this.refreshStrategyResult(sessions, {
      fullScanSessions: sessions,
      scanDuration: performance.now() - scanStartedAt,
    });
  }

  private async syncAgentSources(
    agent: FileSystemSessionSource,
    cached: CachedSessions,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const result = await this.runWorker(agent, cached.sessions, null, this.startupScanOptions(), {
      sourceSync: true,
      meta: cached.meta,
    });
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    const preciseChangedIds = result.changedIds ?? [];
    const persistenceDiff = buildRefreshDiff(
      agent.name,
      cached.sessions,
      sessions,
      preciseChangedIds,
    );
    this.state(agent.name).lastRefreshAt = Date.now();
    if (preciseChangedIds.length === 0) this.logUnchangedRefresh(agent.name, refreshStartedAt);
    return this.refreshStrategyResult(sessions, {
      preciseChangedIds,
      usedIncrementalScan: true,
      persistenceDiff,
      scanDuration: performance.now() - scanStartedAt,
    });
  }

  private async refreshChangedAgent(
    agent: BaseAgent,
    baseline: SessionHead[],
    cacheTimestamp: number,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const checkStartedAt = performance.now();
    const checkResult = await Promise.resolve(agent.checkForChanges(cacheTimestamp, baseline));
    const checkDuration = performance.now() - checkStartedAt;
    this.state(agent.name).lastRefreshAt = checkResult.timestamp;
    if (!checkResult.hasChanges) {
      this.logUnchangedRefresh(agent.name, refreshStartedAt);
      return this.refreshStrategyResult(baseline, { status: "unchanged", checkDuration });
    }
    const preciseChangedIds = checkResult.changedIds ?? null;
    const scanStartedAt = performance.now();
    const sessions = attachMissingProjectIdentities(
      await Promise.resolve(
        agent.incrementalScan(baseline, checkResult.changedIds ?? [], checkResult.refs),
      ),
    );
    return this.refreshStrategyResult(sessions, {
      preciseChangedIds,
      usedIncrementalScan: Array.isArray(checkResult.changedIds),
      persistenceDiff: buildRefreshDiff(agent.name, baseline, sessions, preciseChangedIds ?? []),
      checkDuration,
      scanDuration: performance.now() - scanStartedAt,
    });
  }

  private async scanAgentFully(
    agent: BaseAgent,
    previousSessions: SessionHead[],
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const result = await this.runWorker(agent, previousSessions, null, {});
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    this.state(agent.name).lastRefreshAt = Date.now();
    return this.refreshStrategyResult(sessions, {
      fullScanSessions: sessions,
      scanDuration: performance.now() - scanStartedAt,
    });
  }

  private refreshStrategyResult(
    nextSessions: SessionHead[],
    overrides: Partial<Omit<RefreshStrategyResult, "nextSessions">> = {},
  ): RefreshStrategyResult {
    return {
      status: "continue",
      nextSessions,
      fullScanSessions: null,
      preciseChangedIds: null,
      usedIncrementalScan: false,
      persistenceDiff: null,
      checkDuration: 0,
      scanDuration: 0,
      ...overrides,
    };
  }

  private runWorker(
    agent: BaseAgent,
    previousSessions: SessionHead[],
    changedIds: string[] | null,
    scanOptions: Pick<ScanOptions, "from" | "to" | "fast">,
    workerOptions: { sourceSync?: boolean; meta?: CachedSessions["meta"] } = {},
  ) {
    return this.options.workerRunner.run(agent.name, {
      previousSessions,
      changedIds,
      scanOptions,
      sourceSync: workerOptions.sourceSync,
      meta: workerOptions.meta ?? buildAgentCacheMeta(agent),
      onProgress: (progress) => this.updateAgentScanProgress(agent.name, progress),
    });
  }

  private needsBackfill(agent: BaseAgent): boolean {
    const startupScanOptions = this.startupScanOptions();
    if (startupScanOptions.from == null && startupScanOptions.to == null) return false;
    if (!agent.isAvailable()) return false;
    const lastSyncAt = getAgentLastFullSyncAt(agent.name);
    return lastSyncAt == null || Date.now() - lastSyncAt > BACKFILL_INTERVAL_MS;
  }

  private enqueueBackfill(agentName: string): void {
    if (
      this.isShuttingDown ||
      this.currentBackfillAgent === agentName ||
      this.backfillQueue.includes(agentName)
    ) {
      return;
    }
    this.backfillQueue.push(agentName);
    this.publishBackfillStatus();
    this.pumpBackfillQueue();
  }

  private pumpBackfillQueue(): void {
    if (this.isShuttingDown || this.currentBackfillAgent) return;
    const agentName = this.backfillQueue.shift();
    if (!agentName) return;
    this.currentBackfillAgent = agentName;
    this.publishBackfillStatus();
    void this.serialize(agentName, "backfill", () => this.performBackfill(agentName)).then(
      (result) => {
        if (this.isShuttingDown) return;
        this.currentBackfillAgent = undefined;
        if (result === "committed") {
          if (!this.completedBackfillAgents.includes(agentName)) {
            this.completedBackfillAgents.push(agentName);
          }
          this.failedBackfillAgents = this.failedBackfillAgents.filter(
            (failedAgent) => failedAgent !== agentName,
          );
        } else if (!this.failedBackfillAgents.includes(agentName)) {
          this.failedBackfillAgents.push(agentName);
        }
        this.publishBackfillStatus();
        this.pumpBackfillQueue();
      },
    );
  }

  private async performBackfill(agentName: string): Promise<AgentOperationResult> {
    const startedAt = performance.now();
    const agent = this.findAgent(agentName);
    if (!agent || !agent.isAvailable()) return "skipped";
    const snapshot = this.options.snapshot();
    const cached = loadCachedSessions(agentName);
    const baseline = cached?.sessions ?? snapshot.byAgent[agentName] ?? [];
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    if (cached) restoreAgentCacheMeta(agent, cached);
    try {
      const result = await this.runWorker(
        agent,
        baseline,
        null,
        {},
        {
          sourceSync: agent instanceof FileSystemSessionSource,
          meta,
        },
      );
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      const diff = buildRefreshDiff(
        agentName,
        snapshot.byAgent[agentName] ?? [],
        fullSessions,
        result.changedIds ?? [],
      );
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
      this.emitSessionsChanged({ agentName, sessions: fullSessions, event: diff.event });
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

  private serialize(
    agentName: string,
    kind: AgentOperationKind,
    operation: () => Promise<AgentOperationResult>,
  ): Promise<AgentOperationResult> {
    const previous = this.operationTails.get(agentName) ?? Promise.resolve();
    const run = previous.then(async () => {
      if (this.isShuttingDown) return "skipped";
      const lifecycle = this.beginOperation(agentName, kind);
      try {
        const result = await operation();
        this.completeOperation(lifecycle, result);
        return result;
      } catch (error) {
        this.completeOperation(lifecycle, "failed");
        throw error;
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(agentName, tail);
    void tail.finally(() => {
      if (this.operationTails.get(agentName) === tail) this.operationTails.delete(agentName);
    });
    return run;
  }

  private state(agentName: string): AgentRefreshState {
    const existing = this.refreshStates.get(agentName);
    if (existing) return existing;
    const state: AgentRefreshState = {
      timer: null,
      timerDeadline: 0,
      isRunning: false,
      hasPendingRerun: false,
      lastRefreshAt: 0,
      lastRefreshDurationMs: 0,
      pendingPathCount: 0,
    };
    this.refreshStates.set(agentName, state);
    return state;
  }

  private beginOperation(agentName: string, kind: AgentOperationKind): AgentOperationLifecycle {
    const generation = (this.operationGenerations.get(agentName) ?? 0) + 1;
    const startedAt = Date.now();
    this.operationGenerations.set(agentName, generation);
    appLogger.info("scan.agent_operation.started", {
      agent: agentName,
      operation: kind,
      generation,
      started_at: startedAt,
    });
    return { agentName, kind, generation, startedAt };
  }

  private completeOperation(
    lifecycle: AgentOperationLifecycle,
    result: AgentOperationResult,
  ): void {
    const completedAt = Date.now();
    appLogger.info("scan.agent_operation.completed", {
      agent: lifecycle.agentName,
      operation: lifecycle.kind,
      generation: lifecycle.generation,
      started_at: lifecycle.startedAt,
      completed_at: completedAt,
      duration_ms: completedAt - lifecycle.startedAt,
      result,
    });
  }

  private backfillStatus(): BackfillStatus {
    return {
      active: this.currentBackfillAgent != null || this.backfillQueue.length > 0,
      pendingAgents: [...this.backfillQueue],
      currentAgent: this.currentBackfillAgent,
      completedAgents: [...this.completedBackfillAgents],
      failedAgents: [...this.failedBackfillAgents],
    };
  }

  private buildFullSearchIndexJobs(context: string): SearchIndexWorkerJob[] {
    const snapshot = this.options.snapshot();
    return snapshot.agents.map((agent) => {
      const cached = loadCachedSessions(agent.name);
      return cached
        ? {
            kind: "full",
            context,
            agentName: agent.name,
            sessions: cached.sessions,
            meta: cached.meta,
          }
        : {
            kind: "full",
            context,
            agentName: agent.name,
            sessions: snapshot.byAgent[agent.name] ?? [],
            meta: buildAgentCacheMeta(agent),
          };
    });
  }

  private findAgent(agentName: string): BaseAgent | undefined {
    return this.options.snapshot().agents.find((agent) => agent.name === agentName);
  }

  private startupScanOptions(): Pick<ScanOptions, "from" | "to"> {
    return this.options.startupScanOptions ?? {};
  }

  private logUnchangedRefresh(agentName: string, startedAt: number): void {
    appLogger.debug("scan.refresh.unchanged", {
      agent: agentName,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  }
}
