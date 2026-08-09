import {
  FileSystemSessionSource,
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  getAgentFullSyncCursor,
  computeSessionDiff,
  getAgentLastFullSyncAt,
  isAgentCacheInitialized,
  loadCachedSessions,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  sessionSignature,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type LiveSnapshot,
  type SessionHead,
  type SessionHeadChange,
  type SessionSourceFailure,
  type SessionSnapshotCompleteness,
} from "@codesesh/core";
import type { ScanStatusEvent, SessionsUpdatedEvent } from "@codesesh/core/contract";
import { AgentOperationScheduler, type AgentOperationResult } from "./agent-operation-scheduler.js";
import {
  BackfillLifecycle,
  type BackfillAttemptRef,
  type BackfillTerminalStatus,
} from "./backfill-lifecycle.js";
import { LiveSessionIndex, type LiveSessionIndexOptions } from "./live-session-index.js";
import { LatestValueThrottle } from "./latest-value-throttle.js";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { ScanStatusModel } from "./scan-status-model.js";
import type { WorkerRunner } from "./worker-runner.js";
import { toError } from "./errors.js";

export type { AgentOperationResult } from "./agent-operation-scheduler.js";

export interface AgentSessionsChanged {
  agentName: string;
  sessions: SessionHead[];
  event: SessionsUpdatedEvent | null;
}

export interface AgentSyncEngineOptions {
  startupScanOptions?: Pick<ScanOptions, "from" | "to">;
  workerRunner: WorkerRunner;
}

export interface AgentSyncEngineInitializationOptions extends LiveSessionIndexOptions {
  cacheTimestamps?: Record<string, number>;
}

type SessionsChangedListener = (change: AgentSessionsChanged) => void;
type StatusChangedListener = (event: ScanStatusEvent) => void;
type CachedSessions = NonNullable<ReturnType<typeof loadCachedSessions>>;

interface SessionPersistenceDiff {
  changedSessions: SessionHeadChange[];
  removedSessionIds: string[];
}

interface SessionPublication {
  context: "scan.refresh" | "scan.backfill";
  agentName: string;
  sessions: SessionHead[];
  candidateChangedIds: string[];
  indexJob: SearchIndexWorkerJob;
}

interface SessionPublicationResult {
  event: SessionsUpdatedEvent | null;
  diffDuration: number;
}

interface RefreshStrategyResult {
  status: "continue" | "unchanged";
  nextSessions: SessionHead[];
  fullScanSessions: SessionHead[] | null;
  preciseChangedIds: string[] | null;
  persistenceDiff: SessionPersistenceDiff | null;
  checkDuration: number;
  scanDuration: number;
  sourceFailures: SessionSourceFailure[];
  completeness: SessionSnapshotCompleteness;
  scope: Pick<ScanOptions, "from" | "to">;
  explicitRemovedSessionIds: string[];
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_TRUNCATION_COVERAGE = 0.5;
const STATUS_PROGRESS_INTERVAL_MS = 100;

function buildPersistenceDiff(
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
  candidateChangedIds: string[] = [],
): SessionPersistenceDiff {
  const { changes, removedSessionIds } = computeSessionDiff(
    previousSessions,
    nextSessions,
    candidateChangedIds,
    sessionSignature,
  );
  return { changedSessions: changes, removedSessionIds };
}

function sourceFailureError(failures: SessionSourceFailure[]): Error {
  const noun = failures.length === 1 ? "source" : "sources";
  return new Error(`${failures.length} session ${noun} failed; last-known-good data retained`);
}

function restoreAgentCacheMeta(agent: BaseAgent, cached: CachedSessions): void {
  agent.setSessionMetaMap(new Map(Object.entries(cached.meta)));
}

export class AgentSyncEngine {
  private lastRefreshAtByAgent = new Map<string, number>();
  private readonly scheduler: AgentOperationScheduler;
  private readonly sessionIndex = new LiveSessionIndex();
  private readonly backfills = new BackfillLifecycle();
  private cacheIntegrityCheckedAgents = new Set<string>();
  private sessionsChangedListeners = new Set<SessionsChangedListener>();
  private statusChangedListeners = new Set<StatusChangedListener>();
  private statusProgressThrottles = new Map<string, LatestValueThrottle<void>>();
  private scanStatus = new ScanStatusModel();
  private searchIndexJobs = new SearchIndexJobRunner();
  private nextPublicationId = 1;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private readonly options: AgentSyncEngineOptions) {
    this.scheduler = new AgentOperationScheduler((agentName) => this.performRefresh(agentName));
  }

