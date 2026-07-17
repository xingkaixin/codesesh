import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  getCacheInfo,
  loadCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "../sessions.js";
import { setFtsIntegrityCheckedPath, setSchemaEnsuredPath } from "../db.js";
import { makeSessionHead } from "./fixtures.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-sessions-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

describe("cached sessions", () => {
  it("persists full snapshots and metadata", () => {
    saveCachedSessions("codex", [makeSessionHead("one")], {
      one: { id: "one", sourcePath: "/transcripts/one.jsonl" },
    });

    expect(loadCachedSessions("codex")).toMatchObject({
      sessions: [{ id: "one" }],
      meta: { one: { sourcePath: "/transcripts/one.jsonl" } },
    });
    expect(getCacheInfo().size).toBe(1);
  });

  it("applies changed and removed session ids atomically", () => {
    saveCachedSessions("codex", [makeSessionHead("keep"), makeSessionHead("remove")]);
    const changed = makeSessionHead("keep", { title: "Updated" });

    saveCachedSessionChanges("codex", [{ session: changed, sortIndex: 0 }], ["remove"]);

    expect(loadCachedSessions("codex")?.sessions).toEqual([
      expect.objectContaining({ id: "keep", title: "Updated" }),
    ]);
  });

  it("clears persisted rows without leaving stale state", () => {
    saveCachedSessions("codex", [makeSessionHead("one")]);
    clearCache();

    expect(loadCachedSessions("codex")).toBeNull();
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });
});
