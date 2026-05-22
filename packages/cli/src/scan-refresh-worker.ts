import { parentPort, workerData } from "node:worker_threads";
import {
  createRegisteredAgents,
  type AgentScanProgress,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
} from "@codesesh/core";

export type ScanRefreshWorkerMessage =
  | {
      type: "progress";
      progress: AgentScanProgress;
    }
  | {
      type: "done";
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      durationMs: number;
    }
  | {
      type: "error";
      error: string;
      durationMs: number;
    };

interface ScanRefreshWorkerData {
  agentName: string;
  previousSessions: SessionHead[];
  changedIds: string[] | null;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
}

function serializeMeta(agent: {
  getSessionMetaMap?: () => Map<string, SessionCacheMeta>;
}): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap?.();
  if (!metaMap) return {};

  const meta: Record<string, SessionCacheMeta> = {};
  for (const [id, data] of metaMap.entries()) {
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }
  return meta;
}

const data = workerData as ScanRefreshWorkerData;
const startedAt = performance.now();

try {
  const agent = createRegisteredAgents().find((item) => item.name === data.agentName);
  if (!agent) {
    throw new Error(`Unknown agent: ${data.agentName}`);
  }

  if (agent.setSessionMetaMap) {
    agent.setSessionMetaMap(new Map(Object.entries(data.meta)));
  }

  const isAvailable = agent.isAvailable();
  const sessions = !isAvailable
    ? []
    : data.changedIds && agent.incrementalScan
      ? agent.incrementalScan(data.previousSessions, data.changedIds)
      : agent.scan({
          ...data.scanOptions,
          onProgress: (progress) => {
            parentPort?.postMessage({
              type: "progress",
              progress,
            } satisfies ScanRefreshWorkerMessage);
          },
        });

  parentPort?.postMessage({
    type: "done",
    sessions,
    meta: serializeMeta(agent),
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}
