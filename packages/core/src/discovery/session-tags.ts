import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { BaseAgent, SessionCacheMeta } from "../agents/index.js";
import type { SessionDetail, SessionHead, SmartTag } from "../types/index.js";
import {
  classifySessionTags,
  getSmartTagSourceTimestamp,
  isWorkerLogMessage,
  SMART_TAG_CLASSIFIER_REVISION,
  type WorkerLogMessage,
} from "../utils/index.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { getPricingGeneration } from "../pricing/index.js";
import { buildAgentCacheMeta } from "./orchestrate.js";

export interface SessionTagTiming {
  sessions: number;
  cacheHits: number;
  staleSessions: number;
  failedSessions: number;
  getSessionDataCalls: number;
  getSessionDataMs: number;
  classifySessionTagsCalls: number;
  classifySessionTagsMs: number;
}

interface SmartTagWorkerResult {
  id: string;
  tags?: SmartTag[];
  sourceUpdatedAt?: number;
  error?: string;
}

const SMART_TAG_WORKER_TIMEOUT_MS = 300_000;

export function hasStaleSessionTags(
  session: SessionHead,
  classifierRevision = SMART_TAG_CLASSIFIER_REVISION,
): boolean {
  const sourceUpdatedAt = session.time_updated ?? session.time_created;
  return (
    !Array.isArray(session.smart_tags) ||
    session.smart_tags_source_updated_at !== sourceUpdatedAt ||
    session.smart_tags_classifier_revision !== classifierRevision
  );
}

/** Preserve cached tags until the shared freshness check proves they need recomputing. */
export function inheritSessionTags(
  sessions: SessionHead[],
  previousSessions: SessionHead[],
): SessionHead[] {
  const previousById = new Map(
    previousSessions.map((session) => [session.reference.sessionId, session]),
  );
  return sessions.map((session) => {
    if (Array.isArray(session.smart_tags)) return session;
    const previous = previousById.get(session.reference.sessionId);
    if (!previous || !Array.isArray(previous.smart_tags)) return session;
    return {
      ...session,
      smart_tags: previous.smart_tags,
      smart_tags_source_updated_at: previous.smart_tags_source_updated_at,
      smart_tags_classifier_revision: previous.smart_tags_classifier_revision,
    };
  });
}

export function ensureSessionTagsSync(
  agent: BaseAgent,
  sessions: SessionHead[],
  onProgress?: (processed: number, total: number) => void,
  classifierRevision = SMART_TAG_CLASSIFIER_REVISION,
): { sessions: SessionHead[]; changed: boolean; timing: SessionTagTiming } {
  let changed = false;
  let processed = 0;
  const total = sessions.length;
  const timing: SessionTagTiming = {
    sessions: total,
    cacheHits: 0,
    staleSessions: 0,
    failedSessions: 0,
    getSessionDataCalls: 0,
    getSessionDataMs: 0,
    classifySessionTagsCalls: 0,
    classifySessionTagsMs: 0,
  };

  const tagged = sessions.map((session) => {
    if (!hasStaleSessionTags(session, classifierRevision)) {
      timing.cacheHits += 1;
      processed += 1;
      onProgress?.(processed, total);
      return session;
    }

    timing.staleSessions += 1;
    try {
      timing.getSessionDataCalls += 1;
      const getSessionDataStartedAt = performance.now();
      let data: SessionDetail;
      try {
        data = agent.getSessionData(session.reference.sessionId);
      } finally {
        timing.getSessionDataMs += performance.now() - getSessionDataStartedAt;
      }

      timing.classifySessionTagsCalls += 1;
      const classifySessionTagsStartedAt = performance.now();
      let tags: SmartTag[];
      try {
        tags = classifySessionTags(data);
      } finally {
        timing.classifySessionTagsMs += performance.now() - classifySessionTagsStartedAt;
      }

      changed = true;
      return {
        ...session,
        smart_tags: tags,
        smart_tags_source_updated_at: getSmartTagSourceTimestamp(data),
        smart_tags_classifier_revision: classifierRevision,
      };
    } catch {
      timing.failedSessions += 1;
      return session;
    } finally {
      processed += 1;
      onProgress?.(processed, total);
    }
  });

  return { sessions: tagged, changed, timing };
}

