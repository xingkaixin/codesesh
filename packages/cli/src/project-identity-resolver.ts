import { Worker } from "node:worker_threads";
import type { ProjectIdentityProjection } from "@codesesh/core";
import { appLogger } from "./logging.js";
import type {
  ProjectIdentityWorkerMessage,
  ProjectIdentityWorkerRequest,
} from "./project-identity-worker.js";

export const PROJECT_IDENTITY_RESOLVER_MAX_WORKERS = 2;

const SHUTDOWN_ERROR_MESSAGE = "Project identity resolver shut down";

export interface ProjectIdentityResolver {
  resolve(cwd: string): Promise<ProjectIdentityProjection>;
  shutdown(): Promise<void>;
}

interface PendingRequest {
  requestId: number;
  cwd: string;
  resolve: (projection: ProjectIdentityProjection) => void;
  reject: (error: Error) => void;
}

interface WorkerSlot {
  worker: Worker;
  pending: PendingRequest | null;
  closed: boolean;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isWorkerMessage(message: unknown): message is ProjectIdentityWorkerMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    ((message.type === "resolved" && "requestId" in message && "projection" in message) ||
      (message.type === "failed" && "requestId" in message && "error" in message))
  );
}

export class ThreadProjectIdentityResolver implements ProjectIdentityResolver {
  private readonly workers = new Set<WorkerSlot>();
  private readonly queue: PendingRequest[] = [];
  private nextRequestId = 1;
  private isShuttingDown = false;

  constructor(
    private readonly workerUrl: URL,
    private readonly maxWorkers = PROJECT_IDENTITY_RESOLVER_MAX_WORKERS,
  ) {}

  resolve(cwd: string): Promise<ProjectIdentityProjection> {
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    return new Promise((resolve, reject) => {
      this.queue.push({ requestId: this.nextRequestId++, cwd, resolve, reject });
      this.pump();
    });
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    const error = new Error(SHUTDOWN_ERROR_MESSAGE);
    for (const request of this.queue.splice(0)) request.reject(error);

    const workers = [...this.workers];
    this.workers.clear();
    for (const slot of workers) {
      slot.closed = true;
      slot.pending?.reject(error);
      slot.pending = null;
    }
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
  }

  private pump(): void {
    while (!this.isShuttingDown && this.queue.length > 0) {
      const slot = this.idleWorker() ?? this.createWorker();
      if (!slot) return;
      const request = this.queue.shift();
      if (!request) return;
      slot.pending = request;
      try {
        slot.worker.postMessage({
          type: "resolve",
          requestId: request.requestId,
          cwd: request.cwd,
        } satisfies ProjectIdentityWorkerRequest);
      } catch (error) {
        this.closeWorker(slot, toError(error));
      }
    }
  }

  private idleWorker(): WorkerSlot | null {
    for (const slot of this.workers) {
      if (!slot.closed && slot.pending == null) return slot;
    }
    return null;
  }

  private createWorker(): WorkerSlot | null {
    if (this.workers.size >= this.maxWorkers) return null;

    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl);
    } catch (error) {
      this.rejectQueued(toError(error));
      return null;
    }

    const slot: WorkerSlot = { worker, pending: null, closed: false };
    this.workers.add(slot);
    worker.unref();
    worker.on("message", (message: unknown) => {
      if (appLogger.consumeWorkerMessage(message)) return;
      this.handleWorkerMessage(slot, message);
    });
    worker.on("error", (error) => this.closeWorker(slot, toError(error)));
    worker.on("exit", (code) => {
      if (!slot.closed) {
        this.closeWorker(slot, new Error(`Project identity worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private handleWorkerMessage(slot: WorkerSlot, message: unknown): void {
    if (!isWorkerMessage(message) || slot.closed) return;
    const request = slot.pending;
    if (!request || message.requestId !== request.requestId) return;

    slot.pending = null;
    if (message.type === "resolved") request.resolve(message.projection);
    else request.reject(new Error(message.error));
    this.pump();
  }

  private closeWorker(slot: WorkerSlot, error: Error): void {
    if (slot.closed) return;
    slot.closed = true;
    this.workers.delete(slot);
    const request = slot.pending;
    slot.pending = null;
    request?.reject(error);
    if (!this.isShuttingDown) this.pump();
  }

  private rejectQueued(error: Error): void {
    for (const request of this.queue.splice(0)) request.reject(error);
  }
}

export function createProjectIdentityResolver(): ProjectIdentityResolver {
  return new ThreadProjectIdentityResolver(
    new URL("./project-identity-worker.js", import.meta.url),
  );
}
