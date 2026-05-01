import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

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

  constructor(options: LoggerOptions = {}) {
    this.logDir = options.logDir ?? process.env.CODESESH_LOG_DIR ?? getDefaultLogDir();
    this.level = options.level ?? parseLevel(process.env.CODESESH_LOG_LEVEL);
    this.maxBytes =
      options.maxBytes ?? parsePositiveInt(process.env.CODESESH_LOG_MAX_BYTES, 5_000_000);
    this.maxFiles = options.maxFiles ?? parsePositiveInt(process.env.CODESESH_LOG_MAX_FILES, 5);
    this.currentPath = join(this.logDir, "codesesh.log");
  }

  getLogPath(): string {
    return this.currentPath;
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

    try {
      mkdirSync(this.logDir, { recursive: true });
      const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        pid: process.pid,
        ...toLogValue(data),
      })}\n`;
      this.rotateIfNeeded(Buffer.byteLength(line));
      appendFileSync(this.currentPath, line, "utf8");
    } catch {}
  }

  private rotateIfNeeded(nextBytes: number): void {
    if (!existsSync(this.currentPath)) {
      this.removeExpiredLogs();
      return;
    }

    const currentSize = statSync(this.currentPath).size;
    if (currentSize + nextBytes <= this.maxBytes) return;

    this.rotationIndex += 1;
    const rotatedPath = join(
      this.logDir,
      `codesesh-${timestampForFile()}-${process.pid}-${this.rotationIndex}.log`,
    );
    renameSync(this.currentPath, rotatedPath);
    this.removeExpiredLogs();
  }

  private removeExpiredLogs(): void {
    const rotated = readdirSync(this.logDir)
      .filter((name) => /^codesesh-.+\.log$/.test(name))
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
