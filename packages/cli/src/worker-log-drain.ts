import { randomUUID } from "node:crypto";
import type { MessagePort, Worker } from "node:worker_threads";
import { appLogger } from "./logging.js";

const WORKER_LOG_DRAIN_REQUEST_TYPE = "codesesh.worker-log-drain";
const WORKER_LOG_DRAIN_ACK_TYPE = "codesesh.worker-log-drained";
const WORKER_LOG_DRAIN_TIMEOUT_MS = 100;

interface WorkerLogDrainRequest {
  type: typeof WORKER_LOG_DRAIN_REQUEST_TYPE;
  requestId: string;
}

interface WorkerLogDrainAck {
  type: typeof WORKER_LOG_DRAIN_ACK_TYPE;
  requestId: string;
}

const terminations = new WeakMap<Worker, Promise<number>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isWorkerLogDrainRequest(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.type === WORKER_LOG_DRAIN_REQUEST_TYPE &&
    typeof message.requestId === "string"
  );
}

function isWorkerLogDrainAck(message: unknown, requestId: string): boolean {
  return (
    isRecord(message) &&
    message.type === WORKER_LOG_DRAIN_ACK_TYPE &&
    message.requestId === requestId
  );
}

export function acknowledgeWorkerLogDrain(
  port: MessagePort,
  message: unknown,
  after: PromiseLike<unknown> = Promise.resolve(),
): boolean {
  if (!isWorkerLogDrainRequest(message)) return false;
  const acknowledge = () => {
    try {
      port.postMessage({
        type: WORKER_LOG_DRAIN_ACK_TYPE,
        requestId: (message as WorkerLogDrainRequest).requestId,
      } satisfies WorkerLogDrainAck);
    } catch {
      return;
    }
  };
  void Promise.resolve(after).then(acknowledge, acknowledge);
  return true;
}

function reportDrainTimeout(worker: Worker): void {
  try {
    appLogger.warn("worker.log_drain_timeout", {
      timeout_ms: WORKER_LOG_DRAIN_TIMEOUT_MS,
      worker_thread_id: worker.threadId,
    });
  } catch {
    return;
  }
}

function requestWorkerLogDrain(worker: Worker): Promise<number | undefined> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    let settled = false;
    const finish = (exitCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
      resolve(exitCode);
    };
    const onMessage = (message: unknown) => {
      if (isWorkerLogDrainAck(message, requestId)) finish();
    };
    const onExit = (code: number) => finish(code);
    const timeout = setTimeout(() => {
      reportDrainTimeout(worker);
      finish();
    }, WORKER_LOG_DRAIN_TIMEOUT_MS);

    worker.on("message", onMessage);
    worker.once("exit", onExit);
    try {
      worker.postMessage({ type: WORKER_LOG_DRAIN_REQUEST_TYPE, requestId });
    } catch {
      finish(worker.threadId === -1 ? 0 : undefined);
    }
  });
}

export function terminateWorkerAfterLogDrain(worker: Worker): Promise<number> {
  const existing = terminations.get(worker);
  if (existing) return existing;

  const termination = requestWorkerLogDrain(worker).then((exitCode) =>
    exitCode === undefined ? worker.terminate() : exitCode,
  );
  terminations.set(worker, termination);
  return termination;
}
