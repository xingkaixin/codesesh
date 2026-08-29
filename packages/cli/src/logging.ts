import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import {
  isWorkerLogMessage,
  WORKER_LOG_MESSAGE_TYPE,
  type WorkerLogContext,
  type WorkerLogLevel,
  type WorkerLogMessage,
} from "@codesesh/core/runtime/diagnostics";
import type { SearchIndexSyncResult } from "@codesesh/core/runtime/discovery";
import { AsyncLogFileWriter, type DroppedLogCounts } from "./log-file-writer.js";
import { LogRecordEncoder, type EncodedLogLine } from "./log-record.js";

export type LogContext = WorkerLogContext;
type LogLevel = WorkerLogLevel;

interface WorkerLogPort {
  postMessage(message: WorkerLogMessage): void;
}

const DEFAULT_MAX_FILE_BYTES = 5_000_000;
const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_DIRECTORY_BYTES = 50_000_000;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_QUEUE_BYTES = 1_000_000;
const DEFAULT_MAX_RECORD_BYTES = 64 * 1_024;
const FINGERPRINT_KEY_ENVIRONMENT_DATA = "codesesh.logging.fingerprint-key.v1";
const LOG_CONTEXT_KEYS = new Set<keyof LogContext>([
  "request_id",
  "operation_id",
  "publication_id",
]);

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  logDir?: string;
  level?: LogLevel;
  maxBytes?: number;
  maxFiles?: number;
  maxDirectoryBytes?: number;
  maxAgeMs?: number;
  maxQueueBytes?: number;
  maxRecordBytes?: number;
}

function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Math.floor(value ?? Number.NaN);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  return positiveInteger(value == null ? undefined : Number(value), fallback);
}

function parseMaxAge(value: string | undefined): number {
  const days = parsePositiveInteger(value, DEFAULT_MAX_AGE_MS / (24 * 60 * 60 * 1_000));
  const milliseconds = days * 24 * 60 * 60 * 1_000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : DEFAULT_MAX_AGE_MS;
}

function getDefaultLogDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "codesesh", "logs");
}

function sharedFingerprintKey(): string {
  const existing = getEnvironmentData(FINGERPRINT_KEY_ENVIRONMENT_DATA) as unknown;
  if (typeof existing === "string" && /^[a-f0-9]{64}$/.test(existing)) return existing;

  const generated = randomBytes(32).toString("hex");
  setEnvironmentData(FINGERPRINT_KEY_ENVIRONMENT_DATA, generated);
  return generated;
}

const LOG_FINGERPRINT_KEY = sharedFingerprintKey();

function normalizedContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).flatMap(([key, value]) =>
      LOG_CONTEXT_KEYS.has(key as keyof LogContext) && typeof value === "string" && value.length > 0
        ? [[key, value.slice(0, 160)]]
        : [],
    ),
  );
}

export class AppLogger {
  private readonly level: LogLevel;
  private readonly runId: string;
  private readonly context = new AsyncLocalStorage<LogContext>();
  private readonly encoder: LogRecordEncoder;
  private readonly writer: AsyncLogFileWriter;
  private workerTarget: { port: WorkerLogPort; threadId: number } | null = null;
  private sequence = 0;
  private transportFailureReported = false;

  constructor(options: LoggerOptions = {}) {
    const logDir = options.logDir ?? process.env.CODESESH_LOG_DIR ?? getDefaultLogDir();
    this.level = options.level ?? parseLevel(process.env.CODESESH_LOG_LEVEL);
    this.runId = randomUUID();
    const maxRecordBytes = positiveInteger(
      options.maxRecordBytes,
      parsePositiveInteger(process.env.CODESESH_LOG_MAX_RECORD_BYTES, DEFAULT_MAX_RECORD_BYTES),
    );
    this.encoder = new LogRecordEncoder({
      fingerprintKey: LOG_FINGERPRINT_KEY,
      maxRecordBytes,
    });
    this.writer = new AsyncLogFileWriter({
      logDir,
      runId: this.runId,
      maxFileBytes: positiveInteger(
        options.maxBytes,
        parsePositiveInteger(process.env.CODESESH_LOG_MAX_BYTES, DEFAULT_MAX_FILE_BYTES),
      ),
      maxFiles: positiveInteger(
        options.maxFiles,
        parsePositiveInteger(process.env.CODESESH_LOG_MAX_FILES, DEFAULT_MAX_FILES),
      ),
      maxDirectoryBytes: positiveInteger(
        options.maxDirectoryBytes,
        parsePositiveInteger(process.env.CODESESH_LOG_MAX_TOTAL_BYTES, DEFAULT_MAX_DIRECTORY_BYTES),
      ),
      maxAgeMs: positiveInteger(
        options.maxAgeMs,
        parseMaxAge(process.env.CODESESH_LOG_MAX_AGE_DAYS),
      ),
      maxQueueBytes: positiveInteger(
        options.maxQueueBytes,
        parsePositiveInteger(process.env.CODESESH_LOG_MAX_QUEUE_BYTES, DEFAULT_MAX_QUEUE_BYTES),
      ),
      createDropSummary: (counts) => this.encodeDropSummary(counts),
    });
  }

