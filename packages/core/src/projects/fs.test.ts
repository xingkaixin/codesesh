import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realFs } from "./fs.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("realFs", () => {
  it("reads files and returns null for unreadable paths", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-fs-test-"));
    tempDirs.push(tempDir);
    const file = join(tempDir, "package.json");
    writeFileSync(file, '{"name":"codesesh"}');

    expect(realFs.exists(file)).toBe(true);
    expect(realFs.readText(file)).toBe('{"name":"codesesh"}');
    expect(realFs.readText(join(tempDir, "missing.json"))).toBeNull();
  });

  it("runs commands with stdout and exit code", () => {
    const result = realFs.spawn(process.execPath, ["-e", "console.log('ok')"], {
      cwd: process.cwd(),
    });

    expect(result.stdout.trim()).toBe("ok");
    expect(result.exitCode).toBe(0);
  });
});
