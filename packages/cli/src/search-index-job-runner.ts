import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { appLogger, logSearchIndexSync } from "./logging.js";
import { PendingSearchIndexJobs, type SearchIndexJobBatch } from "./pending-search-index-jobs.js";
import type { SearchIndexWorkerJob, SearchIndexWorkerMessage } from "./search-index-worker.js";

const SHUTDOWN_ERROR_MESSAGE = "Live scan store shut down";

export interface SearchIndexJobRunnerSnapshot {
  activeBatchId?: number;
  pendingBatches: number;
  pendingJobs: number;
  pendingChanges: number;
}

export class SearchIndexJobRunner {
  private worker: Worker | null = null;
  private activeBatch: SearchIndexJobBatch | null = null;
  private nextBatchId = 1;
  private pendingJobs = new PendingSearchIndexJobs();
  private isShuttingDown = false;
  private hasCheckedFtsIntegrity = false;

  enqueue(context: string, jobs: SearchIndexWorkerJob[]): Promise<void> {
    if (jobs.length === 0) return Promise.resolve();
    if (this.isShuttingDown) return Promise.reject(new Error(SHUTDOWN_ERROR_MESSAGE));

    const batchId = this.nextBatchId++;
    const completion = this.pendingJobs.enqueue(batchId, context, jobs);
    if (this.worker) {
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
    if (worker) await worker.terminate();
  }

  private startNextBatch(): void {
    if (this.isShuttingDown || this.worker) return;
    const batch = this.pendingJobs.take();
    if (!batch) return;

    appLogger.info("search_index.worker_dequeued", {
      batch_id: batch.id,
      context: batch.context,
      pending_batches: this.pendingJobs.batchCount,
    });
    this.startBatch(batch);
  }

  private startBatch(batch: SearchIndexJobBatch): void {
    if (this.isShuttingDown) {
      this.settle(batch, new Error(SHUTDOWN_ERROR_MESSAGE));
      return;
    }

    const workerUrl = this.workerUrl();
    if (!workerUrl) {
      appLogger.warn("search_index.worker_missing", { context: batch.context });
      this.settle(batch);
      return;
    }
    appLogger.info("search_index.worker_started", {
      batch_id: batch.id,
      context: batch.context,
      jobs: batch.jobs.length,
    });

    const worker = new Worker(workerUrl, {
      workerData: {
        context: batch.context,
        jobs: batch.jobs,
        agentNames: [],
        sessionsByAgent: {},
        metaByAgent: {},
        skipFtsIntegrityCheck: this.hasCheckedFtsIntegrity,
      },
    });
    worker.unref();
    this.worker = worker;
    this.activeBatch = batch;

    worker.on("message", (message: SearchIndexWorkerMessage) => {
      if (message.type === "sync-result") {
        logSearchIndexSync(message.context, message.result);
        return;
      }
      if (message.type !== "done") return;

      appLogger.info(`${message.context}.done`, {
        duration_ms: Math.round(message.durationMs),
        sessions: message.sessions,
      });
      this.hasCheckedFtsIntegrity = true;
      this.settle(batch);
    });
    worker.on("error", (error) => {
      appLogger.error("search_index.worker_error", { context: batch.context, error });
      this.settle(batch, error);
    });
    worker.on("exit", (code) => this.finishWorker(worker, batch, code));
  }

  private finishWorker(worker: Worker, batch: SearchIndexJobBatch, code: number): void {
    appLogger.info("search_index.worker_exited", {
      batch_id: batch.id,
      context: batch.context,
      code,
      shutting_down: this.isShuttingDown || undefined,
    });
    if (this.worker === worker) this.worker = null;
    if (this.activeBatch === batch) this.activeBatch = null;

    const error =
      code === 0
        ? new Error("Search index worker exited before completing its batch")
        : new Error(`Search index worker exited with code ${code}`);
    if (code !== 0) appLogger.warn("search_index.worker_exit", { context: batch.context, code });
    this.settle(batch, error);
    this.startNextBatch();
  }

  private settle(batch: SearchIndexJobBatch, error?: Error): void {
    if (!this.pendingJobs.settle(batch, error)) return;
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
