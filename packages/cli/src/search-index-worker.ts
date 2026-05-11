import { parentPort, workerData } from "node:worker_threads";
import {
  createRegisteredAgents,
  syncSessionSearchIndex,
  type SearchIndexSyncResult,
  type SessionCacheMeta,
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

interface SearchIndexWorkerData {
  context: string;
  agentNames: string[];
  sessionsByAgent: Record<string, SessionHead[]>;
  metaByAgent: Record<string, Record<string, SessionCacheMeta>>;
}

const data = workerData as SearchIndexWorkerData;
const startedAt = performance.now();
const agents = createRegisteredAgents();

for (const agentName of data.agentNames) {
  const agent = agents.find((item) => item.name === agentName);
  if (!agent) continue;

  const meta = data.metaByAgent[agentName];
  if (meta && agent.setSessionMetaMap) {
    agent.setSessionMetaMap(new Map(Object.entries(meta)));
  }

  const sessions = data.sessionsByAgent[agentName] ?? [];
  const result = syncSessionSearchIndex(agentName, sessions, (sessionId) =>
    agent.getSessionData(sessionId),
  );
  parentPort?.postMessage({
    type: "sync-result",
    context: data.context,
    result,
  } satisfies SearchIndexWorkerMessage);
}

parentPort?.postMessage({
  type: "done",
  context: data.context,
  durationMs: performance.now() - startedAt,
  sessions: Object.values(data.sessionsByAgent).reduce(
    (total, sessions) => total + sessions.length,
    0,
  ),
} satisfies SearchIndexWorkerMessage);
