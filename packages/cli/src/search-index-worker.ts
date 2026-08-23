import "./diagnostics-bridge.js";
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import {
  commitDurableSessionPublication,
  markAgentCacheInitialized,
  sessionDetailVersion,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type IdentifiedSessionHead,
  type SearchIndexSyncResult,
  type SearchIndexSyncOptions,
  type SearchIndexPublicationStage,
  type PersistedSessionHeadChange,
  type SessionSnapshotCompleteness,
  type DurableSessionPublicationFailureStage,
} from "@codesesh/core/runtime/discovery";
import { createRegisteredAgents, type SessionCacheMeta } from "@codesesh/core/runtime/agents";
import { synchronizePricingGeneration } from "@codesesh/core/runtime/pricing";
import { appLogger } from "./logging.js";

export type SearchIndexPersistStage = DurableSessionPublicationFailureStage;

export interface SearchIndexPublicationProgress {
  agentName: string;
  stage: SearchIndexPublicationStage;
}

export type SearchIndexWorkerOptions = Omit<SearchIndexSyncOptions, "onPublicationStage">;

export type SearchIndexWorkerMessage =
  | {
      type: "sync-result";
      context: string;
      result: SearchIndexSyncResult | null;
    }
  | {
      type: "persist-failed";
      context: string;
      stage: SearchIndexPersistStage;
      publicationId: string;
      agentName: string;
      sessions: number;
      /** True when the job carries a durable publication whose staged state must be rolled back. */
      fatal: boolean;
    }
  | ({ type: "publication-progress" } & SearchIndexPublicationProgress)
  | {
      type: "done";
      context: string;
      durationMs: number;
      sessions: number;
      failedAgents: string[];
    };

