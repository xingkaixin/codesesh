import { describe, expect, it } from "vitest";
import {
  WORKER_LOG_MESSAGE_TYPE,
  isWorkerLogMessage,
  type WorkerLogMessage,
} from "../worker-log.js";

const message: WorkerLogMessage = {
  type: WORKER_LOG_MESSAGE_TYPE,
  ts: "2026-08-12T00:00:00.000Z",
  level: "info",
  event: "worker.ready",
  pid: 42,
  threadId: 3,
  context: { operation_id: "scan:codex:1" },
  data: { sessions: 2 },
};

describe("worker log protocol", () => {
  it("accepts a complete worker log message", () => {
    expect(isWorkerLogMessage(message)).toBe(true);
  });

  it.each([
    null,
    [],
    { ...message, type: "done" },
    { ...message, level: "fatal" },
    { ...message, event: "" },
    { ...message, pid: 0 },
    { ...message, threadId: -1 },
    { ...message, context: { operation_id: "x".repeat(161) } },
    { ...message, context: { unexpected: "value" } },
    { ...message, data: [] },
  ])("rejects an invalid worker message %#", (candidate) => {
    expect(isWorkerLogMessage(candidate)).toBe(false);
  });
});
