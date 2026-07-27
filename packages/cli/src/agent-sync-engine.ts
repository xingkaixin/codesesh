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
  type LiveSnapshot,
  type SessionHead,
  type SessionHeadChange,
} from "@codesesh/core";
import type {
  BackfillStatus,
  ScanStatusEvent,
  SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { AgentOperationScheduler, type AgentOperationResult } from "./agent-operation-scheduler.js";
import { LiveSessionIndex, type LiveSessionIndexOptions } from "./live-session-index.js";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { SearchIndexJobRunner } from "./search-index-job-runner.js";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";
import { ScanStatusModel } from "./scan-status-model.js";
import type { WorkerRunner } from "./worker-runner.js";

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
}

const REFRESH_DEBOUNCE_MS = 200;
const EMPTY_AGENT_REFRESH_DEBOUNCE_MS = 30_000;
const SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD = 100;
const BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

function restoreAgentCacheMeta(agent: BaseAgent, cached: CachedSessions): void {
  agent.setSessionMetaMap(new Map(Object.entries(cached.meta)));
}

export class AgentSyncEngine {
  private lastRefreshAtByAgent = new Map<string, number>();
  private readonly scheduler: AgentOperationScheduler;
  private readonly sessionIndex = new LiveSessionIndex();
  private backfillQueue: string[] = [];
  private currentBackfillAgent: string | undefined;
  private completedBackfillAgents: string[] = [];
  private failedBackfillAgents: string[] = [];
  private sessionsChangedListeners = new Set<SessionsChangedListener>();
  private statusChangedListeners = new Set<StatusChangedListener>();
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
      backfill_running: this.currentBackfillAgent != null || undefined,
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
    this.backfillQueue.length = 0;
    this.currentBackfillAgent = undefined;
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
    const snapshot = this.sessionIndex.snapshot();
    if (!this.scanStatus.snapshot().active) this.startScanBatch([agentName], "scanning");
    this.publishStatus(
      this.scanStatus.beginAgent(agentName, snapshot.byAgent[agentName]?.length ?? 0),
    );
  }

  private updateAgentScanProgress(agentName: string, progress: AgentScanProgress): void {
    this.publishStatus(this.scanStatus.updateAgent(agentName, progress));
  }

  private beginAgentIndexing(agentName: string): void {
    this.publishStatus(this.scanStatus.indexAgent(agentName));
  }

  private finishAgentScan(agentName: string): void {
    const count = this.sessionIndex.snapshot().byAgent[agentName]?.length;
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
    const searchIndexOptions =
      pendingPathCount >= SEARCH_INDEX_BULK_PENDING_PATH_THRESHOLD ? { isBulk: true } : undefined;
    const persistenceDiff = strategyResult.persistenceDiff;
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
          sessions: strategyResult.fullScanSessions ?? nextSessions,
          meta: buildAgentCacheMeta(agent),
          saveCache: true,
          ...(searchIndexOptions ? { searchIndexOptions } : {}),
        };
    this.beginAgentIndexing(agentName);
    const publication = await this.commitSessionPublication({
      context: "scan.refresh",
      agentName,
      sessions: nextSessions,
      candidateChangedIds: strategyResult.preciseChangedIds ?? [],
      indexJob: persistentJob,
    });
    const persistDuration = performance.now() - persistStartedAt;
    logSearchIndexSync("scan.refresh", null, { pending_paths: pendingPathCount });

    const totalDurationMs = performance.now() - startedAt;
    this.scheduler.recordRefreshDuration(agentName, totalDurationMs);
    appLogger.info("scan.refresh.done", {
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
    });
    return "committed";
  }

  private refreshUnavailableAgent(agentName: string): RefreshStrategyResult {
    this.lastRefreshAtByAgent.set(agentName, Date.now());
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
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
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
    const persistenceDiff = buildPersistenceDiff(cached.sessions, sessions, preciseChangedIds);
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
    if (
      persistenceDiff.changedSessions.length === 0 &&
      persistenceDiff.removedSessionIds.length === 0
    ) {
      this.logUnchangedRefresh(agent.name, refreshStartedAt);
      return this.refreshStrategyResult(sessions, {
        status: "unchanged",
        scanDuration: performance.now() - scanStartedAt,
      });
    }
    return this.refreshStrategyResult(sessions, {
      preciseChangedIds,
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
    this.lastRefreshAtByAgent.set(agent.name, checkResult.timestamp);
    if (!checkResult.hasChanges) {
      this.logUnchangedRefresh(agent.name, refreshStartedAt);
      return this.refreshStrategyResult(baseline, { status: "unchanged", checkDuration });
    }
    const preciseChangedIds = checkResult.changedIds ?? null;
    const scanStartedAt = performance.now();
    if (preciseChangedIds === null) {
      const result = await this.runWorker(agent, baseline, null, {});
      agent.setSessionMetaMap(new Map(Object.entries(result.meta)));
      const sessions = attachMissingProjectIdentities(result.sessions);
      return this.refreshStrategyResult(sessions, {
        persistenceDiff: buildPersistenceDiff(baseline, sessions),
        checkDuration,
        scanDuration: performance.now() - scanStartedAt,
      });
    }
    const sessions = attachMissingProjectIdentities(
      await Promise.resolve(agent.incrementalScan(baseline, preciseChangedIds, checkResult.refs)),
    );
    return this.refreshStrategyResult(sessions, {
      preciseChangedIds,
      persistenceDiff: buildPersistenceDiff(baseline, sessions, preciseChangedIds),
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
    this.lastRefreshAtByAgent.set(agent.name, Date.now());
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
    void this.runBackfill(agentName).then((result) => {
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
    });
  }

  private runBackfill(agentName: string): Promise<AgentOperationResult> {
    return this.scheduler.run(agentName, "backfill", () => this.performBackfill(agentName));
  }

  private async performBackfill(agentName: string): Promise<AgentOperationResult> {
    const startedAt = performance.now();
    const agent = this.findAgent(agentName);
    if (!agent || !agent.isAvailable()) return "skipped";
    const snapshot = this.sessionIndex.snapshot();
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
          saveCache: true,
        },
      });
      markAgentFullSyncCompleted(agentName);
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
    const snapshot = this.sessionIndex.snapshot();
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
      await this.searchIndexJobs.enqueue(context, jobs);
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
