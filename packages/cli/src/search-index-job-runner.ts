import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getPricingGeneration } from "@codesesh/core/runtime/pricing";
import { toError } from "./errors.js";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { PendingSearchIndexJobs, type SearchIndexJobBatch } from "./pending-search-index-jobs.js";
import type {
  SearchIndexWorkerJob,
  SearchIndexWorkerMessage,
  SearchIndexPublicationProgress,
  SearchIndexWorkerRunRequest,
} from "./search-index-worker.js";
import { terminateWorkerAfterLogDrain } from "./worker-log-drain.js";

const SHUTDOWN_ERROR_MESSAGE = "Live scan store shut down";

export interface SearchIndexJobRunnerSnapshot {
  activeBatchId?: number;
  pendingBatches: number;
  pendingJobs: number;
  pendingChanges: number;
  pendingMaintenanceBatches: number;
  pendingMaintenanceJobs: number;
}

export class SearchIndexJobRunner {
  private worker: Worker | null = null;
  private activeBatch: SearchIndexJobBatch | null = null;
  private nextBatchId = 1;
  private pendingJobs = new PendingSearchIndexJobs();
  private pendingMaintenanceJobs = new PendingSearchIndexJobs();
  private isShuttingDown = false;
  private retirements = new Set<Promise<number>>();

  enqueue(
    context: string,
    jobs: SearchIndexWorkerJob[],
    onStarted?: () => void,
    onProgress?: (progress: SearchIndexPublicationProgress) => void,
  ): Promise<void> {
    return this.enqueueIn(this.pendingJobs, context, jobs, onStarted, onProgress);
  }

  enqueueMaintenance(context: string, jobs: SearchIndexWorkerJob[]): Promise<void> {
    return this.enqueueIn(this.pendingMaintenanceJobs, context, jobs);
  }

