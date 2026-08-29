import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  type WorkerLogLevel,
} from "@codesesh/core/runtime/diagnostics";
import type { EncodedLogLine } from "./log-record.js";

const MAX_BATCH_BYTES = 64 * 1024;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CURRENT_LOG_PATTERN = new RegExp(`^codesesh-(\\d+)-${UUID_PATTERN}-active\\.log$`);
const EMERGENCY_LOG_PATTERN = new RegExp(`^codesesh-(\\d+)-${UUID_PATTERN}-emergency\\.log$`);
const RUN_LOG_PATTERN = new RegExp(`^codesesh-\\d+-${UUID_PATTERN}-\\d+\\.log$`);
const LEGACY_ACTIVE_LOG_PATTERN = /^codesesh-(\d+)\.log$/;
const LEGACY_ROTATED_LOG_PATTERN =
  /^codesesh-\d+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+\.log$/;
const ORIGINAL_ROTATED_LOG_PATTERN =
  /^codesesh-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-\d+\.log$/;
const ORIGINAL_ACTIVE_LOG_PATTERN = /^codesesh\.log$/;
const LOG_LEVEL_PRIORITY: Record<WorkerLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface DroppedLogCounts {
  debug: number;
  info: number;
  warn: number;
  error: number;
}

interface LogFileWriterOptions {
  logDir: string;
  runId: string;
  maxFileBytes: number;
  maxFiles: number;
  maxDirectoryBytes: number;
  maxAgeMs: number;
  maxQueueBytes: number;
  createDropSummary(counts: DroppedLogCounts): EncodedLogLine;
}

interface PendingLine extends EncodedLogLine {
  internal?: boolean;
}

interface ManagedLogFile {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
  isProtected: boolean;
}

function emptyDropCounts(): DroppedLogCounts {
  return { debug: 0, info: 0, warn: 0, error: 0 };
}

