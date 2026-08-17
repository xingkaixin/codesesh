import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { getPnpmInvocation } from "./lib/pnpm-process.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wwwRoot = join(repoRoot, "apps/www");
// These real CLI processes share CI CPU with coverage workers.
const QUALITY_TOOL_TIMEOUT_MS = 20_000;
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runWwwTool(args) {
  const { executable, shell } = getPnpmInvocation();
  return spawnSync(executable, ["--dir", wwwRoot, "exec", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    shell,
  });
}

describe("CS-173: Astro quality tools", () => {
  it(
    "rejects parser-aware lint and formatting defects in an Astro fixture",
    { timeout: QUALITY_TOOL_TIMEOUT_MS },
    () => {
      const dir = mkdtempSync(join(wwwRoot, ".quality-fixture-"));
      tempDirs.push(dir);
      const fixture = join(dir, "invalid.astro");
      writeFileSync(
        fixture,
        '---\nconst label="demo"\n---\n<img src="/demo.png" data-label={label}>\n',
      );

      const lint = runWwwTool(["eslint", fixture]);
      const format = runWwwTool(["prettier", "--check", fixture]);

      expect(lint.status).not.toBe(0);
      expect(`${lint.stdout}\n${lint.stderr}`).toContain("astro/jsx-a11y/alt-text");
      expect(format.status).not.toBe(0);
      expect(`${format.stdout}\n${format.stderr}`).toContain("Code style issues");
    },
  );
});
