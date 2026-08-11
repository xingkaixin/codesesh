export const WORKER_LOG_MESSAGE_TYPE = "codesesh.worker-log";

export type WorkerLogLevel = "debug" | "info" | "warn" | "error";

export interface WorkerLogMessage {
  type: typeof WORKER_LOG_MESSAGE_TYPE;
  ts: string;
  level: WorkerLogLevel;
  event: string;
  pid: number;
  threadId: number;
  data: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
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
    isRecord(value.data)
  );
}
