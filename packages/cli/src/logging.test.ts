import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogRecordEncoder, MIN_LOG_RECORD_BYTES } from "./log-record.js";
import { AppLogger, type LoggerOptions } from "./logging.js";

const tempDirs: string[] = [];
const loggers: AppLogger[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-logs-"));
  tempDirs.push(dir);
  return dir;
}

function createLogger(options: LoggerOptions): AppLogger {
  const logger = new AppLogger(options);
  loggers.push(logger);
  return logger;
}

describe("AppLogger", () => {
  afterEach(async () => {
    await Promise.all(loggers.splice(0).map((logger) => logger.close()));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("writes structured log lines", async () => {
    const logDir = createTempDir();
    const logger = createLogger({ logDir, maxBytes: 10_000 });

    logger.info("test.event", { duration_ms: 12, ok: true });
    await logger.flush();

    const line = readFileSync(logger.getLogPath(), "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      schema_version: 1,
      level: "info",
      event: "test.event",
      duration_ms: 12,
      ok: true,
      seq: 1,
    });
    expect(JSON.parse(line).run_id).toEqual(expect.any(String));
  });

  it("never lets unsafe diagnostic data escape into product control flow", async () => {
    const logger = createLogger({ logDir: createTempDir() });
    const data: Record<string, unknown> = {};
    Object.defineProperty(data, "broken", {
      enumerable: true,
      get() {
        throw new Error("getter exploded");
      },
    });

    expect(() => logger.info("test.unsafe_data", data)).not.toThrow();
    await logger.flush();
  });

  it("redacts credentials and personal path prefixes before persistence", async () => {
    const logger = createLogger({ logDir: createTempDir() });
    const privatePath = join(homedir(), "project", "session.jsonl");
    const privateUrl =
      "https://user:private-password@example.com/sessions/private-session-id?token=private-query#private-fragment";

    logger.info("test.redaction", {
      authorization: "Bearer private-token",
      accessToken: "camel-case-token",
      nested: { password: "private-password" },
      path: privatePath,
      file: privatePath,
      prompt: "private prompt body",
      message: "private diagnostic message",
      error: "private source error",
      target: { url: privateUrl },
      sessionId: "camel-case-session-id",
      session_id: "private-session-id",
    });
    await logger.flush();

    const persisted = readFileSync(logger.getLogPath(), "utf8");
    const record = JSON.parse(persisted) as Record<string, unknown>;
    expect(record.authorization).toBe("[redacted]");
    expect(record.nested).toEqual({ password: "[redacted]" });
    expect(record.message).toBe("[omitted]");
    expect(record.error).toMatch(/^error_message:[a-f0-9]{16}$/);
    expect(record.path).toMatch(/^path:[a-f0-9]{16}$/);
    expect(record.file).toBe(record.path);
    expect(persisted).not.toContain("session.jsonl");
    expect(record.session_id).not.toBe("private-session-id");
    expect(persisted).not.toContain("camel-case-token");
    expect(persisted).not.toContain("camel-case-session-id");
    expect(persisted).not.toContain("private prompt body");
    expect(persisted).not.toContain("private source error");
    expect(persisted).not.toContain("private-password");
    expect(persisted).not.toContain("private-session-id");
    expect(persisted).not.toContain("private-query");
    expect(persisted).not.toContain("private-fragment");
    expect(record.target).toEqual({ url: "https://example.com/" });
  });

  it("removes message text and personal paths from plain stack fields", async () => {
    const logger = createLogger({ logDir: createTempDir() });
    const privateMessage = "failed while reading a private session";

    logger.error("test.plain_stack", {
      stack: `Error: ${privateMessage}\n    at ${join(homedir(), "private", "reader.ts")}:1:1`,
    });
    await logger.flush();

    const record = JSON.parse(readFileSync(logger.getLogPath(), "utf8")) as { stack: string };
    expect(record.stack).not.toContain(privateMessage);
    expect(record.stack).not.toContain(homedir());
    expect(record.stack).toContain(join("~", "private", "reader.ts"));
  });

  it("omits relative and unparseable URL values", async () => {
    const logger = createLogger({ logDir: createTempDir() });

    logger.info("test.unsafe_urls", {
      relativeUrl: "/sessions/private-session?token=private-token",
      malformedUrl: "http://[private-host",
    });
    await logger.flush();

    const persisted = readFileSync(logger.getLogPath(), "utf8");
    const record = JSON.parse(persisted) as Record<string, unknown>;
    expect(record.relativeUrl).toBe("[omitted]");
    expect(record.malformedUrl).toBe("[omitted]");
    expect(persisted).not.toContain("private-session");
    expect(persisted).not.toContain("private-host");
  });

  it("isolates correlation context across concurrent operations", async () => {
    const logger = createLogger({ logDir: createTempDir() });

    await Promise.all([
      logger.runWithContext({ request_id: "request-a", operation_id: "operation-a" }, async () => {
        await Promise.resolve();
        logger.info("context.a");
      }),
      logger.runWithContext({ request_id: "request-b", operation_id: "operation-b" }, async () => {
        logger.info("context.b");
        await Promise.resolve();
      }),
    ]);
    await logger.flush();

    const records = readFileSync(logger.getLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((record) => record.event === "context.a")).toMatchObject({
      request_id: "request-a",
      operation_id: "operation-a",
    });
    expect(records.find((record) => record.event === "context.b")).toMatchObject({
      request_id: "request-b",
      operation_id: "operation-b",
    });
  });

  it("inherits request context when an operation adds its identifier", async () => {
    const logger = createLogger({ logDir: createTempDir() });

    logger.runWithContext({ request_id: "request" }, () => {
      logger.runWithContext({ operation_id: "operation" }, () => logger.info("context.nested"));
    });
    await logger.flush();

    expect(JSON.parse(readFileSync(logger.getLogPath(), "utf8"))).toMatchObject({
      request_id: "request",
      operation_id: "operation",
    });
  });

  it("rotates logs and keeps the configured file count", async () => {
    const logDir = createTempDir();
    const logger = createLogger({ logDir, maxBytes: 120, maxFiles: 2 });

    for (let index = 0; index < 8; index += 1) {
      logger.info("test.rotate", { index, text: "x".repeat(80) });
    }
    await logger.flush();

    const files = readdirSync(logDir).filter((name) => name.endsWith(".log"));
    expect(files.length).toBeLessThanOrEqual(2);
    expect(files).toContain(basename(logger.getLogPath()));
  });

  it("forwards worker entries to a single file owner", async () => {
    const workerLogDir = createTempDir();
    const ownerLogDir = createTempDir();
    const messages: unknown[] = [];
    const workerLogger = createLogger({ logDir: workerLogDir });
    const ownerLogger = createLogger({ logDir: ownerLogDir });
    workerLogger.forwardToParent({ postMessage: (message) => messages.push(message) }, 7);

    workerLogger.runWithContext({ operation_id: "worker-operation" }, () => {
      workerLogger.warn("worker.warning", { session: "one" });
    });

    expect(existsSync(workerLogger.getLogPath())).toBe(false);
    expect(messages).toHaveLength(1);
    expect(ownerLogger.consumeWorkerMessage(messages[0])).toBe(true);
    expect(ownerLogger.consumeWorkerMessage({ type: "done" })).toBe(false);
    await ownerLogger.flush();
    const record = JSON.parse(readFileSync(ownerLogger.getLogPath(), "utf8")) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      level: "warn",
      event: "worker.warning",
      thread_id: 7,
      operation_id: "worker-operation",
    });
    expect(record.session).not.toBe("one");
  });

  it("shares stable fingerprints across loggers and transport passes", async () => {
    const messages: unknown[] = [];
    const firstWorker = createLogger({ logDir: createTempDir() });
    const secondWorker = createLogger({ logDir: createTempDir() });
    const owner = createLogger({ logDir: createTempDir() });
    firstWorker.forwardToParent({ postMessage: (message) => messages.push(message) }, 1);
    secondWorker.forwardToParent({ postMessage: (message) => messages.push(message) }, 2);

    firstWorker.info("worker.private", { detail: "same private value", sessionId: "12345" });
    secondWorker.info("worker.private", { detail: "same private value", sessionId: "12345" });

    const transported = messages.map(
      (message) => (message as { data: { detail: string; sessionId: string } }).data,
    );
    expect(transported[1]).toEqual(transported[0]);
    for (const message of messages) owner.consumeWorkerMessage(message);
    await owner.flush();

    const records = readFileSync(owner.getLogPath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { detail: string; sessionId: string });
    expect(records[0]).toMatchObject(transported[0]!);
    expect(records[1]).toMatchObject(transported[0]!);
  });

  it("preserves all worker entries across owner rotations", async () => {
    const ownerLogDir = createTempDir();
    const owner = createLogger({ logDir: ownerLogDir, maxBytes: 1_000, maxFiles: 200 });
    const messages: unknown[] = [];
    const entriesPerWorker = 5;
    const workers = Array.from({ length: 4 }, (_, threadId) => {
      const logger = createLogger({ logDir: createTempDir() });
      logger.forwardToParent({ postMessage: (message) => messages.push(message) }, threadId + 1);
      return logger;
    });

    for (const [worker, logger] of workers.entries()) {
      for (let index = 0; index < entriesPerWorker; index += 1) {
        logger.info("worker.rotation", { worker, index });
      }
    }
    for (const message of messages) owner.consumeWorkerMessage(message);
    await owner.flush();

    const logFiles = readdirSync(ownerLogDir).filter((name) => name.endsWith(".log"));
    const records = logFiles.flatMap((name) =>
      readFileSync(join(ownerLogDir, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { worker: number; index: number }),
    );
    const uniqueEntries = new Set(records.map(({ worker, index }) => `${worker}:${index}`));
    const expectedEntries = workers.length * entriesPerWorker;

    expect(logFiles.length).toBeGreaterThan(1);
    expect(records).toHaveLength(expectedEntries);
    expect(uniqueEntries.size).toBe(expectedEntries);
  });

  it("bounds worker transport payloads before structured cloning", () => {
    const messages: unknown[] = [];
    const worker = createLogger({ logDir: createTempDir() });
    worker.forwardToParent({ postMessage: (message) => messages.push(message) }, 1);

    worker.info("worker.large", {
      payload: Array.from({ length: 50 }, () =>
        Array.from({ length: 50 }, () => "x".repeat(4_000)),
      ),
    });

    expect(Buffer.byteLength(JSON.stringify(messages[0]))).toBeLessThanOrEqual(70_000);
  });

  it("bounds string sanitization before applying redaction patterns", () => {
    const maxRecordBytes = 8_192;
    const messages: unknown[] = [];
    const worker = createLogger({ logDir: createTempDir(), maxRecordBytes });
    worker.forwardToParent({ postMessage: (message) => messages.push(message) }, 1);
    const replace = vi.spyOn(String.prototype, "replace");

    worker.info("worker.large_string", {
      detail: `Bearer ${"private-token".repeat(100_000)}`,
      keyMaterial: `-----BEGIN PRIVATE KEY-----\n${"private-key-data".repeat(100_000)}\n-----END PRIVATE KEY-----`,
      payload: Array.from({ length: 50 }, () => "x".repeat(4_000)),
    });

    const replacedCharacters = replace.mock.contexts.reduce<number>(
      (total, value) => total + String(value).length,
      0,
    );
    expect(replace.mock.contexts.every((value) => String(value).length <= 4_000)).toBe(true);
    expect(replacedCharacters).toBeLessThanOrEqual(maxRecordBytes * 8);
    expect(JSON.stringify(messages[0])).not.toContain("private-token");
    expect(JSON.stringify(messages[0])).not.toContain("private-key-data");
  });

  it("bounds aggregate traversal across repeated containers", () => {
    const messages: unknown[] = [];
    const worker = createLogger({ logDir: createTempDir() });
    worker.forwardToParent({ postMessage: (message) => messages.push(message) }, 1);
    const entries = new Map(Array.from({ length: 50 }, (_, index) => [index, { value: index }]));
    const originalEntries = entries.entries.bind(entries);
    let entriesRead = 0;
    vi.spyOn(entries, "entries").mockImplementation(function* () {
      for (const entry of originalEntries()) {
        entriesRead += 1;
        yield entry;
      }
      return undefined;
    });

    worker.info("worker.repeated_containers", {
      payload: Array.from({ length: 50 }, () => entries),
    });

    expect(entriesRead).toBeLessThan(500);
    expect(messages).toHaveLength(1);
  });

  it("fingerprints worker errors and removes the message-bearing stack line", async () => {
    const messages: unknown[] = [];
    const worker = createLogger({ logDir: createTempDir() });
    const owner = createLogger({ logDir: createTempDir() });
    worker.forwardToParent({ postMessage: (message) => messages.push(message) }, 1);
    const error = new Error("parse failed with private input");
    error.stack = `Error: parse failed with private input\n    at ${join(homedir(), "private", "reader.ts")}:1:1`;

    worker.error("worker.failed", { error });
    worker.error("worker.failed_again", { error });
    expect(JSON.stringify(messages)).not.toContain("parse failed with private input");
    for (const message of messages) owner.consumeWorkerMessage(message);
    await owner.flush();

    const records = readFileSync(owner.getLogPath(), "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            error: { message_fingerprint: string; message?: string; stack: string };
          },
      );
    expect(records[0]?.error.message_fingerprint).toMatch(/^error_message:[a-f0-9]{16}$/);
    expect(records[1]?.error.message_fingerprint).toBe(records[0]?.error.message_fingerprint);
    expect(records[0]?.error.message).toBeUndefined();
    expect(records[0]?.error.stack).not.toContain("parse failed with private input");
    expect(records[0]?.error.stack).not.toContain(homedir());
  });

  it("redacts Windows path prefixes across case and separator variants", () => {
    const encoder = new LogRecordEncoder({
      fingerprintKey: Buffer.alloc(32, 1),
      maxRecordBytes: 64 * 1_024,
      currentWorkingDirectory: "C:\\Users\\Kevin\\Project",
      homeDirectory: "C:\\Users\\Kevin",
    });
    const error = new Error("private failure");
    Object.defineProperty(error, "stack", {
      value: "Error: private failure\n    at c:/USERS/kevin/project\\src/reader.ts:1:1",
    });

    const record = JSON.parse(
      encoder.encode({
        timestamp: "2026-08-29T00:00:00.000Z",
        level: "error",
        event: "test.windows_paths",
        runId: "00000000-0000-4000-8000-000000000000",
        sequence: 1,
        pid: 1,
        data: {
          detail: "read c:/USERS/kevin/project\\session.jsonl and C:\\users\\KEVIN\\notes.txt",
          error,
        },
      }).line,
    ) as { detail: string; error: { stack: string } };

    expect(record.detail).toMatch(/^string:[a-f0-9]{16}$/);
    expect(record.error.stack).toContain("<cwd>");
    expect(`${record.detail}\n${record.error.stack}`.toLowerCase()).not.toContain("c:/users/kevin");
    expect(`${record.detail}\n${record.error.stack}`.toLowerCase()).not.toContain(
      "c:\\users\\kevin",
    );
  });

  it("removes stale logs left by previous processes", async () => {
    const logDir = createTempDir();
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(logDir, `codesesh-${900_000_000 + index}.log`), `stale ${index}\n`);
    }
    const logger = createLogger({ logDir, maxBytes: 10_000, maxFiles: 2 });

    logger.info("test.retention");
    await logger.flush();

    const files = readdirSync(logDir).filter((name) => name.endsWith(".log"));
    expect(files).toHaveLength(2);
    expect(files).toContain(basename(logger.getLogPath()));
  });

  it("applies age retention only to managed inactive logs", async () => {
    const logDir = createTempDir();
    const stale = join(logDir, "codesesh-900000000.log");
    const originalRotated = join(logDir, "codesesh-2026-01-01T00-00-00-000Z-900000000-1.log");
    const unrelated = join(logDir, "codesesh-notes.log");
    writeFileSync(stale, "stale\n");
    writeFileSync(originalRotated, "stale\n");
    writeFileSync(unrelated, "keep\n");
    const old = new Date(Date.now() - 10_000);
    utimesSync(stale, old, old);
    utimesSync(originalRotated, old, old);
    utimesSync(unrelated, old, old);
    const logger = createLogger({ logDir, maxAgeMs: 1_000 });

    logger.info("test.retention_age");
    await logger.flush();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(originalRotated)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("preserves emergency logs owned by a live process during retention", async () => {
    const logDir = createTempDir();
    const firstLogger = createLogger({ logDir });

    firstLogger.error("test.emergency");
    firstLogger.flushSync();
    const emergencyFile = readdirSync(logDir).find((name) => name.endsWith("-emergency.log"));
    expect(emergencyFile).toBeDefined();

    const secondLogger = createLogger({ logDir, maxFiles: 1, maxDirectoryBytes: 1 });
    secondLogger.info("test.retention");
    await secondLogger.flush();

    expect(existsSync(join(logDir, emergencyFile!))).toBe(true);
  });

  it("reports bounded-queue loss and preserves a queued warning", async () => {
    const logDir = createTempDir();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ logDir, maxQueueBytes: 1_000 });

    for (let index = 0; index < 100; index += 1) {
      logger.info("queue.info", { index, detail: "x".repeat(100) });
    }
    logger.warn("queue.warning", { outcome: "preserved" });
    await logger.flush();

    const records = readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .flatMap((name) =>
        readFileSync(join(logDir, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      );
    expect(records).toContainEqual(expect.objectContaining({ event: "queue.warning" }));
    expect(records).toContainEqual(
      expect.objectContaining({ event: "logger.records_dropped", info: expect.any(Number) }),
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Log queue full"));
  });

  it("never evicts an error to accept a lower-priority warning", async () => {
    const logDir = createTempDir();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ logDir, maxQueueBytes: 300 });

    logger.error("queue.error", { detail: "x".repeat(80) });
    logger.warn("queue.warning", { detail: "x".repeat(80) });
    await logger.flush();

    const persisted = readdirSync(logDir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => readFileSync(join(logDir, name), "utf8"))
      .join("");
    expect(persisted).toContain('"event":"queue.error"');
    expect(persisted).not.toContain('"event":"queue.warning"');
  });

  it("settles flush when the queue cannot hold a drop summary", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ logDir: createTempDir(), maxQueueBytes: 1 });

    logger.info("queue.too_small");
    await logger.flush();

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Log queue full"));
  });

  it("replaces an oversized record with bounded metadata", async () => {
    const logger = createLogger({ logDir: createTempDir(), maxRecordBytes: 512 });

    logger.info("record.large", {
      detail: "private-large-value".repeat(1_000),
      ...Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`metric_${index}`, index])),
    });
    await logger.flush();

    const persisted = readFileSync(logger.getLogPath(), "utf8");
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(MIN_LOG_RECORD_BYTES);
    expect(JSON.parse(persisted)).toMatchObject({ record_truncated: true });
    expect(persisted).not.toContain("private-large-value");
  });

  it("enforces the minimum record limit for tiny configurations", async () => {
    const logger = createLogger({ logDir: createTempDir(), maxRecordBytes: 1 });
    const privateContext = "\0".repeat(160);

    logger.runWithContext(
      {
        request_id: privateContext,
        operation_id: privateContext,
        publication_id: privateContext,
      },
      () => logger.info("record.tiny_limit", { detail: "private-value".repeat(1_000) }),
    );
    await logger.flush();

    const persisted = readFileSync(logger.getLogPath(), "utf8");
    expect(Buffer.byteLength(persisted)).toBeLessThanOrEqual(MIN_LOG_RECORD_BYTES);
    expect(JSON.parse(persisted)).toMatchObject({ record_truncated: true });
    expect(persisted).not.toContain("private-value");
  });

  it("defers file access until after the logging call returns", async () => {
    const logger = createLogger({ logDir: createTempDir(), maxBytes: 10_000 });

    logger.info("test.first");

    expect(existsSync(logger.getLogPath())).toBe(false);
    await logger.flush();
    expect(existsSync(logger.getLogPath())).toBe(true);
  });

  it("reports a file write failure once instead of dropping it silently", async () => {
    const root = createTempDir();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = createLogger({ logDir: blocker });

    logger.info("test.failure");
    logger.info("test.failure-again");
    await logger.flush();

    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Failed to write log"));
  });
});

describe("CS-141: log permissions", () => {
  const isPosix = process.platform !== "win32";

  it.runIf(isPosix)("tightens logs a previous run left readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-log-existing-"));
    try {
      const staleLogs = [
        join(dir, "codesesh-12345-2026-01-01T00-00-00-000Z-1.log"),
        join(dir, "codesesh-2026-01-01T00-00-00-000Z-12345-1.log"),
        join(dir, "codesesh.log"),
      ];
      for (const stale of staleLogs) {
        writeFileSync(stale, "old entry");
        chmodSync(stale, 0o644);
      }

      const logger = new AppLogger({ logDir: dir });
      logger.info("permissions.check", { ok: true });
      await logger.close();

      for (const stale of staleLogs) expect(statSync(stale).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(isPosix)("keeps the log directory and file owner-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-log-perms-"));
    try {
      const logger = new AppLogger({ logDir: dir });
      logger.info("permissions.check", { ok: true });
      await logger.flush();
      const logPath = logger.getLogPath();

      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(logPath!).mode & 0o777).toBe(0o600);
      await logger.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