  initialize(snapshot: LiveSnapshot, options: AgentSyncEngineInitializationOptions = {}): void {
    this.sessionIndex.initialize(snapshot, options);
    this.lastRefreshAtByAgent.clear();
    for (const agent of this.sessionIndex.snapshot().agents) {
      this.lastRefreshAtByAgent.set(
        agent.name,
        options.cacheTimestamps?.[agent.name] ?? Date.now(),
      );
    }
    for (const [agentName, failure] of Object.entries(snapshot.scanFailures ?? {})) {
      this.scanStatus.failAgent(
        agentName,
        `${failure.stage}: ${failure.message}`,
        snapshot.byAgent[agentName]?.length ?? 0,
      );
    }
  }

  snapshot(): LiveSnapshot {
    return this.sessionIndex.snapshot();
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
    const jobs = this.buildFullSearchIndexJobs("scan.initial");
    await this.commitSearchIndex("scan.initial", jobs, {
      publicationId: this.publicationId("scan.initial"),
      agents: jobs.map((job) => job.agentName),
    });
  }

  handleAgentsChanged(agentNames: Iterable<string>): void {
    const snapshot = this.sessionIndex.snapshot();
    for (const agentName of agentNames) {
      const delayMs =
        (snapshot.byAgent[agentName]?.length ?? 0) === 0
          ? EMPTY_AGENT_REFRESH_DEBOUNCE_MS
          : REFRESH_DEBOUNCE_MS;
      this.scheduler.notify(agentName, delayMs);
    }
  }

