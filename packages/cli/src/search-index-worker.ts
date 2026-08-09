import "./diagnostics-bridge.js";
import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import {
  commitDurableSessionPublication,
  createRegisteredAgents,
  markAgentCacheInitialized,
  sessionDetailVersion,
  syncSessionSearchIndex,
  type SearchIndexSyncResult,
  type SearchIndexSyncOptions,
  type SessionCacheMeta,
  type SessionHeadChange,
  type SessionHead,
  type SessionSnapshotCompleteness,
  type DurableSessionPublicationFailureStage,
} from "@codesesh/core";
import { appLogger } from "./logging.js";

export type SearchIndexPersistStage = DurableSessionPublicationFailureStage;

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
    }
  | {
      type: "done";
      context: string;
      durationMs: number;
      sessions: number;
    };

export type SearchIndexWorkerJob =
  | {
      kind: "full";
      context: string;
      agentName: string;
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      completeness: SessionSnapshotCompleteness;
      removedSessionIds: string[];
      publicationId?: string;
      saveCache?: boolean;
      searchIndexOptions?: SearchIndexSyncOptions;
    }
  | {
      kind: "changes";
      context: string;
      agentName: string;
      changes: SessionHeadChange[];
      removedSessionIds: string[];
      meta: Record<string, SessionCacheMeta>;
      publicationId?: string;
      searchIndexOptions?: SearchIndexSyncOptions;
    };

interface SearchIndexWorkerData {
  jobs?: SearchIndexWorkerJob[];
  context: string;
  agentNames: string[];
  sessionsByAgent: Record<string, SessionHead[]>;
  metaByAgent: Record<string, Record<string, SessionCacheMeta>>;
}

type WorkerAgent = ReturnType<typeof createRegisteredAgents>[number];

const data = workerData as SearchIndexWorkerData;
const startedAt = performance.now();
const agents = createRegisteredAgents();
const jobs =
  data.jobs ??
  data.agentNames.map((agentName): SearchIndexWorkerJob => ({
    kind: "full",
    context: data.context,
    agentName,
    sessions: data.sessionsByAgent[agentName] ?? [],
    meta: data.metaByAgent[agentName] ?? {},
    completeness: "complete",
    removedSessionIds: [],
  }));

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
  } satisfies SearchIndexWorkerMessage);
}

function runJob(
  job: SearchIndexWorkerJob,
  agent: WorkerAgent,
): { stage: SearchIndexPersistStage; publicationId: string } | null {
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
      job.searchIndexOptions,
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
      job.searchIndexOptions,
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

function postSyncResult(context: string, result: SearchIndexSyncResult): void {
  parentPort?.postMessage({
    type: "sync-result",
    context,
    result,
  } satisfies SearchIndexWorkerMessage);
}

let persistFailed = false;
for (const job of jobs) {
  const agent = agents.find((item) => item.name === job.agentName);
  if (!agent) continue;

  if (agent.setSessionMetaMap) {
    agent.setSessionMetaMap(new Map(Object.entries(job.meta)));
  }

  const failure = runJob(job, agent);
  if (failure) {
    reportPersistFailure(job, failure);
    persistFailed = true;
    break;
  }
}

if (!persistFailed) {
  parentPort?.postMessage({
    type: "done",
    context: data.context,
    durationMs: performance.now() - startedAt,
    sessions: jobs.reduce((total, job) => total + jobSessionCount(job), 0),
  } satisfies SearchIndexWorkerMessage);
}
