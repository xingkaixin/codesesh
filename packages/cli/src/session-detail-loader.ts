import { Worker } from "node:worker_threads";
import {
  materializeCachedSessionDetailResponse,
  type LiveSnapshot,
  type SessionDetailResponseResult,
  type SessionReference,
} from "@codesesh/core/runtime/discovery";
import { getPricingGeneration } from "@codesesh/core/runtime/pricing";
import { appLogger } from "./logging.js";
import type {
  SessionDetailWorkerMessage,
  SessionDetailWorkerRequest,
} from "./session-detail-worker.js";

export type SessionDetailLoader = (
  snapshot: LiveSnapshot,
  reference: SessionReference,
  options?: { messageCursor?: string },
  signal?: AbortSignal,
) => SessionDetailResponseResult | Promise<SessionDetailResponseResult>;

export class SessionDetailBusyError extends Error {
  constructor() {
    super("Session detail workers are busy");
  }
}

const MAX_DETAIL_WORKERS = 2;
const DETAIL_TIMEOUT_MS = 60_000;

export class ThreadSessionDetailLoader {
  private readonly workers = new Set<Worker>();
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly workerUrl = new URL("./session-detail-worker.js", import.meta.url),
  ) {}

  readonly load: SessionDetailLoader = async (snapshot, reference, options = {}, signal) => {
    const requestSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
    requestSignal.throwIfAborted();
    const cached = materializeCachedSessionDetailResponse(snapshot, reference, options);
    if (cached) return cached;
    if (this.workers.size >= MAX_DETAIL_WORKERS) throw new SessionDetailBusyError();
    const agent = snapshot.agents.find((item) => item.name === reference.agentName);
    const head = snapshot.byAgent[reference.agentName]?.find(
      (item) => item.reference.sessionId === reference.sessionId,
    );
    const meta = agent?.getSessionCacheMeta(reference.sessionId);
    const request: SessionDetailWorkerRequest = {
      reference,
      head,
      meta: meta ? { [reference.sessionId]: meta } : {},
      messageCursor: options.messageCursor,
      pricingGenerationId: getPricingGeneration().id,
    };
    appLogger.info("session_detail.worker.started", {
      agent: reference.agentName,
      session_id: reference.sessionId,
    });
    const worker = new Worker(this.workerUrl, { workerData: request });
    const exited = new Promise<void>((resolve) =>
      worker.once("exit", () => {
        this.workers.delete(worker);
        resolve();
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
    try {
      return await new Promise<SessionDetailResponseResult>((resolve, reject) => {
        abort = () => reject(requestSignal.reason);
        requestSignal.addEventListener("abort", abort, { once: true });
        this.workers.add(worker);
        timeout = setTimeout(
          () => reject(new Error("Session detail loading timed out")),
          DETAIL_TIMEOUT_MS,
        );
        timeout.unref();
        worker.on("message", (message: SessionDetailWorkerMessage) => {
          if (appLogger.consumeWorkerMessage(message)) return;
          if (message.type === "result") resolve(message.result);
          else if (message.type === "error") reject(new Error(message.error));
        });
        worker.once("error", reject);
        worker.once("exit", (code) =>
          reject(new Error(`Session detail worker exited without a result (${code})`)),
        );
      });
    } finally {
      clearTimeout(timeout);
      requestSignal.removeEventListener("abort", abort);
      await worker.terminate();
      await exited;
    }
  };

  async shutdown(): Promise<void> {
    this.shutdownController.abort();
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
  }
}
