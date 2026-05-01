import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppLogger } from "./logging.js";

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
  });

  it("writes structured log lines", () => {
    const logDir = createTempDir();
    const logger = new AppLogger({ logDir, maxBytes: 10_000 });

    logger.info("test.event", { duration_ms: 12, ok: true });

    const line = readFileSync(join(logDir, "codesesh.log"), "utf8").trim();
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
    expect(files).toContain("codesesh.log");
  });
});