  getLogPath(): string {
    return this.writer.path;
  }

  runWithContext<Result>(context: LogContext, operation: () => Result): Result {
    return this.context.run({ ...this.captureContext(), ...normalizedContext(context) }, operation);
  }

  restoreContext<Result>(context: LogContext, operation: () => Result): Result {
    return this.context.run(normalizedContext(context), operation);
  }

  captureContext(): LogContext {
    return { ...this.context.getStore() };
  }

  forwardToParent(port: WorkerLogPort, threadId: number): void {
    this.workerTarget = { port, threadId };
  }

  consumeWorkerMessage(message: unknown): boolean {
    if (!isWorkerLogMessage(message)) return false;
    if (LEVEL_WEIGHT[message.level] < LEVEL_WEIGHT[this.level]) return true;
    try {
      this.writer.enqueue(
        this.encode({
          timestamp: message.ts,
          level: message.level,
          event: message.event,
          pid: message.pid,
          threadId: message.threadId,
          context: message.context,
          data: message.data,
        }),
      );
      this.transportFailureReported = false;
    } catch (error) {
      this.reportTransportFailure(error);
    }
    return true;
  }

  debug(event: string, data: Record<string, unknown> = {}): void {
    this.write("debug", event, data);
  }

  info(event: string, data: Record<string, unknown> = {}): void {
    this.write("info", event, data);
  }

  warn(event: string, data: Record<string, unknown> = {}): void {
    this.write("warn", event, data);
  }

  error(event: string, data: Record<string, unknown> = {}): void {
    this.write("error", event, data);
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  close(): Promise<void> {
    return this.writer.close();
  }

  flushSync(): void {
    this.writer.flushSync();
  }

  private write(level: LogLevel, event: string, data: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;
    try {
      const timestamp = new Date().toISOString();
      const context = this.captureContext();
      if (this.workerTarget) {
        this.workerTarget.port.postMessage({
          type: WORKER_LOG_MESSAGE_TYPE,
          ts: timestamp,
          level,
          event,
          pid: process.pid,
          threadId: this.workerTarget.threadId,
          context,
          data: this.encoder.sanitizeForTransport(data, event),
        });
        this.transportFailureReported = false;
        return;
      }

      this.writer.enqueue(
        this.encode({
          timestamp,
          level,
          event,
          pid: process.pid,
          context,
          data,
        }),
      );
    } catch (error) {
      this.reportTransportFailure(error);
    }
  }

  private encode(
    input: Omit<Parameters<LogRecordEncoder["encode"]>[0], "runId" | "sequence">,
  ): EncodedLogLine {
    this.sequence += 1;
    return this.encoder.encode({
      ...input,
      runId: this.runId,
      sequence: this.sequence,
    });
  }

  private encodeDropSummary(counts: DroppedLogCounts): EncodedLogLine {
    return this.encode({
      timestamp: new Date().toISOString(),
      level: "warn",
      event: "logger.records_dropped",
      pid: process.pid,
      data: { ...counts },
    });
  }

  private reportTransportFailure(error: unknown): void {
    if (this.transportFailureReported) return;
    this.transportFailureReported = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`[codesesh] Failed to prepare log entry: ${message}\n`);
    } catch {}
  }
}

export const appLogger = new AppLogger();

export function logSearchIndexSync(
  context: string,
  result: SearchIndexSyncResult | null,
  data: Record<string, unknown> = {},
): void {
  if (result?.failures?.length) {
    appLogger.warn("search_index.sessions_skipped", {
      context,
      agent: result.agentName,
      failures: result.failures,
    });
  }
  if (!result) return;

  const detail = {
    context,
    agent: result.agentName,
    mode: result.mode,
    sessions: result.sessions,
    changed: result.changed,
    deleted: result.deleted,
    indexed: result.indexed,
    skipped: result.skipped,
    duration_ms: Math.round(result.durationMs),
    planning_ms: Math.round(result.planningDurationMs),
    get_session_data_calls: result.getSessionDataCalls,
    reused_materializations: result.reusedMaterializations,
    get_session_data_ms: Math.round(result.getSessionDataDurationMs),
    materialization_ms: Math.round(result.materializationDurationMs),
    rebuild_duration_ms:
      result.rebuildDurationMs != null ? Math.round(result.rebuildDurationMs) : undefined,
    ...data,
  };
  if (result.mode === "bulk") appLogger.info("search_index.sync", detail);
  else appLogger.debug("search_index.sync", detail);
}