function droppedCount(counts: DroppedLogCounts): number {
  return counts.debug + counts.info + counts.warn + counts.error;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function activeLogPid(name: string): number | null {
  const match =
    CURRENT_LOG_PATTERN.exec(name) ??
    EMERGENCY_LOG_PATTERN.exec(name) ??
    LEGACY_ACTIVE_LOG_PATTERN.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function isManagedLog(name: string): boolean {
  return (
    CURRENT_LOG_PATTERN.test(name) ||
    EMERGENCY_LOG_PATTERN.test(name) ||
    RUN_LOG_PATTERN.test(name) ||
    LEGACY_ACTIVE_LOG_PATTERN.test(name) ||
    LEGACY_ROTATED_LOG_PATTERN.test(name) ||
    ORIGINAL_ROTATED_LOG_PATTERN.test(name) ||
    ORIGINAL_ACTIVE_LOG_PATTERN.test(name)
  );
}

export class AsyncLogFileWriter {
  private readonly logDir: string;
  private readonly prefix: string;
  private readonly currentPath: string;
  private readonly emergencyPath: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxDirectoryBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxQueueBytes: number;
  private readonly createDropSummary: (counts: DroppedLogCounts) => EncodedLogLine;
  private queue: PendingLine[] = [];
  private inFlight: PendingLine[] = [];
  private dropped = emptyDropCounts();
  private queuedBytes = 0;
  private currentBytes = 0;
  private rotationIndex = 0;
  private handle: FileHandle | null = null;
  private drainPromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private storagePrepared = false;
  private currentFileCreated = false;
  private needsRecoverySeparator = false;
  private writeFailureReported = false;
  private overflowReported = false;
  private closedWriteReported = false;

  constructor(options: LogFileWriterOptions) {
    this.logDir = options.logDir;
    this.prefix = `codesesh-${process.pid}-${options.runId}`;
    this.currentPath = join(this.logDir, `${this.prefix}-active.log`);
    this.emergencyPath = join(this.logDir, `${this.prefix}-emergency.log`);
    this.maxFileBytes = options.maxFileBytes;
    this.maxFiles = options.maxFiles;
    this.maxDirectoryBytes = options.maxDirectoryBytes;
    this.maxAgeMs = options.maxAgeMs;
    this.maxQueueBytes = options.maxQueueBytes;
    this.createDropSummary = options.createDropSummary;
  }

  get path(): string {
    return this.currentPath;
  }

  enqueue(entry: EncodedLogLine): void {
    if (this.closePromise) {
      if (!this.closedWriteReported) {
        this.closedWriteReported = true;
        this.writeStderr("Log entry dropped after logger close");
      }
      return;
    }
    if (!this.makeRoom(entry)) {
      this.recordDrop(entry.level);
      this.scheduleDrain();
      return;
    }
    this.queue.push(entry);
    this.queuedBytes += entry.bytes;
    this.scheduleDrain();
  }

  async flush(): Promise<void> {
    while (this.queue.length > 0 || droppedCount(this.dropped) > 0 || this.drainPromise) {
      this.scheduleDrain();
      const drain = this.drainPromise;
      if (!drain) break;
      await drain;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  flushSync(): void {
    const pending = this.queue.splice(0);
    const pendingBytes = pending.reduce((total, entry) => total + entry.bytes, 0);
    this.queuedBytes = Math.max(0, this.queuedBytes - pendingBytes);
    const dropped = droppedCount(this.dropped);
    const emergency = [...this.inFlight, ...pending];
    if (dropped > 0) {
      emergency.push(this.createDropSummary({ ...this.dropped }));
      this.dropped = emptyDropCounts();
    }
    if (emergency.length === 0) return;
    try {
      mkdirSync(this.logDir, { recursive: true, mode: PRIVATE_DIR_MODE });
      if (process.platform !== "win32") chmodSync(this.logDir, PRIVATE_DIR_MODE);
      appendFileSync(this.emergencyPath, emergency.map((entry) => entry.line).join(""), {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE,
      });
      if (process.platform !== "win32") chmodSync(this.emergencyPath, PRIVATE_FILE_MODE);
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  private makeRoom(entry: EncodedLogLine): boolean {
    if (entry.bytes > this.maxQueueBytes) return false;
    if (entry.bytes <= this.maxQueueBytes - this.queuedBytes) return true;
    if (entry.level === "debug" || entry.level === "info") return false;

    const requiredBytes = entry.bytes - (this.maxQueueBytes - this.queuedBytes);
    const candidates = this.queue
      .map((candidate, index) => ({ candidate, index }))
      .filter(
        ({ candidate }) =>
          !candidate.internal &&
          LOG_LEVEL_PRIORITY[candidate.level] < LOG_LEVEL_PRIORITY[entry.level],
      )
      .toSorted((left, right) => {
        return (
          LOG_LEVEL_PRIORITY[left.candidate.level] - LOG_LEVEL_PRIORITY[right.candidate.level] ||
          left.index - right.index
        );
      });
    const removedIndexes = new Set<number>();
    let removedBytes = 0;
    for (const { candidate, index } of candidates) {
      removedIndexes.add(index);
      removedBytes += candidate.bytes;
      if (removedBytes >= requiredBytes) break;
    }
    if (removedBytes < requiredBytes) return false;

    this.queue = this.queue.filter((candidate, index) => {
      if (!removedIndexes.has(index)) return true;
      this.queuedBytes -= candidate.bytes;
      this.recordDrop(candidate.level);
      return false;
    });
    return true;
  }

  private recordDrop(level: WorkerLogLevel): void {
    this.dropped[level] += 1;
    if (this.overflowReported) return;
    this.overflowReported = true;
    this.writeStderr("Log queue full; entries were dropped");
  }

  private scheduleDrain(): void {
    if (this.drainPromise) return;
    const drain = Promise.resolve()
      .then(() => this.drain())
      .catch((error) => {
        this.discardPending();
        this.reportWriteFailure(error);
      });
    this.drainPromise = drain;
    void drain.then(() => {
      if (this.drainPromise === drain) this.drainPromise = null;
      if (this.queue.length > 0 || droppedCount(this.dropped) > 0) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 || droppedCount(this.dropped) > 0) {
      try {
        await this.openCurrentFile();
      } catch (error) {
        this.discardPending();
        this.reportWriteFailure(error);
        return;
      }
      this.enqueueDropSummaryIfPossible();
      if (this.queue.length === 0) return;
      if (this.shouldRotate(this.queue[0]!.bytes)) await this.rotate();
      const batch = this.takeBatch();
      await this.appendBatch(batch);
    }
  }

  private enqueueDropSummaryIfPossible(): void {
    if (droppedCount(this.dropped) === 0) return;
    const summary = this.createDropSummary({ ...this.dropped });
    if (summary.bytes > this.maxQueueBytes - this.queuedBytes) {
      if (this.queue.length === 0) this.dropped = emptyDropCounts();
      return;
    }
    this.dropped = emptyDropCounts();
    this.queue.push({ ...summary, internal: true });
    this.queuedBytes += summary.bytes;
  }

  private takeBatch(): PendingLine[] {
    const first = this.queue[0]!;
    const remainingFileBytes = Math.max(0, this.maxFileBytes - this.currentBytes);
    const batchLimit =
      this.currentBytes === 0 && first.bytes > this.maxFileBytes
        ? first.bytes
        : Math.min(MAX_BATCH_BYTES, remainingFileBytes);
    let count = 0;
    let bytes = 0;
    for (const next of this.queue) {
      if (count > 0 && next.bytes > batchLimit - bytes) break;
      count += 1;
      if (count === 1 && next.bytes > batchLimit) {
        break;
      }
      bytes += next.bytes;
    }
    return this.queue.splice(0, count);
  }

  private async appendBatch(batch: PendingLine[]): Promise<void> {
    const bytes = batch.reduce((total, entry) => total + entry.bytes, 0);
    this.inFlight = batch;
    try {
      if (!this.handle) throw new Error("Log file is not open");
      if (this.needsRecoverySeparator && this.currentBytes > 0) {
        await this.handle.writeFile("\n", "utf8");
        this.currentBytes += 1;
      }
      this.needsRecoverySeparator = false;
      await this.handle.writeFile(batch.map((entry) => entry.line).join(""), "utf8");
      this.currentBytes += bytes;
      this.writeFailureReported = false;
      this.overflowReported = false;
    } catch (error) {
      this.needsRecoverySeparator = true;
      for (const entry of batch) {
        if (!entry.internal) this.recordDrop(entry.level);
      }
      await this.closeHandle();
      this.reportWriteFailure(error);
    } finally {
      if (this.inFlight === batch) this.inFlight = [];
      this.queuedBytes = Math.max(0, this.queuedBytes - bytes);
    }
  }

  private shouldRotate(nextBytes: number): boolean {
    return this.currentBytes > 0 && nextBytes > this.maxFileBytes - this.currentBytes;
  }

  private async rotate(): Promise<void> {
    await this.closeHandle();
    this.rotationIndex += 1;
    const rotatedPath = join(this.logDir, `${this.prefix}-${this.rotationIndex}.log`);
    await rename(this.currentPath, rotatedPath);
    this.currentFileCreated = false;
    this.currentBytes = 0;
    await this.openCurrentFile();
  }

  private async openCurrentFile(): Promise<void> {
    if (this.handle) return;
    await this.prepareStorage();
    const handle = await open(
      this.currentPath,
      this.currentFileCreated ? "a" : "ax",
      PRIVATE_FILE_MODE,
    );
    this.currentFileCreated = true;
    try {
      const stats = await handle.stat();
      this.currentBytes = stats.size;
      if (process.platform !== "win32") await chmod(this.currentPath, PRIVATE_FILE_MODE);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    this.handle = handle;
    await this.pruneLogs();
  }

  private async prepareStorage(): Promise<void> {
    if (this.storagePrepared) return;
    await mkdir(this.logDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    if (process.platform !== "win32") await chmod(this.logDir, PRIVATE_DIR_MODE);
    await this.restrictExistingLogs();
    this.storagePrepared = true;
  }

  private async restrictExistingLogs(): Promise<void> {
    if (process.platform === "win32") return;
    const entries = await readdir(this.logDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && isManagedLog(entry.name))
        .map((entry) =>
          chmod(join(this.logDir, entry.name), PRIVATE_FILE_MODE).catch((error) => {
            this.reportWriteFailure(error);
          }),
        ),
    );
  }

  private async pruneLogs(): Promise<void> {
    let files: ManagedLogFile[];
    try {
      files = await this.managedLogs();
    } catch (error) {
      this.reportWriteFailure(error);
      return;
    }

    const now = Date.now();
    for (const file of files) {
      if (!file.isProtected && now - file.mtimeMs > this.maxAgeMs) {
        if (await this.removeLog(file)) files = files.filter((item) => item.path !== file.path);
      }
    }

    let totalBytes = files.reduce((total, file) => total + file.bytes, 0);
    let totalFiles = files.length;
    const candidates = files
      .filter((file) => !file.isProtected)
      .toSorted(
        (left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name),
      );
    for (const file of candidates) {
      if (totalFiles <= this.maxFiles && totalBytes <= this.maxDirectoryBytes) break;
      if (!(await this.removeLog(file))) continue;
      totalFiles -= 1;
      totalBytes = Math.max(0, totalBytes - file.bytes);
    }
  }

  private async managedLogs(): Promise<ManagedLogFile[]> {
    const entries = await readdir(this.logDir, { withFileTypes: true });
    const files: ManagedLogFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isManagedLog(entry.name)) continue;
      const path = join(this.logDir, entry.name);
      try {
        const stats = await lstat(path);
        if (!stats.isFile()) continue;
        const pid = activeLogPid(entry.name);
        files.push({
          name: entry.name,
          path,
          bytes: stats.size,
          mtimeMs: stats.mtimeMs,
          isProtected:
            path === this.currentPath ||
            ORIGINAL_ACTIVE_LOG_PATTERN.test(entry.name) ||
            (pid != null && isProcessAlive(pid)),
        });
      } catch (error) {
        if (errorCode(error) !== "ENOENT") this.reportWriteFailure(error);
      }
    }
    return files;
  }

  private async removeLog(file: ManagedLogFile): Promise<boolean> {
    try {
      await unlink(file.path);
      return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return true;
      this.reportWriteFailure(error);
      return false;
    }
  }

  private async finishClose(): Promise<void> {
    await this.flush();
    await this.closeHandle();
    if (this.storagePrepared) await this.pruneLogs();
  }

  private async closeHandle(): Promise<void> {
    const handle = this.handle;
    this.handle = null;
    if (!handle) return;
    try {
      await handle.close();
    } catch (error) {
      this.reportWriteFailure(error);
    }
  }

  private reportWriteFailure(error: unknown): void {
    if (this.writeFailureReported) return;
    this.writeFailureReported = true;
    const message = error instanceof Error ? error.message : String(error);
    this.writeStderr(`Failed to write log ${this.currentPath}: ${message}`);
  }

  private discardPending(): void {
    this.queue.splice(0);
    this.queuedBytes = 0;
    this.dropped = emptyDropCounts();
  }

  private writeStderr(message: string): void {
    try {
      process.stderr.write(`[codesesh] ${message}\n`);
    } catch {}
  }
}
