import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getPricingGeneration } from "@codesesh/core";
import { toError } from "./errors.js";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { PendingSearchIndexJobs, type SearchIndexJobBatch } from "./pending-search-index-jobs.js";
import type {
  SearchIndexWorkerJob,
  SearchIndexWorkerMessage,
  SearchIndexWorkerRunRequest,
} from "./search-index-worker.js";

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

  enqueue(context: string, jobs: SearchIndexWorkerJob[], onStarted?: () => void): Promise<void> {
    return this.enqueueIn(this.pendingJobs, context, jobs, onStarted);
  }

  enqueueMaintenance(context: string, jobs: SearchIndexWorkerJob[]): Promise<void> {
    return this.enqueueIn(this.pendingMaintenanceJobs, context, jobs);
  }

  private enqueueIn(
    queue: PendingSearchIndexJobs,
    context: string,
    jobs: SearchIndexWorkerJob[],
    onStarted?: () => void,
  ): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    const batchId = this.nextBatchId++;
    const completion = queue.enqueue(batchId, context, jobs, onStarted);
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
    if (worker) await worker.terminate();
  }

  private startNextBatch(): void {
    if (this.isShuttingDown || this.activeBatch) return;
    const batch = this.pendingJobs.take() ?? this.pendingMaintenanceJobs.take();
    if (!batch) return;

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
    worker.unref();
    this.worker = worker;
    this.activeBatch = batch;

    worker.on("message", (message: SearchIndexWorkerMessage) => {
      if (appLogger.consumeWorkerMessage(message)) return;
      if (this.worker !== worker) return;
      const activeBatch = this.activeBatch;
      if (!activeBatch) return;
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
        this.finishBatch(
          activeBatch,
          new Error(
            `Search index worker failed to persist ${message.stage} for ${message.agentName}`,
          ),
        );
        return;
      }
      if (message.type !== "done") return;

      appLogger.info(`${message.context}.done`, {
        duration_ms: Math.round(message.durationMs),
        sessions: message.sessions,
      });
      this.finishBatch(activeBatch);
    });
    worker.on("error", (error) => {
      appLogger.error("search_index.worker_error", {
        context: this.activeBatch?.context ?? batch.context,
        error,
      });
      this.invalidateWorker(worker, toError(error));
    });
    worker.on("exit", (code) => this.finishWorker(worker, code));
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
    void worker.terminate();
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
  }

  private workerUrl(): URL | null {
    const workerUrl = new URL("./search-index-worker.js", import.meta.url);
    if (workerUrl.protocol === "file:" && !existsSync(fileURLToPath(workerUrl))) return null;
    return workerUrl;
  }
}
