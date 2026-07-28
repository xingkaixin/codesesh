import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import {
  createRegisteredAgents,
  markAgentCacheInitialized,
  saveCachedSessionChanges,
  saveCachedSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
  type SearchIndexSyncResult,
  type SearchIndexSyncOptions,
  type SessionCacheMeta,
  type SessionHeadChange,
  type SessionHead,
} from "@codesesh/core";
import { appLogger } from "./logging.js";

export type SearchIndexPersistStage = "cache" | "search_index";

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
  data.agentNames.map(
    (agentName): SearchIndexWorkerJob => ({
      kind: "full",
      context: data.context,
      agentName,
      sessions: data.sessionsByAgent[agentName] ?? [],
      meta: data.metaByAgent[agentName] ?? {},
    }),
  );

function jobSessionCount(job: SearchIndexWorkerJob): number {
  return job.kind === "full" ? job.sessions.length : job.changes.length;
}

/**
 * Reports a persistence failure so the batch is rejected instead of settling as
 * `done`; the caller keeps its previously published snapshot and can retry.
 */
function reportPersistFailure(job: SearchIndexWorkerJob, stage: SearchIndexPersistStage): void {
  appLogger.error("search_index.persist_failed", {
    context: job.context,
    stage,
    agent: job.agentName,
    sessions: jobSessionCount(job),
  });
  parentPort?.postMessage({
    type: "persist-failed",
    context: job.context,
    stage,
    agentName: job.agentName,
    sessions: jobSessionCount(job),
  } satisfies SearchIndexWorkerMessage);
}

function runJob(job: SearchIndexWorkerJob, agent: WorkerAgent): SearchIndexPersistStage | null {
  if (job.kind === "changes") {
    if (!saveCachedSessionChanges(job.agentName, job.changes, job.removedSessionIds, job.meta)) {
      return "cache";
    }
    const result = syncSessionSearchIndexChanges(
      job.agentName,
      job.changes,
      job.removedSessionIds,
      (sessionId) => agent.getSessionData(sessionId),
      job.searchIndexOptions,
    );
    if (!result) return "search_index";
    postSyncResult(job.context, result);
    return null;
  }

  if (job.saveCache && !saveCachedSessions(job.agentName, job.sessions, job.meta)) {
    return "cache";
  }
  const result = syncSessionSearchIndex(
    job.agentName,
    job.sessions,
    (sessionId) => agent.getSessionData(sessionId),
    job.searchIndexOptions,
  );
  if (!result) return "search_index";
  // Head cache init is decoupled from search-index completeness (CS-73): a
  // session that fails to load must not permanently block markAgentCacheInitialized,
  // or every future refresh would fall back to a full initializeAgent scan.
  // The skip is still surfaced as a warning so it stays visible.
  if (job.saveCache) {
    markAgentCacheInitialized(job.agentName);
    if (result.skipped > 0) {
      appLogger.warn("search_index.sync_incomplete", {
        agent: job.agentName,
        skipped: result.skipped,
      });
    }
  }
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

  const failedStage = runJob(job, agent);
  if (failedStage) {
    reportPersistFailure(job, failedStage);
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
