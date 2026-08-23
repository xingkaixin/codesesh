import { Worker } from "node:worker_threads";
import {
  normalizeProjectDirectory,
  type ProjectIdentityProjection,
} from "@codesesh/core/runtime/projects";
import { appLogger } from "./logging.js";
import type {
  ProjectIdentityWorkerMessage,
  ProjectIdentityWorkerRequest,
} from "./project-identity-worker.js";

export const PROJECT_IDENTITY_RESOLVER_MAX_WORKERS = 2;
export const PROJECT_IDENTITY_RESOLVER_MAX_QUEUED_REQUESTS = 8;
export const PROJECT_IDENTITY_RESOLVER_TIMEOUT_MS = 2_000;

const SHUTDOWN_ERROR_MESSAGE = "Project identity resolver shut down";

export interface ProjectIdentityResolver {
  resolve(cwd: string, signal?: AbortSignal): Promise<ProjectIdentityProjection>;
  shutdown(): Promise<void>;
}

export interface ProjectIdentityResolverOptions {
  maxWorkers?: number;
  maxQueuedRequests?: number;
  timeoutMs?: number;
}

export class ProjectIdentityQueueFullError extends Error {
  constructor() {
    super("Project identity resolver queue is full");
    this.name = "ProjectIdentityQueueFullError";
  }
}

export class ProjectIdentityTimeoutError extends Error {
  constructor() {
    super("Project identity resolution timed out");
    this.name = "ProjectIdentityTimeoutError";
  }
}

export class ProjectIdentityRequestAbortedError extends Error {
  constructor() {
    super("Project identity resolution was aborted");
    this.name = "ProjectIdentityRequestAbortedError";
  }
}

interface RequestSubscriber {
  resolve: (projection: ProjectIdentityProjection) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface PendingRequest {
  requestId: number;
  cwd: string;
  subscribers: Set<RequestSubscriber>;
  timeout: ReturnType<typeof setTimeout> | null;
}

interface WorkerSlot {
  worker: Worker;
  pending: PendingRequest | null;
  closed: boolean;
  retirement: Promise<void> | null;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function requireSafeInteger(value: number, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
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
  private readonly requestsByDirectory = new Map<string, PendingRequest>();
  private readonly maxWorkers: number;
  private readonly maxOutstandingRequests: number;
  private readonly timeoutMs: number;
  private nextRequestId = 1;
  private isShuttingDown = false;

  constructor(
    private readonly workerUrl: URL,
    options: ProjectIdentityResolverOptions = {},
  ) {
    this.maxWorkers = requireSafeInteger(
      options.maxWorkers ?? PROJECT_IDENTITY_RESOLVER_MAX_WORKERS,
      1,
      "maxWorkers",
    );
    const maxQueuedRequests = requireSafeInteger(
      options.maxQueuedRequests ?? PROJECT_IDENTITY_RESOLVER_MAX_QUEUED_REQUESTS,
      0,
      "maxQueuedRequests",
    );
    this.timeoutMs = requireSafeInteger(
      options.timeoutMs ?? PROJECT_IDENTITY_RESOLVER_TIMEOUT_MS,
      1,
      "timeoutMs",
    );
    this.maxOutstandingRequests = requireSafeInteger(
      this.maxWorkers + maxQueuedRequests,
      this.maxWorkers,
      "request capacity",
    );
  }

  resolve(cwd: string, signal?: AbortSignal): Promise<ProjectIdentityProjection> {
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));
    if (signal?.aborted) return Promise.reject(new ProjectIdentityRequestAbortedError());

    const normalizedCwd = normalizeProjectDirectory(cwd);
    let request = this.requestsByDirectory.get(normalizedCwd);
    if (!request) {
      if (this.requestsByDirectory.size >= this.maxOutstandingRequests) {
        appLogger.warn("project_identity.queue.full", {
          active_workers: this.activeWorkerCount(),
          queued_requests: this.queue.length,
          request_capacity: this.maxOutstandingRequests,
        });
        return Promise.reject(new ProjectIdentityQueueFullError());
      }
      request = {
        requestId: this.nextRequestId++,
        cwd: normalizedCwd,
        subscribers: new Set(),
        timeout: null,
      };
      this.requestsByDirectory.set(normalizedCwd, request);
      this.queue.push(request);
    }

    const resolution = this.subscribe(request, signal);
    this.pump();
    return resolution;
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    const error = new Error(SHUTDOWN_ERROR_MESSAGE);
    while (this.queue.length > 0) this.rejectRequest(this.queue[0]!, error);

    const retirements = [...this.workers].map((slot) => this.retireWorker(slot, error));
    await Promise.allSettled(retirements);
    this.workers.clear();
  }

  private subscribe(
    request: PendingRequest,
    signal?: AbortSignal,
  ): Promise<ProjectIdentityProjection> {
    return new Promise((resolve, reject) => {
      const subscriber: RequestSubscriber = { resolve, reject, signal };
      request.subscribers.add(subscriber);
      if (!signal) return;

      subscriber.abortHandler = () => this.abortSubscriber(request, subscriber);
      signal.addEventListener("abort", subscriber.abortHandler, { once: true });
    });
  }