export type SearchIndexWorkerJob =
  | {
      kind: "full";
      context: string;
      agentName: string;
      sessions: IdentifiedSessionHead[];
      meta: Record<string, SessionCacheMeta>;
      completeness: SessionSnapshotCompleteness;
      removedSessionIds: string[];
      publicationId?: string;
      saveCache?: boolean;
      searchIndexOptions?: SearchIndexWorkerOptions;
    }
  | {
      kind: "changes";
      context: string;
      agentName: string;
      changes: PersistedSessionHeadChange<IdentifiedSessionHead>[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      publicationId?: string;
      searchIndexOptions?: SearchIndexWorkerOptions;
    }
  | {
      kind: "maintenance";
      context: string;
      agentName: string;
      changes: PersistedSessionHeadChange<IdentifiedSessionHead>[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      searchIndexOptions?: SearchIndexWorkerOptions;
    };

export interface SearchIndexWorkerRunRequest {
  type: "run";
  pricingGenerationId: number;
  jobs?: SearchIndexWorkerJob[];
  context: string;
  agentNames?: string[];
  sessionsByAgent?: Record<string, IdentifiedSessionHead[]>;
  metaByAgent?: Record<string, Record<string, SessionCacheMeta>>;
}

type WorkerAgent = ReturnType<typeof createRegisteredAgents>[number];

function jobSessionCount(job: SearchIndexWorkerJob): number {
  return job.kind === "full" ? job.sessions.length : job.changes.length;
}

function searchIndexOptions(job: SearchIndexWorkerJob): SearchIndexSyncOptions {
  return {
    ...job.searchIndexOptions,
    ...(job.kind === "full"
      ? { completeness: job.completeness, removedSessionIds: job.removedSessionIds }
      : {}),
    detailVersions: Object.fromEntries(
      Object.entries(job.meta).map(([sessionId, meta]) => [sessionId, sessionDetailVersion(meta)]),
    ),
  };
}

/**
 * Reports a persistence failure so the batch is rejected instead of settling as
 * `done`; the caller keeps its previously published snapshot and can retry.
 */
function reportPersistFailure(
  job: SearchIndexWorkerJob,
  failure: { stage: SearchIndexPersistStage; publicationId: string },
): void {
  appLogger.error("search_index.persist_failed", {
    context: job.context,
    stage: failure.stage,
    agent: job.agentName,
    sessions: jobSessionCount(job),
    publication_id: failure.publicationId,
  });
  parentPort?.postMessage({
    type: "persist-failed",
    context: job.context,
    stage: failure.stage,
    publicationId: failure.publicationId,
    agentName: job.agentName,
    sessions: jobSessionCount(job),
    fatal: jobIsDurablePublication(job),
  } satisfies SearchIndexWorkerMessage);
}

function runJob(
  job: SearchIndexWorkerJob,
  agent: WorkerAgent,
): { stage: SearchIndexPersistStage; publicationId: string } | null {
  if (job.kind === "maintenance") {
    const result = syncSessionSearchIndexChanges(
      job.agentName,
      job.changes,
      job.removedSessionIds,
      (sessionId) => agent.getSessionData(sessionId),
      searchIndexOptions(job),
    );
    if (!result) {
      return { stage: "search_index", publicationId: randomUUID() };
    }
    postSyncResult(job.context, result);
    return null;
  }

  if (job.kind === "changes") {
    const publication = commitDurableSessionPublication(
      {
        kind: "changes",
        agentName: job.agentName,
        changes: job.changes,
        removedSessionIds: job.removedSessionIds,
        meta: job.meta,
        ...(job.publicationId ? { publicationId: job.publicationId } : {}),
      },
      (sessionId) => agent.getSessionData(sessionId),
      publicationSearchIndexOptions(job),
    );
    if (publication.status === "rolled-back") return publication;
    postSyncResult(job.context, publication.searchIndex);
    return null;
  }

  if (job.saveCache) {
    const publication = commitDurableSessionPublication(
      {
        kind: "snapshot",
        agentName: job.agentName,
        sessions: job.sessions,
        meta: job.meta,
        completeness: job.completeness,
        removedSessionIds: job.removedSessionIds,
        ...(job.publicationId ? { publicationId: job.publicationId } : {}),
      },
      (sessionId) => agent.getSessionData(sessionId),
      publicationSearchIndexOptions(job),
    );
    if (publication.status === "rolled-back") return publication;
    const result = publication.searchIndex;
    // Head cache init is decoupled from search-index completeness (CS-73): a
    // session that fails to load must not permanently block future incremental scans.
    markAgentCacheInitialized(job.agentName);
    if (result.skipped > 0) {
      appLogger.warn("search_index.sync_incomplete", {
        agent: job.agentName,
        skipped: result.skipped,
      });
    }
    postSyncResult(job.context, result);
    return null;
  }

  const publicationId = job.publicationId ?? randomUUID();
  const result = syncSessionSearchIndex(
    job.agentName,
    job.sessions,
    (sessionId) => agent.getSessionData(sessionId),
    searchIndexOptions(job),
  );
  if (!result) return { stage: "search_index", publicationId };
  postSyncResult(job.context, result);
  return null;
}

function publicationSearchIndexOptions(job: SearchIndexWorkerJob): SearchIndexSyncOptions {
  return {
    ...job.searchIndexOptions,
    onPublicationStage: (stage) => {
      parentPort?.postMessage({
        type: "publication-progress",
        agentName: job.agentName,
        stage,
      } satisfies SearchIndexWorkerMessage);
    },
  };
}

function postSyncResult(context: string, result: SearchIndexSyncResult): void {
  parentPort?.postMessage({
    type: "sync-result",
    context,
    result,
  } satisfies SearchIndexWorkerMessage);
}

let pricingGenerationId: number | null = null;

function jobIsDurablePublication(job: SearchIndexWorkerJob): boolean {
  return job.kind !== "maintenance" && job.publicationId != null;
}

function jobsFromRequest(request: SearchIndexWorkerRunRequest): SearchIndexWorkerJob[] {
  if (request.jobs) return request.jobs;
  return (request.agentNames ?? []).map((agentName): SearchIndexWorkerJob => ({
    kind: "full",
    context: request.context,
    agentName,
    sessions: request.sessionsByAgent?.[agentName] ?? [],
    meta: request.metaByAgent?.[agentName] ?? {},
    completeness: "complete",
    removedSessionIds: [],
  }));
}

function runBatch(request: SearchIndexWorkerRunRequest): void {
  const startedAt = performance.now();
  if (pricingGenerationId !== request.pricingGenerationId) {
    synchronizePricingGeneration(request.pricingGenerationId);
    pricingGenerationId = request.pricingGenerationId;
  }
  const agents = createRegisteredAgents();
  const jobs = jobsFromRequest(request);

  const failedAgents = new Set<string>();
  for (const job of jobs) {
    // Later chunks for an agent whose earlier job failed would commit on top
    // of unknown state; other agents' jobs are independent and keep going.
    if (failedAgents.has(job.agentName)) continue;
    const agent = agents.find((item) => item.name === job.agentName);
    if (!agent) {
      reportPersistFailure(job, {
        stage: "prepare",
        publicationId:
          job.kind === "maintenance" ? randomUUID() : (job.publicationId ?? randomUUID()),
      });
      // A session publication must reject the whole batch so its staged
      // state gets rolled back by the caller.
      if (jobIsDurablePublication(job)) return;
      failedAgents.add(job.agentName);
      continue;
    }

    agent.restoreSessionCacheMeta(job.meta);

    const failure = runJob(job, agent);
    if (failure) {
      reportPersistFailure(job, failure);
      if (jobIsDurablePublication(job)) return;
      failedAgents.add(job.agentName);
    }
  }

  parentPort?.postMessage({
    type: "done",
    context: request.context,
    durationMs: performance.now() - startedAt,
    sessions: jobs.reduce((total, job) => total + jobSessionCount(job), 0),
    failedAgents: [...failedAgents],
  } satisfies SearchIndexWorkerMessage);
}

parentPort?.on("message", (message: SearchIndexWorkerRunRequest) => {
  if (message.type === "run") runBatch(message);
});
runBatch(workerData as SearchIndexWorkerRunRequest);
