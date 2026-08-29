export const WORKER_LOG_MESSAGE_TYPE = "codesesh.worker-log";

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerLogContext {
  request_id?: string;
  operation_id?: string;
  publication_id?: string;
}

export interface WorkerLogMessage {
  type: typeof WORKER_LOG_MESSAGE_TYPE;
  ts: string;
  level: WorkerLogLevel;
  event: string;
  pid: number;
  threadId: number;
  context?: WorkerLogContext;
  data: Record<string, unknown>;
}

const WORKER_LOG_CONTEXT_KEYS = new Set(["request_id", "operation_id", "publication_id"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isLogContext(value: unknown): value is WorkerLogContext {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, item]) =>
      WORKER_LOG_CONTEXT_KEYS.has(key) && typeof item === "string" && item.length <= 160,
  );
}

export function isWorkerLogMessage(value: unknown): value is WorkerLogMessage {
  if (!isRecord(value) || value.type !== WORKER_LOG_MESSAGE_TYPE) return false;
  return (
    typeof value.ts === "string" &&
    value.ts.length > 0 &&
    (value.level === "debug" ||
      value.level === "info" ||
      value.level === "warn" ||
      value.level === "error") &&
    typeof value.event === "string" &&
    value.event.length > 0 &&
    Number.isSafeInteger(value.pid) &&
    Number(value.pid) > 0 &&
    Number.isSafeInteger(value.threadId) &&
    Number(value.threadId) >= 0 &&
    (value.context === undefined || isLogContext(value.context)) &&
    isRecord(value.data)
  );
}
