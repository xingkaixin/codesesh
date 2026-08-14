import { Worker } from "node:worker_threads";
import {
  getPricingGeneration,
  type AgentScanProgress,
  type ScanOptions,
  type SessionCacheMeta,
  type SessionHead,
  type SessionHeadChange,
  type SessionSourceFailure,
  type SessionSnapshotCompleteness,
} from "@codesesh/core";
import { appLogger } from "./logging.js";
import type {
  ScanRefreshWorkerCommitRequest,
  ScanRefreshWorkerCheckpoint,
  ScanRefreshWorkerMessage,
  ScanRefreshWorkerRunRequest,
} from "./scan-refresh-worker.js";
import type { ScanRefreshOperation } from "./scan-refresh-operation.js";
import {
  AGENT_UNAVAILABLE_DURING_SCAN_ERROR_CODE,
  AgentUnavailableDuringScanError,
} from "./scan-refresh-error.js";
import { toError } from "./errors.js";

export interface WorkerPayload {
  previousSessions: SessionHead[];
  operation: ScanRefreshOperation;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
  onProgress?: (progress: AgentScanProgress) => void;
  onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void;
}

export interface WorkerResult {
  sessions: SessionHead[];
  meta: Record<string, SessionCacheMeta>;
  changedIds?: string[];
  sourceFailures?: SessionSourceFailure[];
  completeness: SessionSnapshotCompleteness;
  explicitRemovedSessionIds: string[];
}

export interface WorkerRunner {
  readonly activeCount: number;
  run(agentName: string, payload: WorkerPayload): Promise<WorkerResult>;
  commit?(agentName: string): void;
  discard?(agentName: string): void;
  shutdown(): Promise<void>;
}

interface PendingRequest {
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  payload: WorkerPayload;
  generation: number;
  onProgress?: (progress: AgentScanProgress) => void;
  onCheckpoint?: (checkpoint: ScanRefreshWorkerCheckpoint) => void;
}

interface WorkerSlot {
  agentName: string;
  worker: Worker;
  pending: Map<number, PendingRequest>;
  generation: number;
  awaitingCommit: { requestId: number; generation: number } | null;
  closed: boolean;
}

const SHUTDOWN_ERROR_MESSAGE = "Scan refresh worker shut down";

function applySessionChanges(
  previousSessions: SessionHead[],
  changes: SessionHeadChange[],
  removedSessionIds: string[],
): SessionHead[] {
  if (changes.length === 0 && removedSessionIds.length === 0) return previousSessions;
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
  const replacedIds = [...replacedSessionIds];
  if (Object.keys(changed).length === 0 && replacedIds.length === 0) return previous;
  const next = { ...previous };
  for (const id of replacedIds) delete next[id];
  return Object.assign(next, changed);
}

export class ThreadWorkerRunner implements WorkerRunner {
  private workers = new Map<string, WorkerSlot>();
  private nextRequestId = 1;
  private isShuttingDown = false;

  constructor(private readonly workerUrl: URL) {}

  get activeCount(): number {
    let count = 0;
    for (const slot of this.workers.values()) {
      count += slot.pending.size + Number(slot.awaitingCommit != null);
    }
    return count;
  }

  run(agentName: string, payload: WorkerPayload): Promise<WorkerResult> {
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    const existingSlot = this.workers.get(agentName);
    if (existingSlot && (existingSlot.pending.size > 0 || existingSlot.awaitingCommit)) {
      return Promise.reject(new Error(`Scan refresh worker for ${agentName} is busy`));
    }
    const generation = existingSlot?.generation ?? 0;
    const request: ScanRefreshWorkerRunRequest = {
      type: "run",
      requestId: this.nextRequestId++,
      agentName,
      generation,
      pricingGenerationId: getPricingGeneration().id,
      operation: payload.operation,
      scanOptions: payload.scanOptions,
      ...(existingSlot ? {} : { previousSessions: payload.previousSessions, meta: payload.meta }),
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
        generation,
        onProgress: payload.onProgress,
        onCheckpoint: payload.onCheckpoint,
      });

