import {
  attachMissingProjectIdentities,
  buildAgentCacheMeta,
  getAgentFullSyncCursor,
  computeSessionDiff,
  loadCachedSessions,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  readCachedSessions,
  readAgentCacheInitialization,
  readAgentLastFullSyncAt,
  sessionSignature,
  type BaseAgent,
  type AggregateSessionSourceCapability,
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
import { appLogger, logSearchIndexSync } from "./logging.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import { SearchIndexMaintenanceScheduler } from "./search-index-maintenance-scheduler.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { ScanStatusReporter } from "./scan-status-reporter.js";
import { SearchIndexPublisher } from "./search-index-publisher.js";
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
const PARTIAL_BACKFILL_RETRY_DELAY_MS = 5 * 60 * 1000;
const CACHE_TRUNCATION_COVERAGE = 0.5;
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
  private readonly statusReporter: ScanStatusReporter;
  private readonly indexPublisher: SearchIndexPublisher;
  private readonly searchIndexJobs: SearchIndexJobRunner;
  private readonly searchIndexMaintenance: SearchIndexMaintenanceScheduler;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(private readonly options: AgentSyncEngineOptions) {
    this.scheduler = new AgentOperationScheduler((agentName) => this.performRefresh(agentName));
    this.statusReporter = new ScanStatusReporter({
      sessionCount: (agentName) => this.sessionIndex.snapshot().byAgent[agentName]?.length,
      backfills: this.backfills,
    });
    this.searchIndexJobs = new SearchIndexJobRunner();
    this.indexPublisher = new SearchIndexPublisher({
      jobs: this.searchIndexJobs,
      snapshot: () => this.sessionIndex.snapshot(),
      readCachedSessions: (agentName) => this.readCachedSessionsOrWarn("search.index", agentName),
    });
    this.searchIndexMaintenance = new SearchIndexMaintenanceScheduler(
      this.searchIndexJobs,
      (status) => this.statusReporter.updateSearchIndexMaintenance(status),
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
      this.statusReporter.recordAgentFailure(
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
    return this.statusReporter.status();
  }

  subscribeSessionsChanged(listener: SessionsChangedListener): () => void {
    this.sessionsChangedListeners.add(listener);
    return () => this.sessionsChangedListeners.delete(listener);
  }

  subscribeStatusChanged(listener: StatusChangedListener): () => void {
    return this.statusReporter.subscribe(listener);
  }

  async syncInitialIndex(): Promise<void> {
    const jobs = this.indexPublisher.buildFullSearchIndexJobs("scan.initial");
    await this.indexPublisher.commitSearchIndex("scan.initial", jobs, {
      publicationId: this.indexPublisher.publicationId("scan.initial"),
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
    this.statusReporter.startScanBatch(agentNames, "scanning");
    this.backgroundRefreshTimer = setTimeout(() => {
      this.backgroundRefreshTimer = null;
      for (const agentName of agentNames) this.scheduler.schedule(agentName, 0);
      if (agentNames.length === 0) this.statusReporter.finishScanBatch();
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
    this.statusReporter.markShuttingDown();
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
      this.statusReporter.finishAgentScan(agentName, completion);
    } catch (error) {
      this.reportPostCommitError("scan.refresh", agentName, error);
      // finishAgent is idempotent, so one retry restores the terminal projection.
      try {
        this.statusReporter.finishAgentScan(agentName, completion);
      } catch (recoveryError) {
        this.reportPostCommitError("scan.refresh", agentName, recoveryError);
      }
    }
  }

  private async performRefresh(agentName: string): Promise<AgentOperationResult> {
    this.statusReporter.beginAgentScan(agentName);
    const startedAt = performance.now();
    let failed = false;
    let durableCommitted = false;
    let cached: CachedSessions | null = null;
    let result: AgentOperationResult = "failed";
    let completion: ScanCompletion = { completeness: "complete" };
    try {
      if (this.findAgent(agentName))
        cached = this.readCachedSessionsOrWarn("scan.refresh", agentName);
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
        this.statusReporter.failAgent(agentName, failure.message);
      }
    }
    try {
      if (!failed) {
        if (durableCommitted) this.finishCommittedAgentScan(agentName, completion);
        else this.statusReporter.finishAgentScan(agentName, completion);
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
    } else if (agent.sessionSourceAccess.kind === "enumerated") {
      strategyResult = await this.syncAgentSources(
        agent,
        cached ?? {
          sessions: refreshBaseline,
          meta: Object.fromEntries(durableMeta),
        },
        startedAt,
      );
    } else if (refreshBaseline.length > 0) {
      strategyResult = await this.refreshChangedAgent(
        agent,
        agent.sessionSourceAccess,
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
    const publicationSessionIds = new Set(
      publicationSessions.map((session) => session.reference.sessionId),
    );
    const missingBaselineSessions = refreshBaseline.reduce(
      (count, session) => count + Number(!publicationSessionIds.has(session.reference.sessionId)),
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
      ? new Set(persistenceDiff.changedSessions.map(({ session }) => session.reference.sessionId))
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
    this.statusReporter.queueAgentPublication(agentName);
    let publicationCommitted = false;
    let publication: SessionPublicationResult;
    try {
      publication = await this.commitSessionPublication({
        context: "scan.refresh",
        agentName,
        sessions: nextSessions,
        candidateChangedIds: strategyResult.preciseChangedIds ?? [],
        indexJob: persistentJob,
        onPublishing: () => this.statusReporter.beginAgentPublishing(agentName),
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
    this.statusReporter.setScanPhase("initializing");
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
    agent: BaseAgent,
    baseline: Pick<CachedSessions, "sessions" | "meta">,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const result = await this.runWorker(
      agent,
      baseline.sessions,
      { kind: "source-refresh" },
      scope,
      {
        meta: baseline.meta,
      },
    );
    agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
    const sessions = attachMissingProjectIdentities(result.sessions);
    const preciseChangedIds = result.changedIds ?? [];
    const persistenceDiff = buildPersistenceDiff(baseline.sessions, sessions, preciseChangedIds);
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
    source: AggregateSessionSourceCapability,
    baseline: SessionHead[],
    cacheTimestamp: number,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scope = this.startupScanOptions();
    const checkStartedAt = performance.now();
    const checkResult = await Promise.resolve(source.checkForChanges(cacheTimestamp, baseline));
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
      source.commitChangeCheck();
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
      source.commitChangeCheck();
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
        source.incrementalScan(baseline, preciseChangedIds, checkResult.refs, scope),
      ),
    );
    source.commitChangeCheck();
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
        this.statusReporter.updateAgentScanProgress(
          agent.name,
          progress,
          runOptions.backfillAttempt,
        ),
      onCheckpoint: runOptions.onCheckpoint,
    });
  }

  private handleBackfillCheckpoint(
    agentName: string,
    checkpoint: ScanRefreshWorkerCheckpoint,
  ): void {
    if (checkpoint.stage !== "finalizing" || !checkpoint.backfillCursor) return;
    if (!markAgentFullSyncProgress(agentName, checkpoint.backfillCursor)) {
      // Without a durable cursor the next restart re-walks the whole history;
      // do not log the checkpoint as if it landed.
      appLogger.warn("scan.backfill.checkpoint_not_durable", {
        agent: agentName,
        cursor: checkpoint.backfillCursor,
      });
      return;
    }
    appLogger.debug("scan.backfill.checkpoint", {
      agent: agentName,
      cursor: checkpoint.backfillCursor,
      sessions: checkpoint.changes.length,
    });
  }

  private readCachedSessionsOrWarn(scope: string, agentName: string): CachedSessions | null {
    const outcome = readCachedSessions(agentName);
    if (outcome.status === "failed") {
      appLogger.warn(`${scope}.cache_state_unavailable`, {
        agent: agentName,
        state: "cached_sessions",
      });
      return null;
    }
    return outcome.value;
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
    if (agent.sessionSourceAccess.kind !== "enumerated") return false;
    if (!agent.isAvailable()) return false;

    let cachedSessions = cached;
    if (reloadCached || cached === undefined) {
      const outcome = readCachedSessions(agent.name);
      if (outcome.status === "failed") {
        // A broken cache read must not masquerade as a truncated cache and
        // trigger a full-history backfill against unknown state.
        appLogger.warn("scan.backfill.cache_state_unavailable", {
          agent: agent.name,
          state: "cached_sessions",
        });
        return false;
      }
      cachedSessions = outcome.value;
    }
    const sourceCount = agent.sessionSourceAccess.count();
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
    this.statusReporter.publishBackfillStatus();
    this.pumpBackfillQueue();
  }

  private pumpBackfillQueue(): void {
    if (this.isShuttingDown) return;
    const attempt = this.backfills.startNext();
    if (!attempt) return;
    this.statusReporter.publishBackfillStatus();
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
      this.statusReporter.flushProgressStatus(`backfill:${attempt.agentName}`);
      if (this.backfills.complete(attempt, result)) {
        if (result === "failed") {
          this.cacheIntegrityValidUntilByAgent.delete(attempt.agentName);
        } else if (result === "committed") {
          if (current.completion?.completeness === "partial") {
            this.cacheIntegrityValidUntilByAgent.delete(attempt.agentName);
            this.scheduler.schedule(attempt.agentName, PARTIAL_BACKFILL_RETRY_DELAY_MS);
            appLogger.info("scan.backfill.retry_scheduled", {
              agent: attempt.agentName,
              delay_ms: PARTIAL_BACKFILL_RETRY_DELAY_MS,
            });
          } else {
            this.cacheIntegrityValidUntilByAgent.set(
              attempt.agentName,
              Date.now() + BACKFILL_INTERVAL_MS,
            );
          }
        }
        this.statusReporter.publishBackfillStatus();
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
    const cached = this.readCachedSessionsOrWarn("scan.backfill", agentName);
    const baseline = cached?.sessions ?? snapshot.byAgent[agentName] ?? [];
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    const backfillCursor = getAgentFullSyncCursor(agentName);
    if (cached) restoreAgentCacheMeta(agent, cached);
    let durableCommitted = false;
    try {
      if (!markAgentFullSyncStarted(agentName)) {
        appLogger.warn("scan.backfill.cache_state_unavailable", {
          agent: agentName,
          state: "full_sync_started",
        });
      }
      const operation: BackfillScanRefreshOperation = {
        kind: "backfill",
        cursor: backfillCursor,
        checkpoint: "durable",
      };
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
      this.statusReporter.flushProgressStatus(`backfill:${agentName}`);
      const updatePublicationPhase = (phase: "publish-queued" | "publishing") => {
        if (
          this.backfills.updateProgress(attempt, {
            phase,
            sessions: fullSessions.length,
          })
        ) {
          this.statusReporter.publishBackfillProgress(`backfill:${agentName}`, phase);
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
      if (completion.completeness === "complete" && !markAgentFullSyncCompleted(agentName)) {
        appLogger.warn("scan.backfill.completion_not_durable", { agent: agentName });
      }
      appLogger.info(
        completion.completeness === "partial" ? "scan.backfill.partial" : "scan.backfill.done",
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

  private async commitSessionPublication(
    publication: SessionPublication,
  ): Promise<SessionPublicationResult> {
    const publicationId = this.indexPublisher.publicationId(
      publication.context,
      publication.agentName,
    );
    await this.indexPublisher.commitSearchIndex(publication.context, [publication.indexJob], {
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