function getSmartTagWorkerCount(sessionCount: number): number {
  if (sessionCount < 50) return 1;
  return Math.min(sessionCount, Math.max(1, Math.min(4, availableParallelism() - 1)));
}

function chunkSessions<T>(items: T[], chunkCount: number): T[][] {
  const chunks = Array.from({ length: chunkCount }, () => [] as T[]);
  items.forEach((item, index) => {
    chunks[index % chunkCount]!.push(item);
  });
  return chunks.filter((chunk) => chunk.length > 0);
}

async function classifySessionTagsInWorker(
  workerUrl: URL | string,
  agentName: string,
  sessionIds: string[],
  meta: Record<string, SessionCacheMeta>,
): Promise<SmartTagWorkerResult[]> {
  const worker = new Worker(workerUrl, {
    workerData: {
      pricingGenerationId: getPricingGeneration().id,
      agentName,
      sessionIds,
      meta,
    },
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<SmartTagWorkerResult[]>((resolveWorker, rejectWorker) => {
      timer = setTimeout(() => {
        rejectWorker(
          new Error(`Smart tag worker timed out after ${SMART_TAG_WORKER_TIMEOUT_MS}ms`),
        );
      }, SMART_TAG_WORKER_TIMEOUT_MS);
      worker.on("message", (message: unknown) => {
        if (isWorkerLogMessage(message)) {
          relayWorkerLogMessage(message);
          return;
        }
        const results = message as SmartTagWorkerResult[];
        // A non-empty request with no results means the worker failed before
        // classification, so fall back instead of publishing untagged sessions.
        if (results.length === 0 && sessionIds.length > 0) {
          rejectWorker(new Error("Smart tag worker returned no results"));
          return;
        }
        resolveWorker(results);
      });
      worker.once("error", rejectWorker);
      // A clean exit before a result is still a failure; otherwise this promise
      // remains pending and blocks startup indefinitely.
      worker.once("exit", (code) => {
        rejectWorker(new Error(`Smart tag worker exited with code ${code} before responding`));
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    worker.terminate().catch(() => {});
  }
}

function relayWorkerLogMessage(message: WorkerLogMessage): void {
  const detail = {
    ...message.data,
    worker_ts: message.ts,
    worker_pid: message.pid,
    worker_thread_id: message.threadId,
    worker_level: message.level,
  };
  if (message.level === "warn" || message.level === "error") {
    getCoreDiagnostics()?.warn(message.event, detail);
    return;
  }
  getCoreDiagnostics()?.info?.(message.event, detail);
}

export async function ensureSessionTags(
  agent: BaseAgent,
  sessions: SessionHead[],
  workerUrl?: URL | string,
): Promise<{ sessions: SessionHead[]; changed: boolean }> {
  const staleSessions = sessions.filter((session) => hasStaleSessionTags(session));
  if (staleSessions.length === 0) return { sessions, changed: false };

  const workerCount = workerUrl ? getSmartTagWorkerCount(staleSessions.length) : 1;
  if (workerCount <= 1) return ensureSessionTagsSync(agent, sessions);

  const meta = buildAgentCacheMeta(agent);
  try {
    const results = (
      await Promise.all(
        chunkSessions(
          staleSessions.map((session) => session.reference.sessionId),
          workerCount,
        ).map((sessionIds) =>
          classifySessionTagsInWorker(workerUrl!, agent.name, sessionIds, meta),
        ),
      )
    ).flat();
    const resultMap = new Map(results.filter((item) => item.tags).map((item) => [item.id, item]));

    return {
      changed: resultMap.size > 0,
      sessions: sessions.map((session) => {
        const result = resultMap.get(session.reference.sessionId);
        if (!result?.tags || result.sourceUpdatedAt == null) return session;
        return {
          ...session,
          smart_tags: result.tags,
          smart_tags_source_updated_at: result.sourceUpdatedAt,
          smart_tags_classifier_revision: SMART_TAG_CLASSIFIER_REVISION,
        };
      }),
    };
  } catch {
    return ensureSessionTagsSync(agent, sessions);
  }
}