      if (!isNewWorker) {
        try {
          slot.worker.postMessage(request);
        } catch (error) {
          slot.pending.delete(request.requestId);
          reject(toError(error));
          this.invalidateWorker(agentName, slot);
        }
      }
    });
  }

  commit(agentName: string): void {
    const slot = this.workers.get(agentName);
    const awaiting = slot?.awaitingCommit;
    if (!slot || !awaiting) return;
    const request: ScanRefreshWorkerCommitRequest = {
      type: "commit",
      requestId: awaiting.requestId,
      generation: awaiting.generation,
    };
    try {
      slot.worker.postMessage(request);
      slot.awaitingCommit = null;
      slot.generation += 1;
    } catch {
      this.invalidateWorker(agentName, slot);
    }
  }

  discard(agentName: string): void {
    const slot = this.workers.get(agentName);
    if (slot) this.invalidateWorker(agentName, slot);
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

  private createWorker(agentName: string, request: ScanRefreshWorkerRunRequest): WorkerSlot {
    const worker = new Worker(this.workerUrl, { workerData: request });
    const slot: WorkerSlot = {
      agentName,
      worker,
      pending: new Map(),
      generation: request.generation,
      awaitingCommit: null,
      closed: false,
    };
    worker.unref();
    this.workers.set(agentName, slot);
    worker.on("message", (message: unknown) => {
      if (appLogger.consumeWorkerMessage(message)) return;
      this.handleMessage(slot, message as ScanRefreshWorkerMessage);
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
    if (message.generation !== pending.generation) {
      const error = new Error(
        `Scan refresh generation mismatch: expected ${pending.generation}, received ${message.generation}`,
      );
      slot.pending.delete(message.requestId);
      pending.reject(error);
      this.invalidateWorker(slot.agentName, slot);
      return;
    }
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
        this.invalidateWorker(slot.agentName, slot);
      }
      return;
    }

    slot.pending.delete(message.requestId);
    if (message.type === "error") {
      pending.reject(
        message.errorCode === AGENT_UNAVAILABLE_DURING_SCAN_ERROR_CODE
          ? new AgentUnavailableDuringScanError(slot.agentName)
          : new Error(message.error),
      );
      this.invalidateWorker(slot.agentName, slot);
      return;
    }
    const changedIds = message.changes.map(({ session }) => session.id);
    const replacedSessionIds = [...changedIds, ...message.removedSessionIds];
    const removedMetaIds = [...message.removedSessionIds, ...message.removedMetaIds];
    try {
      const result = {
        sessions: applySessionChanges(
          pending.payload.previousSessions,
          message.changes,
          message.removedSessionIds,
        ),
        meta: applyMetaChanges(pending.payload.meta, message.meta, removedMetaIds),
        changedIds: replacedSessionIds,
        sourceFailures: message.sourceFailures,
        completeness: message.completeness,
        explicitRemovedSessionIds: message.explicitRemovedSessionIds,
      };
      slot.awaitingCommit = {
        requestId: message.requestId,
        generation: message.generation,
      };
      pending.resolve(result);
    } catch (error) {
      pending.reject(toError(error));
      this.invalidateWorker(slot.agentName, slot);
    }
  }

  private closeWorker(agentName: string, slot: WorkerSlot, error: Error): void {
    if (slot.closed) return;
    slot.closed = true;
    if (this.workers.get(agentName) === slot) this.workers.delete(agentName);
    for (const pending of slot.pending.values()) pending.reject(error);
    slot.pending.clear();
    slot.awaitingCommit = null;
  }

  private invalidateWorker(agentName: string, slot: WorkerSlot): void {
    this.closeWorker(
      agentName,
      slot,
      new Error(`Scan refresh worker state discarded for ${agentName}`),
    );
    void slot.worker.terminate().catch(() => undefined);
  }
}
