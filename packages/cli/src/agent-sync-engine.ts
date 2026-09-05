import {
  attachMissingProjectIdentities,
  beginAgentRefresh,
  buildAgentCacheMeta,
  buildSessionPersistenceDiff,
  getAgentFullSyncCursor,
  markAgentFullSyncProgress,
  markAgentFullSyncStarted,
  markAgentFullSyncCompleted,
  readCachedSessions,
  readAgentCacheInitialization,
  resolveSessionSnapshotCompleteness,
  type AgentRefreshTransaction,
  type AgentRefreshSelection,
  type CachedResult,
  type IdentifiedSessionHead,
  type ScanOptions,
  type LiveSnapshot,
  type SessionHead,
  type SessionPersistenceDiff,
  type SessionSnapshotCompleteness,
} from "@codesesh/core/runtime/discovery";
import { type BaseAgent, type SessionSourceFailure } from "@codesesh/core/runtime/agents";
import type {
  ScanCompletion,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { AgentBackfillScheduler } from "./agent-backfill-scheduler.js";
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
import {
  SessionPublicationCoordinator,
  type AgentSessionsChanged,
  type SessionPublicationResult,
} from "./session-publication.js";
import type {
  BackfillScanRefreshOperation,
  ScanRefreshOperation,
} from "./scan-refresh-operation.js";
import type { ScanRefreshWorkerCheckpoint } from "./scan-refresh-worker.js";
import { AgentUnavailableDuringScanError } from "./scan-refresh-error.js";
import type { StagedWorkerRun, WorkerRunner } from "./worker-runner.js";
import { toError } from "./errors.js";

export type { AgentOperationResult } from "./agent-operation-scheduler.js";
export type { AgentSessionsChanged } from "./session-publication.js";

export interface AgentSyncEngineOptions {
  startupScanOptions?: Pick<ScanOptions, "from" | "to">;
  workerRunner: WorkerRunner;
}

export interface AgentSyncEngineInitializationOptions extends LiveSessionIndexOptions {
  cacheTimestamps?: Record<string, number>;
}

type SessionsChangedListener = (change: AgentSessionsChanged) => void;
type StatusChangedListener = (event: ScanStatusEvent) => void;
type CachedSessions = CachedResult;

interface RefreshResult {
  result: Exclude<AgentOperationResult, "failed">;
  completion: ScanCompletion;
}

interface PendingAgentState {
  meta: CachedSessions["meta"];
  refreshedAt?: number;
  refreshTransaction?: AgentRefreshTransaction;
}

function countSessionUpdates(event: SessionsUpdatedEvent | null): {
  newSessions: number;
  updatedSessions: number;
  removedSessions: number;
} {
  if (!event) return { newSessions: 0, updatedSessions: 0, removedSessions: 0 };
  return {
    newSessions: event.newSessionRefs.length,
    updatedSessions: event.changedSessionHeads.length - event.newSessionRefs.length,
    removedSessions: event.removedSessionRefs.length,
  };
}

interface RefreshStrategyBase {
  nextSessions: IdentifiedSessionHead[];
  checkDuration: number;
  scanDuration: number;
  sourceFailures: SessionSourceFailure[];
  completeness: SessionSnapshotCompleteness;
  scope: Pick<ScanOptions, "from" | "to">;
  workerRun?: StagedWorkerRun;
  pendingAgentState?: PendingAgentState;
}

type RefreshPublication =
  | {
      kind: "changes";
      diff: SessionPersistenceDiff<IdentifiedSessionHead>;
      candidateChangedIds: string[];
    }
  | {
      kind: "full";
      sessions: IdentifiedSessionHead[];
      explicitRemovedSessionIds: string[];
    };

type RefreshStrategyResult =
  | (RefreshStrategyBase & { status: "unchanged" })
  | (RefreshStrategyBase & { status: "continue"; publication: RefreshPublication });

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
// SSE carries one compact summary; logs retain the complete failure list.
const SOURCE_FAILURE_SUMMARY_MAX_LENGTH = 160;

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

function selectCacheMeta(
  meta: CachedSessions["meta"],
  sessionIds?: ReadonlySet<string>,
): CachedSessions["meta"] {
  if (!sessionIds) return { ...meta };
  const selected: CachedSessions["meta"] = {};
  for (const sessionId of sessionIds) {
    const entry = meta[sessionId];
    if (entry) selected[sessionId] = entry;
  }
  return selected;
}

export class AgentSyncEngine {
  private lastRefreshAtByAgent = new Map<string, number>();
  private readonly scheduler: AgentOperationScheduler;
  private readonly sessionIndex = new LiveSessionIndex();
  private readonly backfills = new BackfillLifecycle();
  private readonly backfillScheduler: AgentBackfillScheduler;
  private readonly statusReporter: ScanStatusReporter;
  private readonly indexPublisher: SearchIndexPublisher;
  private readonly sessionPublication: SessionPublicationCoordinator;
  private readonly searchIndexJobs: SearchIndexJobRunner;
  private readonly searchIndexMaintenance: SearchIndexMaintenanceScheduler;
  private backgroundRefreshTimer: NodeJS.Timeout | null = null;

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
      agentSessions: (agentName) => this.sessionIndex.agentSessions(agentName),
      readCachedSessions: (agentName) => this.readCachedSessionsOrWarn("search.index", agentName),
    });
    this.sessionPublication = new SessionPublicationCoordinator(
      this.indexPublisher,
      this.sessionIndex,
    );
    this.backfillScheduler = new AgentBackfillScheduler({
      lifecycle: this.backfills,
      statusReporter: this.statusReporter,
      startupScanOptions: this.startupScanOptions(),
      runAttempt: (attempt) => this.runBackfill(attempt),
      scheduleRefresh: (agentName, delayMs) => this.scheduler.schedule(agentName, delayMs),
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
    return this.sessionPublication.subscribe(listener);
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
    this.sessionPublication.markShuttingDown();
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
    this.backfillScheduler.shutdown();
    this.searchIndexMaintenance.stop();
    this.statusReporter.markShuttingDown();
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

  private reportPostCommitError(
    operation: "scan.refresh" | "scan.backfill",
    agentName: string,
    error: unknown,
  ): void {
    appLogger.error(`${operation}.post_commit_error`, { agent: agentName, error });
  }

  private commitAgentState(
    operation: "scan.refresh" | "scan.backfill",
    agent: BaseAgent,
    state?: PendingAgentState,
  ): void {
    if (!state) return;
    try {
      agent.restoreSessionCacheMeta(state.meta);
      if (state.refreshedAt != null) {
        this.lastRefreshAtByAgent.set(agent.name, state.refreshedAt);
      }
    } catch (error) {
      this.reportPostCommitError(operation, agent.name, error);
      return;
    }
    try {
      state.refreshTransaction?.commit();
    } catch (error) {
      this.reportPostCommitError(operation, agent.name, error);
    }
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
    let cached: CachedSessions | null = null;
    let refresh: { result: AgentOperationResult; completion: ScanCompletion } = {
      result: "failed",
      completion: { completeness: "complete" },
    };
    try {
      if (this.findAgent(agentName))
        cached = this.readCachedSessionsOrWarn("scan.refresh", agentName);
      refresh = await this.runRefresh(agentName, cached, startedAt);
    } catch (error) {
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
    try {
      if (refresh.result !== "failed") {
        if (refresh.result === "committed")
          this.finishCommittedAgentScan(agentName, refresh.completion);
        else this.statusReporter.finishAgentScan(agentName, refresh.completion);
      }
    } catch (error) {
      if (refresh.result !== "committed") throw error;
      this.reportPostCommitError("scan.refresh", agentName, error);
    }
    // The backfill probe touches cache state and may check agent availability;
    // either operation can throw on transient errors, but that must not
    // fail — let alone reject — an otherwise finished refresh.
    try {
      const agent = this.findAgent(agentName);
      if (agent && this.backfillScheduler.needsBackfill(agent)) {
        this.enqueueBackfill(agentName);
      }
      if (agent) this.searchIndexMaintenance.enqueue(agentName);
    } catch (error) {
      appLogger.warn("scan.refresh.backfill_probe_failed", { agent: agentName, error });
    }
    return refresh.result;
  }

  private async runRefresh(
    agentName: string,
    cached: CachedSessions | null,
    startedAt: number,
  ): Promise<RefreshResult> {
    const pendingPathCount = this.scheduler.takePendingSignalCount(agentName);
    const agent = this.findAgent(agentName);
    if (!agent) {
      appLogger.warn("scan.refresh.missing_agent", { agent: agentName });
      return { result: "skipped", completion: { completeness: "complete" } };
    }
    const previousSessions = this.sessionIndex.agentSessions(agentName);
    const refreshBaseline = cached?.sessions ?? previousSessions;
    const cacheTimestamp = cached?.timestamp ?? this.lastRefreshAtByAgent.get(agentName) ?? 0;
    if (cached) agent.restoreSessionCacheMeta(cached.meta);
    const durableMeta = agent.snapshotSessionCacheMeta();
    const initialization = readAgentCacheInitialization(agentName);
    if (initialization.status === "failed") {
      appLogger.warn("scan.refresh.cache_state_unavailable", {
        agent: agentName,
        state: "initialization",
      });
      return { result: "unchanged", completion: { completeness: "complete" } };
    }
    const isInitialized = initialization.value;
    const refreshTransaction = await beginAgentRefresh(agent, {
      initialized: isInitialized,
      sinceTimestamp: cacheTimestamp,
      cachedSessions: refreshBaseline,
    });
    const refresh = refreshTransaction.selection;
    const availabilityDuration = refresh.availabilityDurationMs;
    let strategyResult: RefreshStrategyResult;
    try {
      if (refresh.kind === "unavailable") {
        strategyResult = this.refreshUnavailableAgent(agentName);
      } else if (refresh.kind === "initialize") {
        strategyResult = await this.initializeAgent(agent, previousSessions);
      } else if (refresh.kind === "synchronize") {
        strategyResult = await this.syncAgentSources(
          agent,
          cached ?? {
            sessions: refreshBaseline,
            meta: durableMeta,
          },
          startedAt,
        );
      } else {
        strategyResult = await this.refreshChangedAgent(
          agent,
          refresh,
          refreshTransaction,
          refreshBaseline,
          startedAt,
        );
      }
    } finally {
      agent.restoreSessionCacheMeta(durableMeta);
    }
    const stagedRun = strategyResult.workerRun;
    if (strategyResult.status === "unchanged") {
      stagedRun?.commit();
      this.commitAgentState("scan.refresh", agent, strategyResult.pendingAgentState);
      return {
        result: "unchanged",
        completion: buildScanCompletion(strategyResult.completeness, strategyResult.sourceFailures),
      };
    }

    const nextSessions = attachMissingProjectIdentities(strategyResult.nextSessions);
    const persistenceDiff =
      strategyResult.publication.kind === "changes" ? strategyResult.publication.diff : null;
    const publicationSessions =
      strategyResult.publication.kind === "full"
        ? strategyResult.publication.sessions
        : nextSessions;
    const explicitRemovedSessionIds =
      strategyResult.publication.kind === "full"
        ? strategyResult.publication.explicitRemovedSessionIds
        : [];
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
        : explicitRemovedSessionIds.length;
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
    const pendingMeta = strategyResult.pendingAgentState?.meta ?? durableMeta;
    const persistStartedAt = performance.now();
    const persistentJob: SearchIndexWorkerJob = persistenceDiff
      ? {
          kind: "changes",
          context: "scan.refresh",
          agentName,
          changes: persistenceDiff.changedSessions,
          removedSessionIds: persistenceDiff.removedSessionIds,
          meta: selectCacheMeta(pendingMeta, changedSessionIds),
        }
      : {
          kind: "full",
          context: "scan.refresh",
          agentName,
          sessions: publicationSessions,
          meta: selectCacheMeta(pendingMeta),
          completeness: strategyResult.completeness,
          removedSessionIds: explicitRemovedSessionIds,
          saveCache: true,
        };
    const completion = buildScanCompletion(
      strategyResult.completeness,
      strategyResult.sourceFailures,
    );
    this.statusReporter.queueAgentPublication(agentName);
    let publication: SessionPublicationResult;
    try {
      publication = await this.sessionPublication.commit({
        context: "scan.refresh",
        agentName,
        sessions: nextSessions,
        candidateChangedIds:
          strategyResult.publication.kind === "changes"
            ? strategyResult.publication.candidateChangedIds
            : [],
        indexJob: persistentJob,
        stagedRun,
        onPublishing: () => this.statusReporter.beginAgentPublishing(agentName),
      });
    } catch (error) {
      stagedRun?.discard();
      throw error;
    }
    this.commitAgentState("scan.refresh", agent, strategyResult.pendingAgentState);
    const persistDuration = performance.now() - persistStartedAt;
    const totalDurationMs = performance.now() - startedAt;
    try {
      logSearchIndexSync("scan.refresh", null, { pending_paths: pendingPathCount });
      this.scheduler.recordRefreshDuration(agentName, totalDurationMs);
      const sessionUpdateCounts = countSessionUpdates(publication.event);
      appLogger.info(
        strategyResult.sourceFailures.length > 0 ? "scan.refresh.partial" : "scan.refresh.done",
        {
          agent: agentName,
          duration_ms: Math.round(totalDurationMs),
          sessions: nextSessions.length,
          new_sessions: sessionUpdateCounts.newSessions,
          updated_sessions: sessionUpdateCounts.updatedSessions,
          removed_sessions: sessionUpdateCounts.removedSessions,
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
    } catch (error) {
      this.reportPostCommitError("scan.refresh", agentName, error);
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
    const previousSessions = this.sessionIndex.agentSessions(agentName);
    if (previousSessions.length > 0) {
      appLogger.warn("scan.refresh.agent_unavailable", {
        agent: agentName,
        retained_sessions: previousSessions.length,
      });
      return {
        ...this.refreshStrategyBase(previousSessions, "partial", {}),
        status: "unchanged",
      };
    }
    return {
      ...this.refreshStrategyBase([], "partial", {}),
      status: "continue",
      publication: { kind: "full", sessions: [], explicitRemovedSessionIds: [] },
    };
  }

  private async initializeAgent(
    agent: BaseAgent,
    previousSessions: IdentifiedSessionHead[],
  ): Promise<RefreshStrategyResult> {
    this.statusReporter.setScanPhase("initializing");
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const workerRun = await this.runWorker(agent, previousSessions, { kind: "full-scan" }, scope);
    try {
      const { result } = workerRun;
      const sessions = attachMissingProjectIdentities(result.sessions);
      return {
        ...this.refreshStrategyBase(sessions, result.completeness, scope, {
          scanDuration: performance.now() - scanStartedAt,
          sourceFailures: result.sourceFailures ?? [],
          workerRun,
          pendingAgentState: { meta: result.meta, refreshedAt: Date.now() },
        }),
        status: "continue",
        publication: {
          kind: "full",
          sessions,
          explicitRemovedSessionIds: result.explicitRemovedSessionIds,
        },
      };
    } catch (error) {
      workerRun.discard();
      throw error;
    }
  }

  private async syncAgentSources(
    agent: BaseAgent,
    baseline: Pick<CachedSessions, "sessions" | "meta">,
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scanStartedAt = performance.now();
    const scope = this.startupScanOptions();
    const workerRun = await this.runWorker(
      agent,
      baseline.sessions,
      { kind: "source-refresh" },
      scope,
      {
        meta: baseline.meta,
      },
    );
    try {
      const { result } = workerRun;
      const sessions = attachMissingProjectIdentities(result.sessions);
      const preciseChangedIds = result.changedIds ?? [];
      const persistenceDiff = buildSessionPersistenceDiff(baseline.sessions, sessions, {
        candidateChangedIds: preciseChangedIds,
      });
      const pendingAgentState = { meta: result.meta, refreshedAt: Date.now() };
      if (
        persistenceDiff.changedSessions.length === 0 &&
        persistenceDiff.removedSessionIds.length === 0 &&
        (result.sourceFailures?.length ?? 0) === 0
      ) {
        this.logUnchangedRefresh(agent.name, refreshStartedAt);
        return {
          ...this.refreshStrategyBase(sessions, result.completeness, scope, {
            scanDuration: performance.now() - scanStartedAt,
            workerRun,
            pendingAgentState,
          }),
          status: "unchanged",
        };
      }
      return {
        ...this.refreshStrategyBase(sessions, result.completeness, scope, {
          scanDuration: performance.now() - scanStartedAt,
          sourceFailures: result.sourceFailures ?? [],
          workerRun,
          pendingAgentState,
        }),
        status: "continue",
        publication: {
          kind: "changes",
          diff: persistenceDiff,
          candidateChangedIds: preciseChangedIds,
        },
      };
    } catch (error) {
      workerRun.discard();
      throw error;
    }
  }

  private async refreshChangedAgent(
    agent: BaseAgent,
    refresh: Exclude<AgentRefreshSelection, { kind: "unavailable" | "initialize" | "synchronize" }>,
    refreshTransaction: AgentRefreshTransaction,
    baseline: IdentifiedSessionHead[],
    refreshStartedAt: number,
  ): Promise<RefreshStrategyResult> {
    const scope = this.startupScanOptions();
    if (refresh.kind === "failed") {
      appLogger.warn("scan.refresh.change_check_failed", {
        agent: agent.name,
        source_path: refresh.failure.sourcePath,
        error_class: refresh.failure.errorClass,
        message: refresh.failure.message,
      });
      return {
        ...this.refreshStrategyBase(
          baseline,
          "partial",
          {},
          {
            checkDuration: refresh.checkDurationMs,
          },
        ),
        status: "unchanged",
      };
    }
    const { check: checkResult, source } = refresh;
    const checkDuration = refresh.checkDurationMs;
    if (refresh.kind === "recompute-derived") {
      const scanStartedAt = performance.now();
      const workerRun = await this.runWorker(agent, baseline, { kind: "recompute-derived" }, {});
      try {
        const { result } = workerRun;
        const sessions = attachMissingProjectIdentities(result.sessions);
        const pendingAgentState = {
          meta: result.meta,
          refreshedAt: checkResult.timestamp,
          refreshTransaction,
        };
        const persistenceDiff = buildSessionPersistenceDiff(baseline, sessions);
        if (
          persistenceDiff.changedSessions.length === 0 &&
          persistenceDiff.removedSessionIds.length === 0
        ) {
          this.logUnchangedRefresh(agent.name, refreshStartedAt);
          return {
            ...this.refreshStrategyBase(
              sessions,
              result.completeness,
              {},
              {
                checkDuration,
                scanDuration: performance.now() - scanStartedAt,
                workerRun,
                pendingAgentState,
              },
            ),
            status: "unchanged",
          };
        }
        return {
          ...this.refreshStrategyBase(
            sessions,
            result.completeness,
            {},
            {
              checkDuration,
              scanDuration: performance.now() - scanStartedAt,
              sourceFailures: result.sourceFailures ?? [],
              workerRun,
              pendingAgentState,
            },
          ),
          status: "continue",
          publication: { kind: "changes", diff: persistenceDiff, candidateChangedIds: [] },
        };
      } catch (error) {
        workerRun.discard();
        throw error;
      }
    }
    const scanStartedAt = performance.now();
    if (refresh.kind === "full-scan") {
      const workerRun = await this.runWorker(agent, baseline, { kind: "full-scan" }, scope);
      try {
        const { result } = workerRun;
        const sessions = attachMissingProjectIdentities(result.sessions);
        const persistenceDiff = buildSessionPersistenceDiff(baseline, sessions, {
          // Worker-reported IDs also preserve metadata-only pricing repairs.
          candidateChangedIds: result.changedIds ?? [],
          completeness: result.completeness,
          explicitRemovedSessionIds: result.explicitRemovedSessionIds,
        });
        const strategy = this.refreshStrategyBase(sessions, result.completeness, scope, {
          checkDuration,
          scanDuration: performance.now() - scanStartedAt,
          sourceFailures: result.sourceFailures ?? [],
          workerRun,
          pendingAgentState: {
            meta: result.meta,
            refreshedAt: checkResult.timestamp,
            refreshTransaction,
          },
        });
        if (
          persistenceDiff.changedSessions.length === 0 &&
          persistenceDiff.removedSessionIds.length === 0 &&
          (result.sourceFailures?.length ?? 0) === 0
        ) {
          this.logUnchangedRefresh(agent.name, refreshStartedAt);
          return { ...strategy, status: "unchanged" };
        }
        return {
          ...strategy,
          status: "continue",
          publication: { kind: "changes", diff: persistenceDiff, candidateChangedIds: [] },
        };
      } catch (error) {
        workerRun.discard();
        throw error;
      }
    }
    const preciseChangedIds = refresh.check.changedIds;
    this.options.workerRunner.reset(agent.name);
    const sessions = attachMissingProjectIdentities(
      await Promise.resolve(
        source.incrementalScan(baseline, preciseChangedIds, checkResult.refs, scope),
      ),
    );
    const sourceFailures = checkResult.sourceFailures ?? [];
    const completeness = resolveSessionSnapshotCompleteness(scope, sourceFailures);
    return {
      ...this.refreshStrategyBase(sessions, completeness, scope, {
        checkDuration,
        scanDuration: performance.now() - scanStartedAt,
        sourceFailures,
        pendingAgentState: {
          meta: agent.snapshotSessionCacheMeta(),
          refreshedAt: checkResult.timestamp,
          refreshTransaction,
        },
      }),
      status: "continue",
      publication: {
        kind: "changes",
        diff: buildSessionPersistenceDiff(baseline, sessions, {
          candidateChangedIds: preciseChangedIds,
          completeness,
          explicitRemovedSessionIds: preciseChangedIds,
        }),
        candidateChangedIds: preciseChangedIds,
      },
    };
  }

  private refreshStrategyBase(
    nextSessions: IdentifiedSessionHead[],
    completeness: SessionSnapshotCompleteness,
    scope: Pick<ScanOptions, "from" | "to">,
    overrides: Partial<Omit<RefreshStrategyBase, "nextSessions" | "completeness" | "scope">> = {},
  ): RefreshStrategyBase {
    return {
      nextSessions,
      checkDuration: 0,
      scanDuration: 0,
      sourceFailures: [],
      completeness,
      scope,
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

  private enqueueBackfill(agentName: string): void {
    this.backfillScheduler.enqueue(agentName);
  }

  private runBackfill(attempt: BackfillAttemptRef): Promise<BackfillTerminalStatus> {
    return this.scheduler.run(attempt.agentName, "backfill", () => this.performBackfill(attempt));
  }

  private async performBackfill(attempt: BackfillAttemptRef): Promise<BackfillTerminalStatus> {
    const { agentName } = attempt;
    const startedAt = performance.now();
    const agent = this.findAgent(agentName);
    if (!agent || !agent.isAvailable()) return "skipped";
    const cached = this.readCachedSessionsOrWarn("scan.backfill", agentName);
    const baseline = cached?.sessions ?? this.sessionIndex.agentSessions(agentName);
    const meta = cached?.meta ?? buildAgentCacheMeta(agent);
    const backfillCursor = getAgentFullSyncCursor(agentName);
    if (cached) agent.restoreSessionCacheMeta(cached.meta);
    let workerRun: StagedWorkerRun | undefined;
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
      workerRun = await this.runWorker(
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
      const { result } = workerRun;
      const fullSessions = attachMissingProjectIdentities(result.sessions);
      const completion = buildScanCompletion(result.completeness, result.sourceFailures ?? []);
      this.statusReporter.flushProgressStatus(`backfill:${agentName}`);
      const updatePublicationPhase = (
        phase: "publish-queued" | "publishing" | "indexing" | "committing",
      ) => {
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
      await this.sessionPublication.commit({
        context: "scan.backfill",
        agentName,
        sessions: fullSessions,
        candidateChangedIds: result.changedIds ?? [],
        indexJob: {
          kind: "full",
          context: "scan.backfill",
          agentName,
          sessions: fullSessions,
          meta: result.meta,
          completeness: result.completeness,
          removedSessionIds: result.explicitRemovedSessionIds,
          saveCache: true,
        },
        stagedRun: workerRun,
        onPublishing: () => updatePublicationPhase("publishing"),
        onPublicationProgress: ({ stage }) => {
          if (stage === "prepared") updatePublicationPhase("indexing");
          if (stage === "search_staged") updatePublicationPhase("committing");
        },
        onCommitted: () => {
          if (completion.completeness === "partial") {
            this.backfills.recordCompletion(attempt, completion);
          }
        },
      });
      this.commitAgentState("scan.backfill", agent, { meta: result.meta });
      try {
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
      } catch (error) {
        this.reportPostCommitError("scan.backfill", agentName, error);
      }
      return "committed";
    } catch (error) {
      workerRun?.discard();
      appLogger.error("scan.backfill.error", { agent: agentName, error });
      console.error(`[${agentName}] Backfill failed:`, error);
      return "failed";
    }
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
