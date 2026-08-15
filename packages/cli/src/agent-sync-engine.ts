import {
  FileSystemSessionSource,
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  getAgentFullSyncCursor,
  computeSessionDiff,
  loadCachedSessions,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  readAgentCacheInitialization,
  readAgentLastFullSyncAt,
  sessionSignature,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type LiveSnapshot,
  type SessionHead,
  type PersistedSessionHeadChange,
  type SessionSourceFailure,
  type SessionSnapshotCompleteness,
} from "@codesesh/core";
import type {
  ScanCompletion,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
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
import { SearchIndexMaintenanceScheduler } from "./search-index-maintenance-scheduler.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { ScanStatusModel } from "./scan-status-model.js";
import type {
  BackfillScanRefreshOperation,
  ScanRefreshOperation,
} from "./scan-refresh-operation.js";
import type { ScanRefreshWorkerCheckpoint } from "./scan-refresh-worker.js";
import { AgentUnavailableDuringScanError } from "./scan-refresh-error.js";
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
  changedSessions: PersistedSessionHeadChange[];
  removedSessionIds: string[];
}

interface SessionPublication {
  context: "scan.refresh" | "scan.backfill";
  agentName: string;
  sessions: SessionHead[];
  candidateChangedIds: string[];
  indexJob: SearchIndexWorkerJob;
  onPublishing?: () => void;
  onCommitted?: (result: SessionPublicationResult) => void;
}

interface SessionPublicationResult {
  durableCommitted: true;
  event: SessionsUpdatedEvent | null;
  diffDuration: number;
}

interface RefreshResult {
  result: Exclude<AgentOperationResult, "failed">;
  completion: ScanCompletion;
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
// SSE carries one compact summary; logs retain the complete failure list.
const SOURCE_FAILURE_SUMMARY_MAX_LENGTH = 160;

function buildPersistenceDiff(
  previousSessions: SessionHead[],
  nextSessions: SessionHead[],
  candidateChangedIds: string[] = [],
  completeness: SessionSnapshotCompleteness = "complete",
  explicitRemovedSessionIds: readonly string[] = [],
): SessionPersistenceDiff {
  const { changes, removedSessionIds } = computeSessionDiff(
    previousSessions,
    nextSessions,
    candidateChangedIds,
    sessionSignature,
  );
  if (completeness === "complete") {
    return { changedSessions: changes, removedSessionIds };
  }
  // A bounded or failed scan cannot prove that an omitted session disappeared.
  const explicitRemovals = new Set(explicitRemovedSessionIds);
  return {
    changedSessions: changes,
    removedSessionIds: removedSessionIds.filter((sessionId) => explicitRemovals.has(sessionId)),
  };
}

function buildScanCompletion(
  completeness: SessionSnapshotCompleteness,
  sourceFailures: readonly SessionSourceFailure[],
): ScanCompletion {
  if (sourceFailures.length === 0) return { completeness };
  const firstFailure = sourceFailures[0]!;
  const summary = `${firstFailure.errorClass}: ${firstFailure.message}`;
  return {
    completeness: "partial",
    sourceFailureCount: sourceFailures.length,
    sourceFailureSummary:
      summary.length > SOURCE_FAILURE_SUMMARY_MAX_LENGTH
        ? `${summary.slice(0, SOURCE_FAILURE_SUMMARY_MAX_LENGTH - 1)}…`
        : summary,
  };
}

function restoreAgentCacheMeta(agent: BaseAgent, cached: CachedSessions): void {
  agent.setSessionMetaMap(new Map(Object.entries(cached.meta)));
}

export class AgentSyncEngine {
  private lastRefreshAtByAgent = new Map<string, number>();
  private readonly scheduler: AgentOperationScheduler;
  private readonly sessionIndex = new LiveSessionIndex();
  private readonly backfills = new BackfillLifecycle();
  private cacheIntegrityValidUntilByAgent = new Map<string, number>();
  private sessionsChangedListeners = new Set<SessionsChangedListener>();
  private statusChangedListeners = new Set<StatusChangedListener>();
  private statusProgressThrottles = new Map<string, LatestValueThrottle<void>>();
  private scanStatus = new ScanStatusModel();
  private readonly searchIndexJobs: SearchIndexJobRunner;
  private readonly searchIndexMaintenance: SearchIndexMaintenanceScheduler;
  private nextPublicationId = 1;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private readonly options: AgentSyncEngineOptions) {
    this.scheduler = new AgentOperationScheduler((agentName) => this.performRefresh(agentName));
    this.searchIndexJobs = new SearchIndexJobRunner();
    this.searchIndexMaintenance = new SearchIndexMaintenanceScheduler(
      this.searchIndexJobs,
      (status) => this.publishStatus(this.scanStatus.updateSearchIndexMaintenance(status)),
    );
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
    for (const job of jobs) this.searchIndexMaintenance.enqueue(job.agentName);
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
    this.searchIndexMaintenance.stop();
    this.cancelProgressStatuses();
    this.cacheIntegrityValidUntilByAgent.clear();
    const searchIndexSnapshot = this.searchIndexJobs.snapshot();
    appLogger.info("search_index.shutdown.started", {
      active_batch_id: searchIndexSnapshot.activeBatchId,
      pending_batches: searchIndexSnapshot.pendingBatches,
    });
    await this.searchIndexJobs.shutdown();
    await this.searchIndexMaintenance.waitForIdle();
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

  private beginAgentPublishing(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.publishAgent(agentName));
  }

