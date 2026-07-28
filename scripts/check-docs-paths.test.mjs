import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHECKED_DOCUMENTS, extractRepositoryPaths, findMissingPaths } from "./check-docs-paths.mjs";

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-docs-check-"));
  tempDirs.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

describe("CS-151: documentation path check", () => {
  it("picks out repository paths and ignores everything else", () => {
    const paths = extractRepositoryPaths(
      [
        "Run `pnpm build` then read `packages/core/src/index.ts`.",
        "See `docs/architecture.md` and `apps/web/src/App.tsx`.",
        "Data lives in `~/.claude/projects/**/*.jsonl`.",
        "Create `packages/core/src/agents/<youragent>.ts`.",
        "Sources match `packages/core/src/**/*.ts`.",
      ].join("\n"),
    );

    expect(paths).toEqual([
      "packages/core/src/index.ts",
      "docs/architecture.md",
      "apps/web/src/App.tsx",
    ]);
  });

  it("reports a path that no longer exists", () => {
    const dir = repo({
      "docs/guide.md": "Entry point: `packages/core/src/discovery/cache.ts`",
      "packages/core/src/index.ts": "",
    });

    expect(findMissingPaths(dir, ["docs/guide.md"])).toEqual([
      { document: "docs/guide.md", path: "packages/core/src/discovery/cache.ts" },
    ]);
  });

  it("accepts a directory reference", () => {
    const dir = repo({
      "docs/guide.md": "Cache modules live in `packages/core/src/discovery/cache/`",
      "packages/core/src/discovery/cache/db.ts": "",
    });

    expect(findMissingPaths(dir, ["docs/guide.md"])).toEqual([]);
  });

  it("reports a document that is not there at all", () => {
    const dir = repo({ "README.md": "" });

    expect(findMissingPaths(dir, ["docs/absent.md"])).toEqual([
      { document: "docs/absent.md", path: "docs/absent.md", reason: "document not found" },
    ]);
  });

  it("checks the documents that describe the repository", () => {
    expect(CHECKED_DOCUMENTS).toContain("README.md");
    expect(CHECKED_DOCUMENTS).toContain("docs/PRD.md");
    expect(CHECKED_DOCUMENTS).toContain("docs/sqlite-storage.md");
  });
});
