import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMemoryStateStore, withStateDb } from "../database.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-state-database-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(testHomeDir, ".local"), { recursive: true, force: true });
});

describe("state database", () => {
  it("creates the complete schema before invoking callers", () => {
    const objects = withStateDb((db) =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all()
        .map((row) => String(row.name)),
    );

    expect(objects).toEqual(expect.arrayContaining(["state_meta", "bookmarks", "session_aliases"]));
  });

  it("derives memory mode from the configured store", () => {
    expect(useMemoryStateStore()).toBe(false);
    vi.stubEnv("CODESESH_STATE_STORE", "memory");
    expect(useMemoryStateStore()).toBe(true);
  });
});