  private queueAgentPublication(agentName: string): void {
    this.flushProgressStatus(`scan:${agentName}`);
    this.publishStatus(this.scanStatus.queueAgentPublication(agentName));
  }

  private finishAgentScan(agentName: string, completion: ScanCompletion): void {
    this.flushProgressStatus(`scan:${agentName}`);
    const count = this.sessionIndex.snapshot().byAgent[agentName]?.length;
    this.publishStatus(this.scanStatus.finishAgent(agentName, count, completion));
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
    for (const listener of this.statusChangedListeners) {
      try {
        listener(event);
      } catch (error) {
        appLogger.error("scan.status_listener.error", { error });
      }
    }
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
    for (const listener of this.sessionsChangedListeners) {
      try {
        listener(change);
      } catch (error) {
        this.reportPostCommitError("session.publication", change.agentName, error);
      }
    }
  }

  private reportPostCommitError(
    operation: "scan.refresh" | "scan.backfill" | "session.publication",
    agentName: string,
    error: unknown,
  ): void {
    appLogger.error(`${operation}.post_commit_error`, { agent: agentName, error });
  }

  private finishCommittedAgentScan(agentName: string, completion: ScanCompletion): void {
    try {
      this.finishAgentScan(agentName, completion);
    } catch (error) {
      this.reportPostCommitError("scan.refresh", agentName, error);
      // finishAgent is idempotent, so one retry restores the terminal projection.
      try {
        this.finishAgentScan(agentName, completion);
      } catch (recoveryError) {
        this.reportPostCommitError("scan.refresh", agentName, recoveryError);
      }
    }
  }

  private async performRefresh(agentName: string): Promise<AgentOperationResult> {
    this.beginAgentScan(agentName);
    const startedAt = performance.now();
    let failed = false;
    let durableCommitted = false;
    let cached: CachedSessions | null = null;
    let result: AgentOperationResult = "failed";
    let completion: ScanCompletion = { completeness: "complete" };
    try {
      if (this.findAgent(agentName)) cached = loadCachedSessions(agentName);
      const refresh = await this.runRefresh(agentName, cached, startedAt, (committedCompletion) => {
        durableCommitted = true;
        completion = committedCompletion;
        result = "committed";
      });
      result = refresh.result;
      completion = refresh.completion;
    } catch (error) {
      if (durableCommitted) {
        this.reportPostCommitError("scan.refresh", agentName, error);
        result = "committed";
      } else {
        this.options.workerRunner.discard?.(agentName);
        failed = true;
        const failure = toError(error);
        if (failure instanceof AgentUnavailableDuringScanError) {
          appLogger.warn("scan.refresh.worker_agent_unavailable", {
            agent: agentName,
            error: failure.message,
          });
        } else {
          appLogger.error("scan.refresh.error", { agent: agentName, error });
        }
        console.error(`[${agentName}] Session refresh failed:`, error);
        this.flushProgressStatus(`scan:${agentName}`);
        this.publishStatus(this.scanStatus.failAgent(agentName, failure.message));
      }
    }
    try {
      if (!failed) {
        if (durableCommitted) this.finishCommittedAgentScan(agentName, completion);
        else this.finishAgentScan(agentName, completion);
      }
    } catch (error) {
      if (!durableCommitted) throw error;
      this.reportPostCommitError("scan.refresh", agentName, error);
    }
    // The backfill probe touches the agent's filesystem (isAvailable /
    // listSessionSources) and may throw on transient errors; that must not
    // fail — let alone reject — an otherwise finished refresh.
    try {
      const agent = this.findAgent(agentName);
      if (agent && this.needsBackfill(agent, cached, failed || result === "committed")) {
        this.enqueueBackfill(agentName);
      }
      if (agent) this.searchIndexMaintenance.enqueue(agentName);
    } catch (error) {
      appLogger.warn("scan.refresh.backfill_probe_failed", { agent: agentName, error });
    }
    return result;
  }

