import { Worker } from "node:worker_threads";
import type {
  AgentScanProgress,
  ScanOptions,
  SessionCacheMeta,
  SessionHead,
  SessionHeadChange,
} from "@codesesh/core";
import { appLogger } from "./logging.js";
import type {
  ScanRefreshWorkerCheckpoint,
  ScanRefreshWorkerMessage,
  ScanRefreshWorkerRequest,
} from "./scan-refresh-worker.js";
import { toError } from "./errors.js";

export interface WorkerPayload {
  previousSessions: SessionHead[];
  changedIds: string[] | null;
  sourceSync?: boolean;
  backfill?: boolean;
  backfillCursor?: string | null;
  checkpoint?: boolean;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
  onProgress?: (progress: AgentScanProgress) => void;
  onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void;
}

export interface WorkerResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  changedIds?: string[];
}

export interface WorkerRunner {
  readonly activeCount: number;
  run(agentName: string, payload: WorkerPayload): Promise<WorkerResult>;
  shutdown(): Promise<void>;
}

interface PendingRequest {
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  payload: WorkerPayload;
  onProgress?: (progress: AgentScanProgress) => void;
  onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void;
}

interface WorkerSlot {
  worker: Worker;
  pending: Map<number, PendingRequest>;
  closed: boolean;
}

const SHUTDOWN_ERROR_MESSAGE = "Scan refresh worker shut down";

function applySessionChanges(
  previousSessions: SessionHead[],
  changes: SessionHeadChange[],
  removedSessionIds: string[],
): SessionHead[] {
  const replacedIds = new Set(removedSessionIds);
  for (const { session } of changes) replacedIds.add(session.id);
  const retained = previousSessions.filter((session) => !replacedIds.has(session.id));
  const next: Array<SessionHead | undefined> = Array.from({
    length: retained.length + changes.length,
  });

  for (const { session, sortIndex } of changes) {
    if (sortIndex < 0 || sortIndex >= next.length || next[sortIndex]) {
      throw new Error(`Invalid scan refresh sort index: ${sortIndex}`);
    }
    next[sortIndex] = session;
  }

  let retainedIndex = 0;
  for (let index = 0; index < next.length; index += 1) {
    if (!next[index]) next[index] = retained[retainedIndex++];
  }
  if (retainedIndex !== retained.length || next.some((session) => !session)) {
    throw new Error("Invalid scan refresh delta");
  }
  return next as SessionHead[];
}

function applyMetaChanges(
  previous: Record<string, SessionCacheMeta>,
  changed: Record<string, SessionCacheMeta>,
  replacedSessionIds: Iterable<string>,
): Record<string, SessionCacheMeta> {
  const next = { ...previous };
  for (const id of replacedSessionIds) delete next[id];
  return Object.assign(next, changed);
}

export class ThreadWorkerRunner implements WorkerRunner {
  private workers = new Map<string, WorkerSlot>();
  private nextRequestId = 1;
  private isShuttingDown = false;

  constructor(private readonly workerUrl: URL) {}

  get activeCount(): number {
    let count = 0;
    for (const slot of this.workers.values()) count += slot.pending.size;
    return count;
  }

  run(agentName: string, payload: WorkerPayload): Promise<WorkerResult> {
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    const request: ScanRefreshWorkerRequest = {
      type: "run",
      requestId: this.nextRequestId++,
      agentName,
      previousSessions: payload.previousSessions,
      changedIds: payload.changedIds,
      sourceSync: payload.sourceSync,
      backfill: payload.backfill,
      backfillCursor: payload.backfillCursor,
      checkpoint: payload.checkpoint,
      scanOptions: payload.scanOptions,
      meta: payload.meta,
    };

    return new Promise((resolve, reject) => {
      let slot = this.workers.get(agentName);
      const isNewWorker = !slot;
      if (!slot) {
        try {
          slot = this.createWorker(agentName, request);
        } catch (error) {
          reject(toError(error));
          return;
        }
      }

      slot.pending.set(request.requestId, {
        resolve,
        reject,
        payload,
        onProgress: payload.onProgress,
        onCheckpoint: payload.onCheckpoint,
      });

      if (!isNewWorker) {
        try {
          slot.worker.postMessage(request);
        } catch (error) {
          slot.pending.delete(request.requestId);
          reject(toError(error));
        }
      }
    });
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const slots = [...this.workers.values()];
    this.workers.clear();
    const shutdownError = new Error(SHUTDOWN_ERROR_MESSAGE);
    for (const slot of slots) {
      slot.closed = true;
      for (const pending of slot.pending.values()) pending.reject(shutdownError);
      slot.pending.clear();
    }
    await Promise.allSettled(slots.map((slot) => slot.worker.terminate()));
  }

  private createWorker(agentName: string, request: ScanRefreshWorkerRequest): WorkerSlot {
    const worker = new Worker(this.workerUrl, { workerData: request });
    const slot: WorkerSlot = { worker, pending: new Map(), closed: false };
    worker.unref();
    this.workers.set(agentName, slot);
    worker.on("message", (message: ScanRefreshWorkerMessage) => {
      this.handleMessage(slot, message);
    });
    worker.on("error", (error) => {
      this.closeWorker(agentName, slot, toError(error));
    });
    worker.on("exit", (code) => {
      if (slot.closed) return;
      const error = new Error(`Scan refresh worker exited before completing (code ${code})`);
      if (slot.pending.size > 0) {
        appLogger.warn("scan.refresh_worker.exit_before_done", { agent: agentName, code });
      }
      this.closeWorker(agentName, slot, error);
    });
    return slot;
  }

  private handleMessage(slot: WorkerSlot, message: ScanRefreshWorkerMessage): void {
    const pending = slot.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === "progress") {
      pending.onProgress?.(message.progress);
      return;
    }
    if (message.type === "checkpoint") {
      try {
        pending.onCheckpoint?.(message.checkpoint);
      } catch (error) {
        slot.pending.delete(message.requestId);
        pending.reject(toError(error));
      }
      return;
    }

    slot.pending.delete(message.requestId);
    if (message.type === "error") {
      pending.reject(new Error(message.error));
      return;
    }
    const changedIds = message.changes.map(({ session }) => session.id);
    const replacedSessionIds = [...changedIds, ...message.removedSessionIds];
    const removedMetaIds = [...message.removedSessionIds, ...message.removedMetaIds];
    try {
      pending.resolve({
        sessions: applySessionChanges(
          pending.payload.previousSessions,
          message.changes,
          message.removedSessionIds,
        ),
        meta: applyMetaChanges(pending.payload.meta, message.meta, removedMetaIds),
        changedIds: pending.payload.sourceSync ? replacedSessionIds : undefined,
      });
    } catch (error) {
      pending.reject(toError(error));
    }
  }

  private closeWorker(agentName: string, slot: WorkerSlot, error: Error): void {
    if (slot.closed) return;
    slot.closed = true;
    if (this.workers.get(agentName) === slot) this.workers.delete(agentName);
    for (const pending of slot.pending.values()) pending.reject(error);
    slot.pending.clear();
  }
}
