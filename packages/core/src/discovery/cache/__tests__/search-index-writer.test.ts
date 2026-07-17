import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSessions } from "../search.js";
import { syncSessionSearchIndex, syncSessionSearchIndexChanges } from "../search-index-writer.js";
import { setFtsIntegrityCheckedPath, setSchemaEnsuredPath } from "../db.js";
import { makeSessionData, makeSessionHead } from "./fixtures.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-search-writer-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

describe("search index writer", () => {
  it("indexes changed sessions and skips an unchanged second pass", () => {
    const session = makeSessionHead("one");
    const loadSession = () => makeSessionData("one", "unique needle");

    expect(syncSessionSearchIndex("codex", [session], loadSession)).toMatchObject({
      mode: "incremental",
      changed: 1,
      indexed: 1,
    });
    expect(searchSessions("needle")).toEqual([
      expect.objectContaining({
        agentName: "codex",
        session: expect.objectContaining({ id: "one" }),
      }),
    ]);
    expect(syncSessionSearchIndex("codex", [session], loadSession)).toMatchObject({
      changed: 0,
      indexed: 0,
    });
  });

  it("deduplicates removals in incremental updates", () => {
    const session = makeSessionHead("one");
    syncSessionSearchIndex("codex", [session], () => makeSessionData("one"));

    expect(
      syncSessionSearchIndexChanges("codex", [], ["one", "one"], () => makeSessionData("one")),
    ).toMatchObject({ deleted: 1, indexed: 0 });
    expect(searchSessions("visible")).toEqual([]);
  });
});