  private async runRefresh(
    agentName: string,
    cached: CachedSessions | null,
    startedAt: number,
    onDurableCommit: (completion: ScanCompletion) => void,
  ): Promise<RefreshResult> {
    const pendingPathCount = this.scheduler.takePendingSignalCount(agentName);
    const agent = this.findAgent(agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return { result: "skipped", completion: { completeness: "complete" } };
    }
    const previousSessions = this.sessionIndex.snapshot().byAgent[agentName] ?? [];
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? this.lastRefreshAtByAgent.get(agentName) ?? 0;
    if (cached) restoreAgentCacheMeta(agent, cached);
    const durableMeta = new Map(agent.getSessionMetaMap());
    const durableLastRefreshAt = this.lastRefreshAtByAgent.get(agentName);
    const initialization = readAgentCacheInitialization(agentName);
    if (initialization.status === "failed") {
      appLogger.warn("scan.refresh.cache_state_unavailable", {
        agent: agentName,
        state: "initialization",
      });
      return { result: "unchanged", completion: { completeness: "complete" } };
    }
    const isInitialized = initialization.value;
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
      return {
        result: "unchanged",
        completion: buildScanCompletion(strategyResult.completeness, strategyResult.sourceFailures),
      };
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
    const completion = buildScanCompletion(
      strategyResult.completeness,
      strategyResult.sourceFailures,
    );
    this.queueAgentPublication(agentName);
    let publicationCommitted = false;
    let publication: SessionPublicationResult;
    try {
      publication = await this.commitSessionPublication({
        context: "scan.refresh",
        agentName,
        sessions: nextSessions,
        candidateChangedIds: strategyResult.preciseChangedIds ?? [],
        indexJob: persistentJob,
        onPublishing: () => this.beginAgentPublishing(agentName),
        onCommitted: () => {
          publicationCommitted = true;
          onDurableCommit(completion);
        },
      });
    } catch (error) {
      if (!publicationCommitted) {
        agent.setSessionMetaMap(durableMeta);
        if (durableLastRefreshAt == null) this.lastRefreshAtByAgent.delete(agentName);
        else this.lastRefreshAtByAgent.set(agentName, durableLastRefreshAt);
      }
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
    }
    return { result: "committed", completion };
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
    const result = await this.runWorker(agent, previousSessions, { kind: "full-scan" }, scope);
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
    const result = await this.runWorker(agent, cached.sessions, { kind: "source-refresh" }, scope, {
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
    const scope = this.startupScanOptions();
    const checkStartedAt = performance.now();
    const checkResult = await Promise.resolve(agent.checkForChanges(cacheTimestamp, baseline));
    const checkDuration = performance.now() - checkStartedAt;
    if (checkResult.status === "failed") {
      appLogger.warn("scan.refresh.change_check_failed", {
        agent: agent.name,
        source_path: checkResult.failure.sourcePath,
        error_class: checkResult.failure.errorClass,
        message: checkResult.failure.message,
      });
      return this.refreshStrategyResult(
        baseline,
        "partial",
        {},
        { status: "unchanged", checkDuration },
      );
    }
    if (!checkResult.hasChanges) {
      const scanStartedAt = performance.now();
      const result = await this.runWorker(agent, baseline, { kind: "recompute-derived" }, {});
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const sessions = attachMissingProjectIdentities(result.sessions);
      this.lastRefreshAtByAgent.set(agent.name, checkResult.timestamp);
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
      const result = await this.runWorker(agent, baseline, { kind: "full-scan" }, scope);
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const sessions = attachMissingProjectIdentities(result.sessions);
      this.lastRefreshAtByAgent.set(agent.name, checkResult.timestamp);
      return this.refreshStrategyResult(sessions, result.completeness, scope, {
        // Meta-only changes (e.g. a pricing capture epoch bump) leave the head
        // signature intact; without the worker-reported ids they would never
        // persist and checkForChanges would rescan on every startup.
        persistenceDiff: buildPersistenceDiff(
          baseline,
          sessions,
          result.changedIds ?? [],
          result.completeness,
          result.explicitRemovedSessionIds,
        ),
        checkDuration,
        scanDuration: performance.now() - scanStartedAt,
        sourceFailures: result.sourceFailures ?? [],
      });
    }
    this.options.workerRunner.discard?.(agent.name);
    const sessions = attachMissingProjectIdentities(
      await Promise.resolve(
        agent.incrementalScan(baseline, preciseChangedIds, checkResult.refs, scope),
      ),
    );
    this.lastRefreshAtByAgent.set(agent.name, checkResult.timestamp);
    const sourceFailures = checkResult.sourceFailures ?? [];
    const completeness =
      scope.from == null && scope.to == null && sourceFailures.length === 0
        ? "complete"
        : "partial";
    return this.refreshStrategyResult(sessions, completeness, scope, {
      preciseChangedIds,
      persistenceDiff: buildPersistenceDiff(
        baseline,
        sessions,
        preciseChangedIds,
        completeness,
        preciseChangedIds,
      ),
      checkDuration,
      scanDuration: performance.now() - scanStartedAt,
      sourceFailures,
    });
  }

  private async scanAgentFully(
    agent: BaseAgent,
    previousSessions: SessionHead[],
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const result = await this.runWorker(agent, previousSessions, { kind: "full-scan" }, scope);
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
    operation: ScanRefreshOperation,
    scanOptions: Pick<ScanOptions, "from" | "to" | "fast">,
    runOptions: {
      backfillAttempt?: BackfillAttemptRef;
      meta?: CachedSessions["meta"];
      onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void;
    } = {},
  ) {
    return this.options.workerRunner.run(agent.name, {
      previousSessions,
      operation,
      scanOptions,
      meta: runOptions.meta ?? buildAgentCacheMeta(agent),
      onProgress: (progress) =>
        this.updateAgentScanProgress(agent.name, progress, runOptions.backfillAttempt),
      onCheckpoint: runOptions.onCheckpoint,
    });
  }

  private handleBackfillCheckpoint(
    agentName: string,
    checkpoint: ScanRefreshWorkerCheckpoint,
  ): void {
    if (checkpoint.stage !== "finalizing" || !checkpoint.backfillCursor) return;
    markAgentFullSyncProgress(agentName, checkpoint.backfillCursor);
    appLogger.debug("scan.backfill.checkpoint", {
      agent: agentName,
      cursor: checkpoint.backfillCursor,
      sessions: checkpoint.changes.length,
    });
  }

  private needsBackfill(
    agent: BaseAgent,
    cached?: CachedSessions | null,
    reloadCached = false,
  ): boolean {
    const startupScanOptions = this.startupScanOptions();
    if (startupScanOptions.from == null && startupScanOptions.to == null) return false;
    const now = Date.now();
    if ((this.cacheIntegrityValidUntilByAgent.get(agent.name) ?? 0) >= now) return false;
    const lastSync = readAgentLastFullSyncAt(agent.name);
    if (lastSync.status === "failed") {
      appLogger.warn("scan.backfill.cache_state_unavailable", {
        agent: agent.name,
        state: "last_full_sync",
      });
      return false;
    }
    const lastSyncAt = lastSync.value;
    if (lastSyncAt == null || now - lastSyncAt > BACKFILL_INTERVAL_MS) {
      return agent.isAvailable();
    }
    if (!(agent instanceof FileSystemSessionSource)) return false;
    if (!agent.isAvailable()) return false;

    const cachedSessions =
      reloadCached || cached === undefined ? loadCachedSessions(agent.name) : cached;
    const sourceCount = agent.listSessionSources().length;
    const cachedCount = cachedSessions?.sessions.length ?? 0;
    this.cacheIntegrityValidUntilByAgent.set(agent.name, lastSyncAt + BACKFILL_INTERVAL_MS);
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
    void this.runBackfill(attempt)
      .then((result) => this.completeBackfillAttempt(attempt, result))
      .catch((error) => this.rejectBackfillAttempt(attempt, error));
  }

  private completeBackfillAttempt(
    attempt: BackfillAttemptRef,
    result: BackfillTerminalStatus,
  ): void {
    if (this.isShuttingDown) return;
    const current = this.backfills.stateFor(attempt.agentName);
    if (current?.status === "running" && current.attemptId === attempt.attemptId) {
      this.flushProgressStatus(`backfill:${attempt.agentName}`);
      if (this.backfills.complete(attempt, result)) {
        if (result === "failed") {
          this.cacheIntegrityValidUntilByAgent.delete(attempt.agentName);
        } else if (result === "committed") {
          this.cacheIntegrityValidUntilByAgent.set(
            attempt.agentName,
            Date.now() + BACKFILL_INTERVAL_MS,
          );
        }
        this.publishBackfillStatus();
      }
    }
    this.pumpBackfillQueue();
  }

  private rejectBackfillAttempt(attempt: BackfillAttemptRef, error: unknown): void {
    appLogger.error("scan.backfill.queue_error", { agent: attempt.agentName, error });
    this.completeBackfillAttempt(attempt, "failed");
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
      const operation: BackfillScanRefreshOperation =
        agent instanceof FileSystemSessionSource
          ? { kind: "source-backfill", cursor: backfillCursor, checkpoint: "durable" }
          : { kind: "full-backfill", cursor: backfillCursor, checkpoint: "durable" };
      appLogger.info("scan.backfill.started", {
        agent: agentName,
        cursor: backfillCursor ?? undefined,
        durable_checkpoints: operation.checkpoint === "durable",
      });
      const result = await this.runWorker(
        agent,
        baseline,
        operation,
        {},
        {
          backfillAttempt: attempt,
          meta,
          onCheckpoint: (checkpoint) => this.handleBackfillCheckpoint(agentName, checkpoint),
        },
      );
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      const completion = buildScanCompletion(result.completeness, result.sourceFailures ?? []);
      this.flushProgressStatus(`backfill:${agentName}`);
      const updatePublicationPhase = (phase: "publish-queued" | "publishing") => {
        if (
          this.backfills.updateProgress(attempt, {
            phase,
            sessions: fullSessions.length,
          })
        ) {
          this.publishProgressStatus(
            `backfill:${agentName}`,
            phase,
            this.scanStatus.updateBackfill(this.backfills.status()),
          );
        }
      };
      updatePublicationPhase("publish-queued");
      const publication = await this.commitSessionPublication({
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
        onPublishing: () => updatePublicationPhase("publishing"),
        onCommitted: () => {
          durableCommitted = true;
          if (completion.completeness === "partial") {
            this.backfills.recordCompletion(attempt, completion);
          }
        },
      });
      durableCommitted = publication.durableCommitted;
      this.options.workerRunner.commit?.(agentName);
      markAgentFullSyncCompleted(agentName);
      appLogger.info(
        result.sourceFailures?.length ? "scan.backfill.partial" : "scan.backfill.done",
        {
          agent: agentName,
          duration_ms: Math.round(performance.now() - startedAt),
          sessions: fullSessions.length,
          changed: result.changedIds?.length ?? 0,
          failed_sources: result.sourceFailures?.length ?? 0,
        },
      );
      if (result.sourceFailures?.length) {
        appLogger.warn("scan.backfill.source_failures", {
          agent: agentName,
          failures: result.sourceFailures,
        });
      }
      return "committed";
    } catch (error) {
      if (durableCommitted) {
        this.reportPostCommitError("scan.backfill", agentName, error);
        return "committed";
      }
      agent.setSessionMetaMap(new Map(Object.entries(meta)));
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
              searchIndexOptions: { includePendingReindex: false },
            }
          : {
              kind: "full",
              context,
              agentName: agent.name,
              sessions: snapshot.byAgent[agent.name] ?? [],
              meta: buildAgentCacheMeta(agent),
              completeness: "partial",
              removedSessionIds: [],
              searchIndexOptions: { includePendingReindex: false },
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
    details: {
      publicationId: string;
      agent?: string;
      agents?: string[];
      onStarted?: () => void;
    },
  ): Promise<void> {
    appLogger.info("session.publication.prepared", {
      publication_id: details.publicationId,
      context,
      agent: details.agent,
      agents: details.agents,
      jobs: jobs.length,
    });
    try {
      const publicationJobs = jobs.map((job) => ({
        ...job,
        publicationId: details.publicationId,
      }));
      await (details.onStarted
        ? this.searchIndexJobs.enqueue(context, publicationJobs, details.onStarted)
        : this.searchIndexJobs.enqueue(context, publicationJobs));
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
      ...(publication.onPublishing ? { onStarted: publication.onPublishing } : {}),
    });
    const diffStartedAt = performance.now();
    const event = this.sessionIndex.commitAgentSessions(
      publication.agentName,
      publication.sessions,
      publication.candidateChangedIds,
    );
    const diffDuration = performance.now() - diffStartedAt;
    const result: SessionPublicationResult = { durableCommitted: true, event, diffDuration };
    publication.onCommitted?.(result);
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
    return result;
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
