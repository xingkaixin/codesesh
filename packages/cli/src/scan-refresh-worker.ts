import { parentPort, workerData } from "node:worker_threads";
import {
  createRegisteredAgents,
  FileSystemSessionSource,
  type AgentScanProgress,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
  type SessionSourceRef,
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
      changedIds?: string[];
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

function sourceFingerprintFromMeta(meta: SessionCacheMeta | undefined): string | null {
  return typeof meta?.sourceFingerprint === "string" ? meta.sourceFingerprint : null;
}

function parseSourceFingerprint(fingerprint: string): unknown[] | null {
  try {
    const parsed = JSON.parse(fingerprint);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Compare a live source fingerprint against the cached meta. A direct string
 * match is the fast path; the fallback tolerates older cache entries written by
 * a different fingerprint format as long as the underlying mtime (array slot 2)
 * is unchanged, so a fingerprint-format bump does not force a full rescan.
 */
function sourceFingerprintMatches(
  source: SessionSourceRef,
  cachedSession: SessionHead,
  cached: SessionCacheMeta | undefined,
): boolean {
  if (sourceFingerprintFromMeta(cached) === source.fingerprint) return true;

  const current = parseSourceFingerprint(source.fingerprint);
  if (!current || current.length < 5) return false;

  return (
    typeof cached?.sourceMtimeMs === "number" &&
    cached.sourceMtimeMs === current[2] &&
    (current[4] == null || cachedSession.title === current[4])
  );
}

function sourcePathFromMeta(meta: SessionCacheMeta | undefined): string | null {
  return typeof meta?.sourcePath === "string" ? meta.sourcePath : null;
}

/**
 * Source-level incremental sync, mirroring FileSystemSessionSource.incrementalScan.
 * Kept standalone because the worker cannot share the agent's live metaMap with
 * the main thread — it receives cached meta via workerData instead.
 */
function syncAgentSources(
  agent: FileSystemSessionSource,
  cachedSessions: SessionHead[],
  cachedMeta: Record<string, SessionCacheMeta>,
): { sessions: SessionHead[]; changedIds: string[] } {
  const sessionMap = new Map(cachedSessions.map((session) => [session.id, session]));
  const sourceRefs = agent.listSessionSources();
  const currentIds = new Set(sourceRefs.map((source) => source.sessionId));
  const changedIds = new Set<string>();

  for (const source of sourceRefs) {
    const cachedSession = sessionMap.get(source.sessionId);
    const cached = cachedMeta[source.sessionId];
    const sameSource = sourcePathFromMeta(cached) === source.sourcePath;
    const sameFingerprint =
      cachedSession && sourceFingerprintMatches(source, cachedSession, cached);
    if (cachedSession && sameSource && sameFingerprint) continue;

    const next = agent.scanSessionSource(source.sourcePath);
    changedIds.add(source.sessionId);
    if (next) {
      sessionMap.set(next.id, next);
    } else {
      sessionMap.delete(source.sessionId);
    }
  }

  for (const session of cachedSessions) {
    if (!currentIds.has(session.id)) {
      sessionMap.delete(session.id);
      changedIds.add(session.id);
    }
  }

  return { sessions: [...sessionMap.values()], changedIds: [...changedIds] };
}

const data = workerData as ScanRefreshWorkerData;
const startedAt = performance.now();

async function run(): Promise<void> {
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
    const result = syncAgentSources(agent, data.previousSessions, data.meta);
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
            progress,
          } satisfies ScanRefreshWorkerMessage);
        },
      }),
    );
  }

  parentPort?.postMessage({
    type: "done",
    sessions,
    meta: serializeMeta(agent),
    changedIds,
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}

try {
  await run();
} catch (error) {
  parentPort?.postMessage({
    type: "error",
    error: error instanceof Error ? error.message : String(error),
    durationMs: performance.now() - startedAt,
  } satisfies ScanRefreshWorkerMessage);
}
