import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLogger } from "./logging.js";

const coreMocks = vi.hoisted(() => ({ restrictPrivateFile: vi.fn() }));

vi.mock("@codesesh/core/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@codesesh/core/runtime")>();
  coreMocks.restrictPrivateFile.mockImplementation(actual.restrictPrivateFile);
  return { ...actual, restrictPrivateFile: coreMocks.restrictPrivateFile };
});

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-logs-"));
  tempDirs.push(dir);
  return dir;
}

describe("AppLogger", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it("writes structured log lines", () => {
    const logDir = createTempDir();
    const logger = new AppLogger({ logDir, maxBytes: 10_000 });

    logger.info("test.event", { duration_ms: 12, ok: true });

    const line = readFileSync(logger.getLogPath(), "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "test.event",
      duration_ms: 12,
      ok: true,
    });
  });

  it("rotates logs and keeps the configured file count", () => {
    const logDir = createTempDir();
    const logger = new AppLogger({ logDir, maxBytes: 120, maxFiles: 2 });

    for (let index = 0; index < 8; index += 1) {
      logger.info("test.rotate", { index, text: "x".repeat(80) });
    }

    const files = readdirSync(logDir).filter((name) => name.endsWith(".log"));
    expect(files.length).toBeLessThanOrEqual(2);
    expect(files).toContain(`codesesh-${process.pid}.log`);
  });

  it("forwards worker entries to a single file owner", () => {
    const workerLogDir = createTempDir();
    const ownerLogDir = createTempDir();
    const messages: unknown[] = [];
    const workerLogger = new AppLogger({ logDir: workerLogDir });
    const ownerLogger = new AppLogger({ logDir: ownerLogDir });
    workerLogger.forwardToParent({ postMessage: (message) => messages.push(message) }, 7);

    workerLogger.warn("worker.warning", { session: "one" });

    expect(existsSync(workerLogger.getLogPath())).toBe(false);
    expect(messages).toHaveLength(1);
    expect(ownerLogger.consumeWorkerMessage(messages[0])).toBe(true);
    expect(ownerLogger.consumeWorkerMessage({ type: "done" })).toBe(false);
    expect(JSON.parse(readFileSync(ownerLogger.getLogPath(), "utf8"))).toMatchObject({
      level: "warn",
      event: "worker.warning",
      session: "one",
      thread_id: 7,
    });
  });

  it("preserves all worker entries across owner rotations", () => {
    const ownerLogDir = createTempDir();
    const owner = new AppLogger({ logDir: ownerLogDir, maxBytes: 300, maxFiles: 200 });
    const messages: unknown[] = [];
    const workers = Array.from({ length: 4 }, (_, threadId) => {
      const logger = new AppLogger({ logDir: createTempDir() });
      logger.forwardToParent({ postMessage: (message) => messages.push(message) }, threadId + 1);
      return logger;
    });

    for (const [worker, logger] of workers.entries()) {
      for (let index = 0; index < 30; index += 1) {
        logger.info("worker.rotation", { worker, index });
      }
    }
    for (const message of messages) owner.consumeWorkerMessage(message);

    const records = readdirSync(ownerLogDir)
      .filter((name) => name.endsWith(".log"))
      .flatMap((name) =>
        readFileSync(join(ownerLogDir, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { worker: number; index: number }),
      );
    const uniqueEntries = new Set(records.map(({ worker, index }) => `${worker}:${index}`));

    expect(records).toHaveLength(120);
    expect(uniqueEntries.size).toBe(120);
  });

  it("does not remove another process's rotated logs", () => {
    const logDir = createTempDir();
    const foreignActiveLog = join(logDir, `codesesh-${process.pid + 1}.log`);
    const foreignLog = join(logDir, `codesesh-${process.pid + 1}-foreign-1.log`);
    writeFileSync(foreignActiveLog, "foreign active\n");
    writeFileSync(foreignLog, "foreign\n");
    const logger = new AppLogger({ logDir, maxBytes: 120, maxFiles: 1 });

    for (let index = 0; index < 4; index += 1) {
      logger.info("test.rotate", { index, text: "x".repeat(80) });
    }

    expect(existsSync(foreignActiveLog)).toBe(true);
    expect(existsSync(foreignLog)).toBe(true);
  });

  it("restricts the active file only when it is created", () => {
    coreMocks.restrictPrivateFile.mockClear();
    const logger = new AppLogger({ logDir: createTempDir(), maxBytes: 10_000 });

    logger.info("test.first");
    logger.info("test.second");

    expect(coreMocks.restrictPrivateFile).toHaveBeenCalledExactlyOnceWith(logger.getLogPath());
  });

  it("reports a file write failure once instead of dropping it silently", () => {
    const root = createTempDir();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "x");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const logger = new AppLogger({ logDir: blocker });

    logger.info("test.failure");
    logger.info("test.failure-again");

    expect(stderr).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Failed to write log"));
  });
});

describe("CS-141: log permissions", () => {
  const isPosix = process.platform !== "win32";

  it.runIf(isPosix)("tightens logs a previous run left readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-log-existing-"));
    try {
      const stale = join(dir, "codesesh-2026-01-01T000000-000Z-1-1.log");
      writeFileSync(stale, "old entry");
      chmodSync(stale, 0o644);

      new AppLogger({ logDir: dir }).info("permissions.check", { ok: true });

      expect(statSync(stale).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(isPosix)("keeps the log directory and file owner-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-log-perms-"));
    try {
      const logger = new AppLogger({ logDir: dir });
      logger.info("permissions.check", { ok: true });
      const logPath = logger.getLogPath();

      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(logPath!).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
