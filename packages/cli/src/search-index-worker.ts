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

export type SearchIndexWorkerMessage =
  | {
      type: "sync-result";
      context: string;
      result: SearchIndexSyncResult | null;
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

for (const job of jobs) {
  const agent = agents.find((item) => item.name === job.agentName);
  if (!agent) continue;

  if (agent.setSessionMetaMap) {
    agent.setSessionMetaMap(new Map(Object.entries(job.meta)));
  }

  let result: SearchIndexSyncResult | null;
  if (job.kind === "changes") {
    saveCachedSessionChanges(job.agentName, job.changes, job.removedSessionIds, job.meta);
    result = syncSessionSearchIndexChanges(
      job.agentName,
      job.changes,
      job.removedSessionIds,
      (sessionId) => agent.getSessionData(sessionId),
      job.searchIndexOptions,
    );
  } else {
    if (job.saveCache) {
      saveCachedSessions(job.agentName, job.sessions, job.meta);
    }
    result = syncSessionSearchIndex(
      job.agentName,
      job.sessions,
      (sessionId) => agent.getSessionData(sessionId),
      job.searchIndexOptions,
    );
    if (job.saveCache && result?.skipped === 0) {
      markAgentCacheInitialized(job.agentName);
    }
  }
  parentPort?.postMessage({
    type: "sync-result",
    context: job.context,
    result,
  } satisfies SearchIndexWorkerMessage);
}

parentPort?.postMessage({
  type: "done",
  context: data.context,
  durationMs: performance.now() - startedAt,
  sessions: jobs.reduce(
    (total, job) => total + (job.kind === "full" ? job.sessions.length : job.changes.length),
    0,
  ),
} satisfies SearchIndexWorkerMessage);
