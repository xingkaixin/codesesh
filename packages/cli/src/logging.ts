import { appendFileSync, existsSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  isWorkerLogMessage,
  restrictExistingPrivateFiles,
  restrictPrivateFile,
  WORKER_LOG_MESSAGE_TYPE,
  type WorkerLogLevel,
  type WorkerLogMessage,
} from "@codesesh/core/runtime/diagnostics";
import type { SearchIndexSyncResult } from "@codesesh/core/runtime/discovery";

type LogLevel = WorkerLogLevel;

interface WorkerLogPort {
  postMessage(message: WorkerLogMessage): void;
}

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
}

function parseLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getDefaultLogDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "codesesh", "logs");
}

function toLogValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => toLogValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toLogValue(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class AppLogger {
  private readonly logDir: string;
  private readonly level: LogLevel;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly currentPath: string;
  private rotationIndex = 0;
  private restrictedExistingLogs = false;
  private workerTarget: { port: WorkerLogPort; threadId: number } | null = null;
  private writeFailureReported = false;

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? process.env.CODESESH_LOG_DIR ?? getDefaultLogDir();
    this.level = options.level ?? parseLevel(process.env.CODESESH_LOG_LEVEL);
    this.maxBytes =
      options.maxBytes ?? parsePositiveInt(process.env.CODESESH_LOG_MAX_BYTES, 5_000_000);
    this.maxFiles = options.maxFiles ?? parsePositiveInt(process.env.CODESESH_LOG_MAX_FILES, 5);
    this.currentPath = join(this.logDir, `codesesh-${process.pid}.log`);
  }

  getLogPath(): string {
    return this.currentPath;
  }

  forwardToParent(port: WorkerLogPort, threadId: number): void {
    this.workerTarget = { port, threadId };
  }

  consumeWorkerMessage(message: unknown): boolean {
    if (!isWorkerLogMessage(message)) return false;
    if (LEVEL_WEIGHT[message.level] < LEVEL_WEIGHT[this.level]) return true;
    this.appendRecord({
      ...message.data,
      ts: message.ts,
      level: message.level,
      event: message.event,
      pid: message.pid,
      thread_id: message.threadId,
    });
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

  private write(level: LogLevel, event: string, data: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return;

    const ts = new Date().toISOString();
    const normalizedData = toLogValue(data) as Record<string, unknown>;
    if (this.workerTarget) {
      try {
        this.workerTarget.port.postMessage({
          type: WORKER_LOG_MESSAGE_TYPE,
          ts,
          level,
          event,
          pid: process.pid,
          threadId: this.workerTarget.threadId,
          data: normalizedData,
        });
      } catch (error) {
        this.reportWriteFailure(error);
      }
      return;
    }

    this.appendRecord({
      ...normalizedData,
      ts,
      level,
      event,
      pid: process.pid,
    });
  }

  private appendRecord(record: Record<string, unknown>): void {
    try {
      ensurePrivateDirectory(this.logDir);
      this.restrictExistingLogs();
      const line = `${JSON.stringify(record)}\n`;
      const restrictCurrentFile = this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.currentPath, line, "utf8");
      if (restrictCurrentFile) restrictPrivateFile(this.currentPath);
      this.writeFailureReported = false;
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  private reportWriteFailure(error: unknown): void {
    if (this.writeFailureReported) return;
    this.writeFailureReported = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      process.stderr.write(`[codesesh] Failed to write log ${this.currentPath}: ${message}\n`);
    } catch {}
  }

  /** Logs rotated by an earlier run predate the owner-only policy. */
  private restrictExistingLogs(): void {
    if (this.restrictedExistingLogs) return;
    this.restrictedExistingLogs = true;
    restrictExistingPrivateFiles(
      this.logDir,
      (name) => name.startsWith("codesesh") && name.endsWith(".log"),
    );
  }

  private rotateIfNeeded(nextBytes: number): boolean {
    if (!existsSync(this.currentPath)) {
      this.removeExpiredLogs();
      return true;
    }

    const currentSize = statSync(this.currentPath).size;
    if (currentSize + nextBytes <= this.maxBytes) return false;

    this.rotationIndex += 1;
    const rotatedPath = join(
      this.logDir,
      `codesesh-${process.pid}-${timestampForFile()}-${this.rotationIndex}.log`,
    );
    renameSync(this.currentPath, rotatedPath);
    restrictPrivateFile(rotatedPath);
    this.removeExpiredLogs();
    return true;
  }

  private removeExpiredLogs(): void {
    const ownedPrefix = `codesesh-${process.pid}-`;
    const rotated = readdirSync(this.logDir)
      .filter((name) => name.startsWith(ownedPrefix) && name.endsWith(".log"))
      .map((name) => {
        const path = join(this.logDir, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs);

    for (const item of rotated.slice(Math.max(0, this.maxFiles - 1))) {
      unlinkSync(item.path);
    }
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