  private abortSubscriber(request: PendingRequest, subscriber: RequestSubscriber): void {
    if (!request.subscribers.delete(subscriber)) return;
    this.removeAbortHandler(subscriber);
    subscriber.reject(new ProjectIdentityRequestAbortedError());
    if (request.subscribers.size > 0) return;

    const slot = this.workerForRequest(request);
    if (slot) slot.pending = null;
    this.releaseRequest(request);
    if (slot) void this.retireWorker(slot);
    else this.pump();
  }

  private pump(): void {
    while (!this.isShuttingDown && this.queue.length > 0) {
      const slot = this.idleWorker() ?? this.createWorker();
      if (!slot) return;
      const request = this.queue.shift();
      if (!request) return;
      slot.pending = request;
      request.timeout = setTimeout(() => {
        if (slot.pending !== request || slot.closed) return;
        appLogger.warn("project_identity.request.timeout", {
          request_id: request.requestId,
          timeout_ms: this.timeoutMs,
        });
        void this.retireWorker(slot, new ProjectIdentityTimeoutError());
      }, this.timeoutMs);
      request.timeout.unref();
      try {
        slot.worker.postMessage({
          type: "resolve",
          requestId: request.requestId,
          cwd: request.cwd,
        } satisfies ProjectIdentityWorkerRequest);
      } catch (error) {
        void this.retireWorker(slot, toError(error));
      }
    }
  }

  private idleWorker(): WorkerSlot | null {
    for (const slot of this.workers) {
      if (!slot.closed && slot.pending == null) return slot;
    }
    return null;
  }

  private activeWorkerCount(): number {
    let count = 0;
    for (const slot of this.workers) {
      if (!slot.closed && slot.pending != null) count += 1;
    }
    return count;
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

    const slot: WorkerSlot = {
      worker,
      pending: null,
      closed: false,
      retirement: null,
    };
    this.workers.add(slot);
    worker.on("message", (message: unknown) => {
      if (appLogger.consumeWorkerMessage(message)) return;
      this.handleWorkerMessage(slot, message);
    });
    worker.on("error", (error) => {
      void this.retireWorker(slot, toError(error));
    });
    worker.on("exit", (code) => {
      if (!slot.closed) {
        this.closeExitedWorker(slot, new Error(`Project identity worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private handleWorkerMessage(slot: WorkerSlot, message: unknown): void {
    if (!isWorkerMessage(message) || slot.closed) return;
    const request = slot.pending;
    if (!request || message.requestId !== request.requestId) return;

    slot.pending = null;
    if (message.type === "resolved") this.resolveRequest(request, message.projection);
    else this.rejectRequest(request, new Error(message.error));
    this.pump();
  }

  private closeExitedWorker(slot: WorkerSlot, error: Error): void {
    slot.closed = true;
    this.workers.delete(slot);
    const request = slot.pending;
    slot.pending = null;
    if (request) this.rejectRequest(request, error);
    if (!this.isShuttingDown) this.pump();
  }

  private retireWorker(slot: WorkerSlot, error?: Error): Promise<void> {
    if (slot.retirement) return slot.retirement;
    slot.closed = true;
    const request = slot.pending;
    slot.pending = null;
    if (request && error) this.rejectRequest(request, error);

    const retirement = (async () => {
      try {
        await slot.worker.terminate();
      } catch (terminationError) {
        appLogger.warn("project_identity.worker.termination_failed", {
          error: toError(terminationError).message,
        });
      } finally {
        this.workers.delete(slot);
        if (!this.isShuttingDown) this.pump();
      }
    })();
    slot.retirement = retirement;
    return retirement;
  }

  private workerForRequest(request: PendingRequest): WorkerSlot | null {
    for (const slot of this.workers) {
      if (slot.pending === request) return slot;
    }
    return null;
  }

  private resolveRequest(request: PendingRequest, projection: ProjectIdentityProjection): void {
    this.releaseRequest(request);
    for (const subscriber of request.subscribers) {
      this.removeAbortHandler(subscriber);
      subscriber.resolve(projection);
    }
    request.subscribers.clear();
  }

  private rejectRequest(request: PendingRequest, error: Error): void {
    this.releaseRequest(request);
    for (const subscriber of request.subscribers) {
      this.removeAbortHandler(subscriber);
      subscriber.reject(error);
    }
    request.subscribers.clear();
  }

  private releaseRequest(request: PendingRequest): void {
    if (request.timeout) clearTimeout(request.timeout);
    request.timeout = null;
    if (this.requestsByDirectory.get(request.cwd) === request) {
      this.requestsByDirectory.delete(request.cwd);
    }
    const queueIndex = this.queue.indexOf(request);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
  }

  private removeAbortHandler(subscriber: RequestSubscriber): void {
    if (subscriber.signal && subscriber.abortHandler) {
      subscriber.signal.removeEventListener("abort", subscriber.abortHandler);
    }
  }

  private rejectQueued(error: Error): void {
    while (this.queue.length > 0) this.rejectRequest(this.queue[0]!, error);
  }
}

export function createProjectIdentityResolver(): ProjectIdentityResolver {
  return new ThreadProjectIdentityResolver(
    new URL("./project-identity-worker.js", import.meta.url),
  );
}
