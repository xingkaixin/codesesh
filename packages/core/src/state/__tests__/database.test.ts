import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getStateSchemaEnsuredPath,
  setStateSchemaEnsuredPath,
  useMemoryStateStore,
  withStateDb,
} from "../database.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-state-database-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

function getStatePath(): string {
  return join(testHomeDir, ".local", "share", "codesesh", "state.db");
}

function getUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  setStateSchemaEnsuredPath(null);
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

  it("runs ensureSchema on the first open but skips it on later opens for the same path", () => {
    withStateDb(() => undefined);
    expect(getStateSchemaEnsuredPath()).toBe(getStatePath());
    expect(getUserVersion(getStatePath())).toBe(2);

    // Downgrade the on-disk version to prove the next open leaves it alone:
    // if ensureSchema ran, it would migrate this back up to 2.
    const db = new Database(getStatePath());
    db.pragma("user_version = 1");
    db.close();

    withStateDb(() => undefined);
    expect(getUserVersion(getStatePath())).toBe(1);

    setStateSchemaEnsuredPath(null);
    withStateDb(() => undefined);
    expect(getUserVersion(getStatePath())).toBe(2);
  });
});
