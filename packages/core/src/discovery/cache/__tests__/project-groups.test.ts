import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-project-groups-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

// Wrap (not replace) withCacheDb so the writable-fallback path is still
// exercised for real, while letting the test assert whether it ran.
vi.mock("../connection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../connection.js")>();
  return { ...actual, withCacheDb: vi.fn(actual.withCacheDb) };
});

import { listCachedProjectGroups } from "../project-groups.js";
import { saveCachedSessions } from "../sessions.js";
import { withCacheDb } from "../connection.js";
import { setSchemaEnsuredPath } from "../db.js";
import { makeSessionHead, TEST_NOW } from "./fixtures.js";

const mockedWithCacheDb = vi.mocked(withCacheDb);

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  mockedWithCacheDb.mockClear();
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("cached project groups", () => {
  it("groups an explicit session set without opening cache storage", () => {
    const sessions = [
      makeSessionHead("one"),
      makeSessionHead("two", {
        reference: { agentName: "claudecode", sessionId: "two" },
        time_updated: 1_800_000_000_000,
      }),
      makeSessionHead("loose", {
        project_identity: { kind: "loose", key: "scratch", displayName: "Scratch" },
      }),
    ];

    expect(listCachedProjectGroups(sessions)).toEqual([
      {
        identityKind: "path",
        identityKey: "/workspace/project",
        displayName: "project",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: 1_800_000_000_000,
      },
      {
        identityKind: "loose",
        identityKey: "scratch",
        displayName: "Scratch",
        sources: ["codex"],
        sessionCount: 1,
        lastActivity: 1_700_000_000_001,
      },
    ]);
    expect(mockedWithCacheDb).not.toHaveBeenCalled();
  });

  it("reads existing cache data through the read-only connection", () => {
    saveCachedSessions("codex", [makeSessionHead("one")]);
    mockedWithCacheDb.mockClear();

    const groups = listCachedProjectGroups();

    expect(groups).toEqual([
      {
        identityKind: "path",
        identityKey: "/workspace/project",
        displayName: "project",
        sources: ["codex"],
        sessionCount: 1,
        lastActivity: TEST_NOW + 1,
      },
    ]);
    expect(mockedWithCacheDb).not.toHaveBeenCalled();
  });
});