  startBackgroundRefresh(): void {
    if (this.backgroundRefreshTimer) return;
    const agentNames = this.sessionIndex.snapshot().agents.map((agent) => agent.name);
    this.startScanBatch(agentNames, "scanning");
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null;
      for (const agentName of agentNames) this.scheduler.schedule(agentName, 0);
      if (agentNames.length === 0) this.finishScanBatch();
    }, 0);
  }

  async refresh(agentName: string): Promise<void> {
    await this.scheduler.refresh(agentName);
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const schedulerSnapshot = this.scheduler.snapshot();
    const activeOperations = {
      agent_operations: schedulerSnapshot.activeOperations,
      refreshes: schedulerSnapshot.activeRefreshes,
      backfill_running: this.backfills.runningAttempt()?.agentName || undefined,
      scan_workers: this.options.workerRunner.activeCount,
    };
    if (activeOperations.agent_operations > 0 || activeOperations.scan_workers > 0) {
      appLogger.warn("scan.shutdown.active_operations", activeOperations);
    }
    this.scheduler.stop();
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
    this.backfills.cancelAll();
    this.cancelProgressStatuses();
    this.cacheIntegrityCheckedAgents.clear();
    const searchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.started", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: searchIndexSnapshot.pendingBatches,
    });
    await this.searchIndexJobs.shutdown();
    await this.options.workerRunner.shutdown();
    await this.scheduler.waitForIdle();
    const stoppedSearchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.completed", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: stoppedSearchIndexSnapshot.pendingBatches,
    });
  }

  private startScanBatch(agentNames: string[], phase: ScanStatusEvent["phase"]): void {
    const snapshot = this.sessionIndex.snapshot();
    const sessionCounts = Object.fromEntries(
      agentNames.map((agentName) => [agentName, snapshot.byAgent[agentName]?.length ?? 0]),
    );
    this.publishStatus(this.scanStatus.startBatch(agentNames, phase, sessionCounts));
  }

  private setScanPhase(phase: ScanStatusEvent["phase"]): void {
    this.publishStatus(this.scanStatus.setPhase(phase));
  }

  private beginAgentScan(agentName: string): void {
    this.cancelProgressStatus(`scan:${agentName}`);
    const snapshot = this.sessionIndex.snapshot();
    if (!this.scanStatus.snapshot().active) this.startScanBatch([agentName], "scanning");
    this.publishStatus(
      this.scanStatus.beginAgent(agentName, snapshot.byAgent[agentName]?.length ?? 0),
    );
  }

  private updateAgentScanProgress(
    agentName: string,
    progress: AgentScanProgress,
    backfillAttempt?: BackfillAttemptRef,
  ): void {
    if (backfillAttempt) {
      const key = `backfill:${agentName}`;
      const current = this.backfills.stateFor(agentName);
      if (current?.status !== "running" || current.attemptId !== backfillAttempt.attemptId) {
        return;
      }
      const currentPhase = current.progress?.phase ?? "scanning";
      const nextPhase = progress.phase ?? "scanning";
      if (currentPhase && currentPhase !== nextPhase) this.flushProgressStatus(key);
      if (
        this.backfills.updateProgress(backfillAttempt, {
          phase: progress.phase,
          total: progress.total,
          processed: progress.processed,
          sessions: progress.sessions,
        })
      ) {
        this.publishProgressStatus(
          key,
          nextPhase,
          this.scanStatus.updateBackfill(this.backfills.status()),
        );
      }
      return;
    }
    const key = `scan:${agentName}`;
    const currentPhase = this.scanStatus.snapshot().agentStatuses[agentName]?.status;
    const nextPhase = progress.phase === "finalizing" ? "finalizing" : "scanning";
    if (currentPhase && currentPhase !== nextPhase) this.flushProgressStatus(key);
    const status = this.scanStatus.updateAgent(agentName, progress);
    this.publishProgressStatus(key, status?.agentStatuses[agentName]?.status ?? nextPhase, status);
  }

  private beginAgentIndexing(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.indexAgent(agentName));
  }

  private finishAgentScan(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    const count = this.sessionIndex.snapshot().byAgent[agentName]?.length;
    this.publishStatus(this.scanStatus.finishAgent(agentName, count));
  }

  private finishScanBatch(): void {
    this.flushProgressStatuses("scan:");
    this.publishStatus(this.scanStatus.finishBatch());
  }

  private publishBackfillStatus(): void {
    this.publishStatus(this.scanStatus.updateBackfill(this.backfills.status()));
  }

  private publishStatus(event: ScanStatusEvent | null): void {
    if (!event || this.isShuttingDown) return;
    for (const listener of this.statusChangedListeners) listener(event);
  }

  private publishProgressStatus(key: string, phase: string, event: ScanStatusEvent | null): void {
    if (!event) return;
    let throttle = this.statusProgressThrottles.get(key);
    if (!throttle) {
      throttle = new LatestValueThrottle<void>(STATUS_PROGRESS_INTERVAL_MS, () => {
        this.publishStatus(this.scanStatus.snapshot());
      });
      this.statusProgressThrottles.set(key, throttle);
    }
    throttle.push(undefined, phase);
  }

  private flushProgressStatus(key: string): void {
    const throttle = this.statusProgressThrottles.get(key);
    if (!throttle) return;
    throttle.flush();
    throttle.cancel();
    this.statusProgressThrottles.delete(key);
  }

  private cancelProgressStatus(key: string): void {
    const throttle = this.statusProgressThrottles.get(key);
    if (!throttle) return;
    throttle.cancel();
    this.statusProgressThrottles.delete(key);
  }

  private flushProgressStatuses(prefix: string): void {
    for (const key of this.statusProgressThrottles.keys()) {
      if (key.startsWith(prefix)) this.flushProgressStatus(key);
    }
  }

  private cancelProgressStatuses(): void {
    for (const throttle of this.statusProgressThrottles.values()) throttle.cancel();
    this.statusProgressThrottles.clear();
  }

  private emitSessionsChanged(change: AgentSessionsChanged): void {
    if (this.isShuttingDown) return;
    for (const listener of this.sessionsChangedListeners) listener(change);
  }

  private async performRefresh(agentName: string): Promise<AgentOperationResult> {
    this.beginAgentScan(agentName);
    let failed = false;
    try {
      return await this.runRefresh(agentName);
    } catch (error) {
      this.options.workerRunner.discard?.(agentName);
      failed = true;
      const failure = toError(error);
      appLogger.error("scan.refresh.error", { agent: agentName, error });
      console.error(`[${agentName}] Session refresh failed:`, error);
      this.flushProgressStatus(`scan:${agentName}`);
      this.publishStatus(this.scanStatus.failAgent(agentName, failure.message));
      return "failed";
    } finally {
      if (!failed) this.finishAgentScan(agentName);
      const agent = this.findAgent(agentName);
      if (agent && this.needsBackfill(agent)) this.enqueueBackfill(agentName);
    }
  }

  private async runRefresh(agentName: string): Promise<Exclude<AgentOperationResult, "failed">> {
    const startedAt = performance.now();
    const pendingPathCount = this.scheduler.takePendingSignalCount(agentName);
    const agent = this.findAgent(agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return "skipped";
    }
    const previousSessions = this.sessionIndex.snapshot().byAgent[agentName] ?? [];
    const cached = loadCachedSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? this.lastRefreshAtByAgent.get(agentName) ?? 0;
    if (cached) restoreAgentCacheMeta(agent, cached);
    const durableMeta = new Map(agent.getSessionMetaMap());
    const durableLastRefreshAt = this.lastRefreshAtByAgent.get(agentName);
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
    if (strategyResult.status === "unchanged") {
      this.options.workerRunner.commit?.(agentName);
      return "unchanged";
    }

    const nextSessions = attachMissingProjectIdentities(strategyResult.nextSessions);
    const searchIndexOptions =
      pendingPathCount >= SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD ? { isBulk: true } : undefined;
    const persistenceDiff = strategyResult.persistenceDiff;
    const publicationSessions = strategyResult.fullScanSessions ?? nextSessions;
    const publicationSessionIds = new Set(publicationSessions.map((session) => session.id));
    const missingBaselineSessions = refreshBaseline.reduce(
      (count, session) => count + Number(!publicationSessionIds.has(session.id)),
      0,
    );
    const replacementDeleteCandidates = persistenceDiff
      ? persistenceDiff.removedSessionIds.length
      : strategyResult.completeness === "complete"
        ? missingBaselineSessions
        : strategyResult.explicitRemovedSessionIds.length;
    appLogger.info("scan.refresh.persistence_candidate", {
      agent: agentName,
      scope_from: strategyResult.scope.from,
      scope_to: strategyResult.scope.to,
      publication_completeness: strategyResult.completeness,
      durable_baseline_sessions: refreshBaseline.length,
      payload_sessions: publicationSessions.length,
      delete_candidates: replacementDeleteCandidates,
    });
    const changedSessionIds = persistenceDiff
      ? new Set(persistenceDiff.changedSessions.map(({ session }) => session.id))
      : undefined;
    const persistStartedAt = performance.now();
    const persistentJob: SearchIndexWorkerJob = persistenceDiff
      ? {
          kind: "changes",
          context: "scan.refresh",
          agentName,
          changes: persistenceDiff.changedSessions,
          removedSessionIds: persistenceDiff.removedSessionIds,
          meta: buildAgentCacheMeta(agent, changedSessionIds),
          ...(searchIndexOptions ? { searchIndexOptions } : {}),
        }
      : {
          kind: "full",
          context: "scan.refresh",
          agentName,
          sessions: publicationSessions,
          meta: buildAgentCacheMeta(agent),
          completeness: strategyResult.completeness,
          removedSessionIds: strategyResult.explicitRemovedSessionIds,
          saveCache: true,
          ...(searchIndexOptions ? { searchIndexOptions } : {}),
        };
    this.beginAgentIndexing(agentName);
    let publication: SessionPublicationResult;
    try {
      publication = await this.commitSessionPublication({
        context: "scan.refresh",
        agentName,
        sessions: nextSessions,
        candidateChangedIds: strategyResult.preciseChangedIds ?? [],
        indexJob: persistentJob,
      });
    } catch (error) {
      agent.setSessionMetaMap(durableMeta);
      if (durableLastRefreshAt == null) this.lastRefreshAtByAgent.delete(agentName);
      else this.lastRefreshAtByAgent.set(agentName, durableLastRefreshAt);
      throw error;
    }
    this.options.workerRunner.commit?.(agentName);
    const persistDuration = performance.now() - persistStartedAt;
    logSearchIndexSync("scan.refresh", null, { pending_paths: pendingPathCount });

    const totalDurationMs = performance.now() - startedAt;
    this.scheduler.recordRefreshDuration(agentName, totalDurationMs);
    appLogger.info(
      strategyResult.sourceFailures.length > 0 ? "scan.refresh.partial" : "scan.refresh.done",
      {
        agent: agentName,
        duration_ms: Math.round(totalDurationMs),
        sessions: nextSessions.length,
        new_sessions: publication.event?.newSessions ?? 0,
        updated_sessions: publication.event?.updatedSessions ?? 0,
        removed_sessions: publication.event?.removedSessions ?? 0,
        pending_paths: pendingPathCount,
        availability_ms: Math.round(availabilityDuration),
        check_ms: Math.round(strategyResult.checkDuration),
        scan_ms: Math.round(strategyResult.scanDuration),
        diff_ms: Math.round(publication.diffDuration),
        persist_ms: Math.round(persistDuration),
        search_index_ms: Math.round(persistDuration),
        persistent_index_worker_job: persistentJob.kind,
        failed_sources: strategyResult.sourceFailures.length,
      },
    );
    if (strategyResult.sourceFailures.length > 0) {
      appLogger.warn("scan.refresh.source_failures", {
        agent: agentName,
        failures: strategyResult.sourceFailures,
      });
      throw sourceFailureError(strategyResult.sourceFailures);
    }
    return "committed";
  }

  /**
   * An agent that cannot be reached was never scanned, so there is nothing to
   * compare against. Publishing an empty result here would diff every known
   * session into a removal — the same mistake as reading a failed query as an
   * empty database.
   */
  private refreshUnavailableAgent(agentName: string): RefreshStrategyResult {
    this.lastRefreshAtByAgent.set(agentName, Date.now());
    const previousSessions = this.sessionIndex.snapshot().byAgent[agentName] ?? [];
    if (previousSessions.length > 0) {
      appLogger.warn("scan.refresh.agent_unavailable", {
        agent: agentName,
        retained_sessions: previousSessions.length,
      });
      return this.refreshStrategyResult(previousSessions, "partial", {}, { status: "unchanged" });
    }
    return this.refreshStrategyResult([], "partial", {});
  }

  private async initializeAgent(
    agent: BaseAgent,
    previousSessions: SessionHead[],
  ): Promise<RefreshStrategyResult> {
    this.setScanPhase("initializing");
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const result = await this.runWorker(agent, previousSessions, null, scope);
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
    return this.refreshStrategyResult(sessions, result.completeness, scope, {
      fullScanSessions: sessions,
      explicitRemovedSessionIds: result.explicitRemovedSessionIds,
      scanDuration: performance.now() - scanStartedAt,
      sourceFailures: result.sourceFailures ?? [],
    });
  }

  private async syncAgentSources(
    agent: FileSystemSessionSource,
    cached: CachedSessions,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const result = await this.runWorker(agent, cached.sessions, null, scope, {
      sourceSync: true,
      meta: cached.meta,
    });
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    const preciseChangedIds = result.changedIds ?? [];
    const persistenceDiff = buildPersistenceDiff(cached.sessions, sessions, preciseChangedIds);
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
    if (
      persistenceDiff.changedSessions.length === 0 &&
      persistenceDiff.removedSessionIds.length === 0 &&
      (result.sourceFailures?.length ?? 0) === 0
    ) {
      this.logUnchangedRefresh(agent.name, refreshStartedAt);
      return this.refreshStrategyResult(sessions, result.completeness, scope, {
        status: "unchanged",
        scanDuration: performance.now() - scanStartedAt,
      });
    }
    return this.refreshStrategyResult(sessions, result.completeness, scope, {
      preciseChangedIds,
      persistenceDiff,
      scanDuration: performance.now() - scanStartedAt,
      sourceFailures: result.sourceFailures ?? [],
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
    this.lastRefreshAtByAgent.set(agent.name, checkResult.timestamp);
    if (!checkResult.hasChanges) {
      const scanStartedAt = performance.now();
      const result = await this.runWorker(agent, baseline, [], {}, { derivedOnly: true });
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const sessions = attachMissingProjectIdentities(result.sessions);
      const persistenceDiff = buildPersistenceDiff(baseline, sessions);
      if (
        persistenceDiff.changedSessions.length === 0 &&
        persistenceDiff.removedSessionIds.length === 0
      ) {
        this.logUnchangedRefresh(agent.name, refreshStartedAt);
        return this.refreshStrategyResult(
          sessions,
          result.completeness,
          {},
          {
            status: "unchanged",
            checkDuration,
            scanDuration: performance.now() - scanStartedAt,
          },
        );
      }
      return this.refreshStrategyResult(
        sessions,
        result.completeness,
        {},
        {
          persistenceDiff,
          checkDuration,
          scanDuration: performance.now() - scanStartedAt,
          sourceFailures: result.sourceFailures ?? [],
        },
      );
    }
    const preciseChangedIds = checkResult.changedIds ?? null;
    const scanStartedAt = performance.now();
    if (preciseChangedIds === null) {
      const result = await this.runWorker(agent, baseline, null, {});
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const sessions = attachMissingProjectIdentities(result.sessions);
      return this.refreshStrategyResult(
        sessions,
        result.completeness,
        {},
        {
          persistenceDiff: buildPersistenceDiff(baseline, sessions),
          checkDuration,
          scanDuration: performance.now() - scanStartedAt,
          sourceFailures: result.sourceFailures ?? [],
        },
      );
    }
    this.options.workerRunner.discard?.(agent.name);
    const sessions = attachMissingProjectIdentities(
      await Promise.resolve(agent.incrementalScan(baseline, preciseChangedIds, checkResult.refs)),
    );
    const sourceFailures = checkResult.sourceFailures ?? [];
    return this.refreshStrategyResult(
      sessions,
      sourceFailures.length > 0 ? "partial" : "complete",
      {},
      {
        preciseChangedIds,
        persistenceDiff: buildPersistenceDiff(baseline, sessions, preciseChangedIds),
        checkDuration,
        scanDuration: performance.now() - scanStartedAt,
        sourceFailures,
      },
    );
  }

  private async scanAgentFully(
    agent: BaseAgent,
    previousSessions: SessionHead[],
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const result = await this.runWorker(agent, previousSessions, null, {});
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
    return this.refreshStrategyResult(
      sessions,
      result.completeness,
      {},
      {
        fullScanSessions: sessions,
        explicitRemovedSessionIds: result.explicitRemovedSessionIds,
        scanDuration: performance.now() - scanStartedAt,
        sourceFailures: result.sourceFailures ?? [],
      },
    );
  }

  private refreshStrategyResult(
    nextSessions: SessionHead[],
    completeness: SessionSnapshotCompleteness,
    scope: Pick<ScanOptions, "from" | "to">,
    overrides: Partial<Omit<RefreshStrategyResult, "nextSessions" | "completeness" | "scope">> = {},
  ): RefreshStrategyResult {
    return {
      status: "continue",
      nextSessions,
      fullScanSessions: null,
      preciseChangedIds: null,
      persistenceDiff: null,
      checkDuration: 0,
      scanDuration: 0,
      sourceFailures: [],
      completeness,
      scope,
      explicitRemovedSessionIds: [],
      ...overrides,
    };
  }

  private runWorker(
    agent: BaseAgent,
    previousSessions: SessionHead[],
    changedIds: string[] | null,
    scanOptions: Pick<ScanOptions, "from" | "to" | "fast">,
    workerOptions: {
      sourceSync?: boolean;
      derivedOnly?: boolean;
      backfill?: boolean;
      backfillAttempt?: BackfillAttemptRef;
      backfillCursor?: string | null;
      checkpoint?: boolean;
      meta?: CachedSessions["meta"];
    } = {},
  ) {
    return this.options.workerRunner.run(agent.name, {
      previousSessions,
      changedIds,
      scanOptions,
      sourceSync: workerOptions.sourceSync,
      derivedOnly: workerOptions.derivedOnly,
      backfill: workerOptions.backfill,
      backfillCursor: workerOptions.backfillCursor,
      checkpoint: workerOptions.checkpoint,
      meta: workerOptions.meta ?? buildAgentCacheMeta(agent),
      onProgress: (progress) =>
        this.updateAgentScanProgress(agent.name, progress, workerOptions.backfillAttempt),
    });
  }

  private needsBackfill(agent: BaseAgent): boolean {
    const startupScanOptions = this.startupScanOptions();
    if (startupScanOptions.from == null && startupScanOptions.to == null) return false;
    if (!agent.isAvailable()) return false;
    const lastSyncAt = getAgentLastFullSyncAt(agent.name);
    if (lastSyncAt == null || Date.now() - lastSyncAt > BACKFILL_INTERVAL_MS) return true;
    if (!(agent instanceof FileSystemSessionSource)) return false;
    if (this.cacheIntegrityCheckedAgents.has(agent.name)) return false;

    const cached = loadCachedSessions(agent.name);
    const sourceCount = agent.listSessionSources().length;
    const cachedCount = cached?.sessions.length ?? 0;
    this.cacheIntegrityCheckedAgents.add(agent.name);
    if (sourceCount > 0 && cachedCount / sourceCount < CACHE_TRUNCATION_COVERAGE) {
      appLogger.warn("scan.backfill.cache_truncated", {
        agent: agent.name,
        cached_sessions: cachedCount,
        source_files: sourceCount,
        last_sync_at: lastSyncAt,
      });
      return true;
    }
    return false;
  }

  private enqueueBackfill(agentName: string): void {
    if (this.isShuttingDown || !this.backfills.enqueue(agentName)) return;
    this.publishBackfillStatus();
    this.pumpBackfillQueue();
  }

  private pumpBackfillQueue(): void {
    if (this.isShuttingDown) return;
    const attempt = this.backfills.startNext();
    if (!attempt) return;
    this.publishBackfillStatus();
    void this.runBackfill(attempt).then((result) => {
      if (this.isShuttingDown) return;
      const current = this.backfills.stateFor(attempt.agentName);
      if (current?.status !== "running" || current.attemptId !== attempt.attemptId) return;
      this.flushProgressStatus(`backfill:${attempt.agentName}`);
      if (!this.backfills.complete(attempt, result)) return;
      if (result === "failed") this.cacheIntegrityCheckedAgents.delete(attempt.agentName);
      this.publishBackfillStatus();
      this.pumpBackfillQueue();
    });
  }

  private runBackfill(attempt: BackfillAttemptRef): Promise<BackfillTerminalStatus> {
    return this.scheduler.run(attempt.agentName, "backfill", () => this.performBackfill(attempt));
  }

  private async performBackfill(attempt: BackfillAttemptRef): Promise<BackfillTerminalStatus> {
    const { agentName } = attempt;
    const startedAt = performance.now();
    const agent = this.findAgent(agentName);
    if (!agent || !agent.isAvailable()) return "skipped";
    const snapshot = this.sessionIndex.snapshot();
    const cached = loadCachedSessions(agentName);
    const baseline = cached?.sessions ?? snapshot.byAgent[agentName] ?? [];
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    const backfillCursor = getAgentFullSyncCursor(agentName);
    if (cached) restoreAgentCacheMeta(agent, cached);
    let durableCommitted = false;
    try {
      markAgentFullSyncStarted(agentName);
      const result = await this.runWorker(
        agent,
        baseline,
        null,
        {},
        {
          sourceSync: agent instanceof FileSystemSessionSource,
          backfill: true,
          backfillAttempt: attempt,
          backfillCursor,
          meta,
        },
      );
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      this.flushProgressStatus(`backfill:${agentName}`);
      if (
        this.backfills.updateProgress(attempt, {
          phase: "indexing",
          sessions: fullSessions.length,
        })
      ) {
        this.publishProgressStatus(
          `backfill:${agentName}`,
          "indexing",
          this.scanStatus.updateBackfill(this.backfills.status()),
        );
      }
      await this.commitSessionPublication({
        context: "scan.backfill",
        agentName,
        sessions: fullSessions,
        candidateChangedIds: result.changedIds ?? [],
        indexJob: {
          kind: "full",
          context: "scan.backfill",
          agentName,
          sessions: fullSessions,
          meta: buildAgentCacheMeta(agent),
          completeness: result.completeness,
          removedSessionIds: result.explicitRemovedSessionIds,
          saveCache: true,
        },
      });
      durableCommitted = true;
      this.options.workerRunner.commit?.(agentName);
      if (result.sourceFailures?.length) throw sourceFailureError(result.sourceFailures);
      markAgentFullSyncCompleted(agentName);
      appLogger.info("scan.backfill.done", {
        agent: agentName,
        duration_ms: Math.round(performance.now() - startedAt),
        sessions: fullSessions.length,
        changed: result.changedIds?.length ?? 0,
      });
      return "committed";
    } catch (error) {
      if (!durableCommitted) agent.setSessionMetaMap(new Map(Object.entries(meta)));
      this.options.workerRunner.discard?.(agentName);
      appLogger.error("scan.backfill.error", { agent: agentName, error });
      console.error(`[${agentName}] Backfill failed:`, error);
      return "failed";
    }
  }

  private buildFullSearchIndexJobs(context: string): SearchIndexWorkerJob[] {
    const snapshot = this.sessionIndex.snapshot();
    return snapshot.agents.flatMap((agent) => {
      if (!(agent.name in snapshot.byAgent)) return [];
      const cached = loadCachedSessions(agent.name);
      return [
        cached
          ? {
              kind: "full",
              context,
              agentName: agent.name,
              sessions: cached.sessions,
              meta: cached.meta,
              completeness: "partial",
              removedSessionIds: [],
            }
          : {
              kind: "full",
              context,
              agentName: agent.name,
              sessions: snapshot.byAgent[agent.name] ?? [],
              meta: buildAgentCacheMeta(agent),
              completeness: "partial",
              removedSessionIds: [],
            },
      ];
    });
  }

  private publicationId(context: string, agentName?: string): string {
    const id = this.nextPublicationId++;
    return agentName ? `${context}:${agentName}:${id}` : `${context}:${id}`;
  }

  private async commitSearchIndex(
    context: string,
    jobs: SearchIndexWorkerJob[],
    details: { publicationId: string; agent?: string; agents?: string[] },
  ): Promise<void> {
    appLogger.info("session.publication.prepared", {
      publication_id: details.publicationId,
      context,
      agent: details.agent,
      agents: details.agents,
      jobs: jobs.length,
    });
    try {
      await this.searchIndexJobs.enqueue(
        context,
        jobs.map((job) => ({ ...job, publicationId: details.publicationId })),
      );
    } catch (error) {
      appLogger.error("session.publication.failed", {
        publication_id: details.publicationId,
        context,
        agent: details.agent,
        stage: "search_index",
        error,
      });
      throw error;
    }
    appLogger.info("session.publication.index_committed", {
      publication_id: details.publicationId,
      context,
      agent: details.agent,
    });
  }

  private async commitSessionPublication(
    publication: SessionPublication,
  ): Promise<SessionPublicationResult> {
    const publicationId = this.publicationId(publication.context, publication.agentName);
    await this.commitSearchIndex(publication.context, [publication.indexJob], {
      publicationId,
      agent: publication.agentName,
    });
    const diffStartedAt = performance.now();
    const event = this.sessionIndex.commitAgentSessions(
      publication.agentName,
      publication.sessions,
      publication.candidateChangedIds,
    );
    const diffDuration = performance.now() - diffStartedAt;
    this.emitSessionsChanged({
      agentName: publication.agentName,
      sessions: this.sessionIndex.snapshot().byAgent[publication.agentName] ?? [],
      event,
    });
    appLogger.info("session.publication.published", {
      publication_id: publicationId,
      context: publication.context,
      agent: publication.agentName,
      sessions: publication.sessions.length,
      has_event: event != null,
    });
    return { event, diffDuration };
  }

  private findAgent(agentName: string): BaseAgent | undefined {
    return this.sessionIndex.findAgent(agentName);
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