  private enqueueIn(
    queue: PendingSearchIndexJobs,
    context: string,
    jobs: SearchIndexWorkerJob[],
    onStarted?: () => void,
    onProgress?: (progress: SearchIndexPublicationProgress) => void,
  ): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    const batchId = this.nextBatchId++;
    const completion = queue.enqueue(
      batchId,
      context,
      jobs,
      onStarted,
      onProgress,
      appLogger.captureContext(),
    );
    if (this.activeBatch) {
      const snapshot = this.snapshot();
      appLogger.debug("search_index.worker_queued", {
        batch_id: batchId,
        context,
        jobs: jobs.length,
        pending_batches: snapshot.pendingBatches,
        pending_jobs: snapshot.pendingJobs,
        pending_changes: snapshot.pendingChanges,
      });
    } else {
      this.startNextBatch();
    }
    return completion;
  }

  snapshot(): SearchIndexJobRunnerSnapshot {
    return {
      activeBatchId: this.activeBatch?.id,
      pendingBatches: this.pendingJobs.batchCount,
      pendingJobs: this.pendingJobs.jobCount,
      pendingChanges: this.pendingJobs.changeCount,
      pendingMaintenanceBatches: this.pendingMaintenanceJobs.batchCount,
      pendingMaintenanceJobs: this.pendingMaintenanceJobs.jobCount,
    };
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    const activeBatch = this.activeBatch;
    const worker = this.worker;
    this.activeBatch = null;
    this.worker = null;

    const shutdownError = new Error(SHUTDOWN_ERROR_MESSAGE);
    if (activeBatch) this.settle(activeBatch, shutdownError);
    this.pendingJobs.rejectAll(shutdownError);
    this.pendingMaintenanceJobs.rejectAll(shutdownError);
    const activeRetirement = worker ? this.retireWorker(worker) : null;
    const retirements = [...this.retirements];
    try {
      if (activeRetirement) await activeRetirement;
    } finally {
      await Promise.allSettled(retirements);
    }
  }

  private startNextBatch(): void {
    if (this.isShuttingDown || this.activeBatch) return;
    const batch = this.pendingJobs.take() ?? this.pendingMaintenanceJobs.take();
    if (!batch) return;

    appLogger.restoreContext(batch.logContext, () => {
      appLogger.info("search_index.worker_dequeued", {
        batch_id: batch.id,
        context: batch.context,
        pending_batches: this.pendingJobs.batchCount,
      });
      batch.start((error) => {
        appLogger.error("search_index.worker_start_listener_failed", {
          batch_id: batch.id,
          context: batch.context,
          error: toError(error),
        });
      });
      this.startBatch(batch);
    });
  }

  private startBatch(batch: SearchIndexJobBatch): void {
    if (this.isShuttingDown) {
      this.settle(batch, new Error(SHUTDOWN_ERROR_MESSAGE));
      return;
    }

    const request: SearchIndexWorkerRunRequest = {
      type: "run",
      pricingGenerationId: getPricingGeneration().id,
      context: batch.context,
      logContext: batch.logContext,
      jobs: batch.jobs,
    };
    const existingWorker = this.worker;
    if (existingWorker) {
      this.activeBatch = batch;
      try {
        existingWorker.postMessage(request);
      } catch (error) {
        this.invalidateWorker(existingWorker, toError(error));
      }
      return;
    }

    const workerUrl = this.workerUrl();
    if (!workerUrl) {
      appLogger.warn("search_index.worker_missing", { context: batch.context });
      this.settle(batch, new Error("Search index worker is unavailable"));
      this.startNextBatch();
      return;
    }
    appLogger.info("search_index.worker_started", {
      batch_id: batch.id,
      context: batch.context,
      jobs: batch.jobs.length,
    });

    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { workerData: request });
    } catch (error) {
      this.settle(batch, toError(error));
      this.startNextBatch();
      return;
    }
    this.worker = worker;
    this.activeBatch = batch;

    worker.on("message", (message: SearchIndexWorkerMessage) => {
      if (appLogger.consumeWorkerMessage(message)) return;
      if (this.worker !== worker) return;
      const activeBatch = this.activeBatch;
      if (!activeBatch) return;
      appLogger.restoreContext(activeBatch.logContext, () => {
        this.handleWorkerMessage(activeBatch, message);
      });
    });
    worker.on("error", (error) => {
      const activeBatch = this.worker === worker ? this.activeBatch : null;
      appLogger.restoreContext(activeBatch?.logContext ?? {}, () => {
        appLogger.error("search_index.worker_error", {
          context: activeBatch?.context,
          error,
        });
        this.invalidateWorker(worker, toError(error));
      });
    });
    worker.on("exit", (code) => {
      const activeBatch = this.worker === worker ? this.activeBatch : null;
      appLogger.restoreContext(activeBatch?.logContext ?? {}, () =>
        this.finishWorker(worker, code),
      );
    });
  }

  private handleWorkerMessage(
    activeBatch: SearchIndexJobBatch,
    message: SearchIndexWorkerMessage,
  ): void {
    if (message.type === "publication-progress") {
      const { agentName, stage } = message;
      activeBatch.progress({ agentName, stage }, (error) => {
        appLogger.error("search_index.worker_progress_listener_failed", {
          batch_id: activeBatch.id,
          context: activeBatch.context,
          error: toError(error),
        });
      });
      return;
    }
    if (message.type === "sync-result") {
      logSearchIndexSync(message.context, message.result);
      return;
    }
    if (message.type === "persist-failed") {
      appLogger.error("search_index.persist_failed", {
        batch_id: activeBatch.id,
        context: message.context,
        stage: message.stage,
        publication_id: message.publicationId,
        agent: message.agentName,
        sessions: message.sessions,
      });
      // Non-fatal failures keep the batch running: the worker continues
      // with the remaining agents and reports them in the done message.
      if (message.fatal) {
        this.finishBatch(
          activeBatch,
          new Error(
            `Search index worker failed to persist ${message.stage} for ${message.agentName}`,
          ),
        );
      }
      return;
    }
    if (message.type !== "done") return;

    if (message.failedAgents.length > 0) {
      appLogger.warn("search_index.batch_partial", {
        batch_id: activeBatch.id,
        context: message.context,
        failed_agents: message.failedAgents,
      });
    }
    appLogger.info(`${message.context}.done`, {
      duration_ms: Math.round(message.durationMs),
      sessions: message.sessions,
    });
    this.finishBatch(activeBatch);
  }

  private finishBatch(batch: SearchIndexJobBatch, error?: Error): void {
    if (this.activeBatch !== batch) return;
    this.activeBatch = null;
    this.settle(batch, error);
    this.startNextBatch();
  }

  private invalidateWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    const batch = this.activeBatch;
    this.activeBatch = null;
    if (batch) this.settle(batch, error);
    void this.retireWorker(worker);
    this.startNextBatch();
  }

  private finishWorker(worker: Worker, code: number): void {
    const batch = this.worker === worker ? this.activeBatch : null;
    appLogger.info("search_index.worker_exited", {
      batch_id: batch?.id,
      context: batch?.context,
      code,
      shutting_down: this.isShuttingDown || undefined,
    });
    if (this.worker !== worker) return;
    this.worker = null;
    this.activeBatch = null;

    if (batch) {
      const error =
        code === 0
          ? new Error("Search index worker exited before completing its batch")
          : new Error(`Search index worker exited with code ${code}`);
      if (code !== 0) {
        appLogger.warn("search_index.worker_exit", { context: batch.context, code });
      }
      this.settle(batch, error);
    }
    this.startNextBatch();
  }

  private settle(batch: SearchIndexJobBatch, error?: Error): void {
    appLogger.restoreContext(batch.logContext, () => {
      if (
        !this.pendingJobs.settle(batch, error) &&
        !this.pendingMaintenanceJobs.settle(batch, error)
      ) {
        return;
      }
      appLogger.info("search_index.worker_settled", {
        batch_id: batch.id,
        context: batch.context,
        result: error ? "rejected" : "resolved",
      });
    });
  }

  private retireWorker(worker: Worker): Promise<number> {
    const retirement = terminateWorkerAfterLogDrain(worker);
    this.retirements.add(retirement);
    void retirement.finally(() => this.retirements.delete(retirement)).catch(() => undefined);
    return retirement;
  }

  private workerUrl(): URL | null {
    const workerUrl = new URL("./search-index-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) return null;
    return workerUrl;
  }
}
