import "./diagnostics-bridge.js";
import { parentPort, workerData } from "node:worker_threads";
import {
  attachMissingProjectIdentities,
  createRegisteredAgents,
  diffSessionSources,
  ensureSessionTagsSync,
  FileSystemSessionSource,
  type AgentScanProgress,
  type BaseAgent,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
} from "@codesesh/core";

export type ScanRefreshWorkerMessage =
  | {
      type: "progress";
      requestId: number;
      progress: AgentScanProgress;
    }
  | {
      type: "done";
      requestId: number;
      sessions: SessionHead[];
      meta: Record<string, SessionCacheMeta>;
      changedIds?: string[];
      durationMs: number;
    }
  | {
      type: "error";
      requestId: number;
      error: string;
      durationMs: number;
    };

export interface ScanRefreshWorkerRequest {
  type: "run";
  requestId: number;
  agentName: string;
  previousSessions: SessionHead[];
  changedIds: string[] | null;
  sourceSync?: boolean;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
}

function serializeMeta(agent: {
  getSessionMetaMap: () => Map<string, SessionCacheMeta>;
}): Record<string, SessionCacheMeta> {
  const metaMap = agent.getSessionMetaMap();
  const meta: Record<string, SessionCacheMeta> = {};
  for (const [id, data] of metaMap.entries()) {
    meta[id] = { id, ...(data as Record<string, unknown>) } as SessionCacheMeta;
  }
  return meta;
}

/**
 * Source-level incremental sync. The change decision itself lives in
 * diffSessionSources so this path and FileSystemSessionSource.checkForChanges
 * cannot drift; only the re-parse and merge are local, because the worker holds
 * cached meta received over workerData rather than the agent's live metaMap.
 */
function syncAgentSources(
  agent: FileSystemSessionSource,
  cachedSessions: SessionHead[],
  cachedMeta: Record<string, SessionCacheMeta>,
  windowOptions?: Pick<ScanOptions, "from" | "to">,
): { sessions: SessionHead[]; changedIds: string[] } {
  const sessionMap = new Map(cachedSessions.map((session) => [session.id, session]));
  const sourceRefs = agent.listSessionSources(windowOptions);
  const sourceById = new Map(sourceRefs.map((source) => [source.sessionId, source]));
  const { changedIds, removedIds } = diffSessionSources(
    sourceRefs,
    cachedSessions,
    cachedMeta,
    windowOptions,
  );

  for (const sessionId of changedIds) {
    const source = sourceById.get(sessionId);
    if (!source) continue;
    const next = agent.scanSessionSource(source.sourcePath);
    if (next) {
      sessionMap.set(next.id, next);
    } else {
      sessionMap.delete(sessionId);
    }
  }

  for (const sessionId of removedIds) sessionMap.delete(sessionId);

  return {
    sessions: [...sessionMap.values()],
    changedIds: [...new Set([...changedIds, ...removedIds])],
  };
}

/**
 * A session still receiving writes will be stale again within seconds, so
 * recomputing its tags every refresh cycle is wasted work — wait for it to
 * settle before paying the getSessionData() parse cost.
 */
const TAG_SETTLE_MS = 60_000;

function isSettled(session: SessionHead, now: number): boolean {
  return now - (session.time_updated ?? session.time_created) >= TAG_SETTLE_MS;
}

/**
 * Runs identity resolution (spawns git) and stale smart-tag reclassification
 * on the worker thread, off the server's main event loop.
 */
export function finalizeSessions(agent: BaseAgent, sessions: SessionHead[]): SessionHead[] {
  const withIdentity = attachMissingProjectIdentities(sessions);

  const now = Date.now();
  const settled = withIdentity.filter((session) => isSettled(session, now));
  if (settled.length === 0) return withIdentity;

  const taggedById = new Map(
    ensureSessionTagsSync(agent, settled).sessions.map((session) => [session.id, session]),
  );
  return withIdentity.map((session) => taggedById.get(session.id) ?? session);
}

async function run(data: ScanRefreshWorkerRequest): Promise<void> {
  const startedAt = performance.now();
  const agent = createRegisteredAgents().find((item) => item.name === data.agentName);
  if (!agent) {
    throw new Error(`Unknown agent: ${data.agentName}`);
  }

  agent.setSessionMetaMap(new Map(Object.entries(data.meta)));

  const isAvailable = agent.isAvailable();
  let sessions: SessionHead[];
  let changedIds: string[] | undefined;

  if (!isAvailable) {
    sessions = [];
  } else if (data.sourceSync && agent instanceof FileSystemSessionSource) {
    const result = syncAgentSources(agent, data.previousSessions, data.meta, data.scanOptions);
    sessions = result.sessions;
    changedIds = result.changedIds;
  } else if (data.changedIds) {
    sessions = await Promise.resolve(agent.incrementalScan(data.previousSessions, data.changedIds));
  } else {
    sessions = await Promise.resolve(
      agent.scan({
        ...data.scanOptions,
        onProgress: (progress) => {
          parentPort?.postMessage({
            type: "progress",
            requestId: data.requestId,
            progress,
          } satisfies ScanRefreshWorkerMessage);
        },
      }),
    );
  }

  sessions = finalizeSessions(agent, sessions);

  parentPort?.postMessage({
    type: "done",
    requestId: data.requestId,
    sessions,
    meta: serializeMeta(agent),
    changedIds,
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}

async function handleRequest(data: ScanRefreshWorkerRequest): Promise<void> {
  const startedAt = performance.now();
  try {
    await run(data);
  } catch (error) {
    parentPort?.postMessage({
      type: "error",
      requestId: data.requestId,
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - startedAt,
    } satisfies ScanRefreshWorkerMessage);
  }
}

let requestTail = Promise.resolve();

function enqueueRequest(data: ScanRefreshWorkerRequest): void {
  requestTail = requestTail.then(() => handleRequest(data));
}

const initialRequest = workerData as Partial<ScanRefreshWorkerRequest> | undefined;
if (
  initialRequest?.type === "run" &&
  typeof initialRequest.requestId === "number" &&
  typeof initialRequest.agentName === "string" &&
  Array.isArray(initialRequest.previousSessions)
) {
  enqueueRequest(initialRequest as ScanRefreshWorkerRequest);
}

parentPort?.on("message", (message: ScanRefreshWorkerRequest) => {
  if (message.type === "run") enqueueRequest(message);
});
