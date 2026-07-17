import { Worker } from "node:worker_threads";
import type { AgentScanProgress, ScanOptions, SessionCacheMeta, SessionHead } from "@codesesh/core";
import { appLogger } from "./logging.js";
import type { ScanRefreshWorkerMessage } from "./scan-refresh-worker.js";

export interface WorkerPayload {
  previousSessions: SessionHead[];
  changedIds: string[] | null;
  sourceSync?: boolean;
  scanOptions: Pick<ScanOptions, "from" | "to" | "fast">;
  meta: Record<string, SessionCacheMeta>;
  onProgress?: (progress: AgentScanProgress) => void;
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

export class ThreadWorkerRunner implements WorkerRunner {
  private workers = new Set<Worker>();

  constructor(private readonly workerUrl: URL) {}

  get activeCount(): number {
    return this.workers.size;
  }

  run(agentName: string, payload: WorkerPayload): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerUrl, {
        workerData: {
          agentName,
          previousSessions: payload.previousSessions,
          changedIds: payload.changedIds,
          sourceSync: payload.sourceSync,
          scanOptions: payload.scanOptions,
          meta: payload.meta,
        },
      });
      worker.unref();
      this.workers.add(worker);

      let settled = false;
      const finish = (callback: () => void, terminate = true) => {
        if (settled) return;
        settled = true;
        this.workers.delete(worker);
        if (terminate) void worker.terminate();
        callback();
      };

      worker.on("message", (message: ScanRefreshWorkerMessage) => {
        if (message.type === "progress") {
          payload.onProgress?.(message.progress);
          return;
        }
        if (message.type === "done") {
          finish(() =>
            resolve({
              sessions: message.sessions,
              meta: message.meta,
              changedIds: message.changedIds,
            }),
          );
          return;
        }
        finish(() => reject(new Error(message.error)));
      });
      worker.once("error", (error) => {
        finish(() => reject(error));
      });
      worker.once("exit", (code) => {
        if (settled) return;
        appLogger.warn("scan.refresh_worker.exit_before_done", { agent: agentName, code });
        finish(
          () => reject(new Error(`Scan refresh worker exited before completing (code ${code})`)),
          false,
        );
      });
    });
  }

  async shutdown(): Promise<void> {
    const workers = [...this.workers];
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    this.workers.clear();
  }
}
