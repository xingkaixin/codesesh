import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSessions } from "../search.js";
import { syncSessionSearchIndex, syncSessionSearchIndexChanges } from "../search-index-writer.js";
import { setSchemaEnsuredPath } from "../db.js";
import { commitDurableSessionPublication } from "../publication.js";
import {
  loadCachedSessionRawEntry,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "../sessions.js";
import { sessionDetailVersion } from "../detail-version.js";
import { makeSessionData, makeSessionHead } from "./fixtures.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-search-writer-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
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
        reference: { agentName: "codex", sessionId: "one" },
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

  it("plans direct and durable changes with the same rules", () => {
    const directAgent = "codex";
    const durableAgent = "claudecode";
    const initialFor = (agentName: string) =>
      ["updated", "removed"].map((id) => ({
        ...makeSessionHead(id),
        reference: { agentName, sessionId: id },
        slug: `${agentName}/${id}`,
      }));
    const detailFor = (session: ReturnType<typeof makeSessionHead>, text: string) => ({
      ...makeSessionData(session.id, text),
      ...session,
    });

    for (const agentName of [directAgent, durableAgent]) {
      const initial = initialFor(agentName);
      const sessionsById = new Map(initial.map((session) => [session.id, session]));
      saveCachedSessions(agentName, initial);
      syncSessionSearchIndex(agentName, initial, (sessionId) =>
        detailFor(sessionsById.get(sessionId)!, `${agentName} initial ${sessionId}`),
      );
    }

    const directUpdated = { ...initialFor(directAgent)[0]!, title: "Direct updated" };
    const directChanges = [{ session: directUpdated, sortIndex: 0 }];
    saveCachedSessionChanges(directAgent, directChanges, ["removed", "removed"]);
    const directResult = syncSessionSearchIndexChanges(
      directAgent,
      directChanges,
      ["removed", "removed"],
      () => detailFor(directUpdated, "shared updated needle"),
      { isBulk: true },
    );

    const durableUpdated = { ...initialFor(durableAgent)[0]!, title: "Durable updated" };
    const durableResult = commitDurableSessionPublication(
      {
        kind: "changes",
        agentName: durableAgent,
        changes: [{ session: durableUpdated, sortIndex: 0 }],
        removedSessionIds: ["removed", "removed"],
        meta: {},
      },
      () => detailFor(durableUpdated, "shared updated needle"),
      { isBulk: true },
    );

    expect(durableResult.status).toBe("committed");
    expect(directResult).toMatchObject({
      mode: "bulk",
      sessions: 1,
      changed: 1,
      deleted: 1,
      indexed: 1,
      skipped: 0,
    });
    expect(durableResult.status === "committed" && durableResult.searchIndex).toMatchObject({
      mode: directResult?.mode,
      sessions: directResult?.sessions,
      changed: directResult?.changed,
      deleted: directResult?.deleted,
      indexed: directResult?.indexed,
      skipped: directResult?.skipped,
    });
    expect(
      searchSessions("shared updated needle")
        .map(({ reference }) => reference.agentName)
        .sort(),
    ).toEqual([directAgent, durableAgent].sort());
  });

  it("rebuilds detail when only its parser version changes", () => {
    const session = makeSessionHead("one");
    const firstMeta = { id: "one", sourcePath: "/one", parserVersion: "parser-v1" };
    const nextMeta = { ...firstMeta, parserVersion: "parser-v2" };
    saveCachedSessions("codex", [session], { one: firstMeta });
    syncSessionSearchIndex("codex", [session], () => makeSessionData("one", "version one"));
    saveCachedSessions("codex", [session], { one: nextMeta });
    const loadSession = vi.fn(() => makeSessionData("one", "version two"));

    const result = syncSessionSearchIndex("codex", [session], loadSession);

    expect(result).toMatchObject({ changed: 1, indexed: 1, skipped: 0 });
    expect(loadSession).toHaveBeenCalledOnce();
    expect(loadCachedSessionRawEntry("codex", "one")?.detailVersion).toBe(
      sessionDetailVersion(nextMeta),
    );
  });

  it("does not advance detail version when parsing fails", () => {
    const session = makeSessionHead("one");
    const firstMeta = { id: "one", sourcePath: "/one", sourceFingerprint: "source-a" };
    const nextMeta = { ...firstMeta, sourceFingerprint: "source-b" };
    saveCachedSessions("codex", [session], { one: firstMeta });
    syncSessionSearchIndex("codex", [session], () => makeSessionData("one", "version one"));
    saveCachedSessions("codex", [session], { one: nextMeta });

    const result = syncSessionSearchIndex("codex", [session], () => {
      throw new Error("cannot parse source-b");
    });

    expect(result).toMatchObject({
      changed: 1,
      indexed: 0,
      skipped: 1,
      failures: [{ sessionId: "one", reason: "parse-failed", message: "cannot parse source-b" }],
    });
    expect(loadCachedSessionRawEntry("codex", "one")?.detailVersion).toBe(
      sessionDetailVersion(firstMeta),
    );
  });

  it("rejects a late detail commit for a superseded head version", () => {
    const session = makeSessionHead("one");
    const firstMeta = { id: "one", sourcePath: "/one", sourceFingerprint: "source-a" };
    const nextMeta = { ...firstMeta, sourceFingerprint: "source-b" };
    saveCachedSessions("codex", [session], { one: firstMeta });
    syncSessionSearchIndex("codex", [session], () => makeSessionData("one", "version one"));
    saveCachedSessions("codex", [{ ...session, title: "Head B" }], { one: nextMeta });

    const result = syncSessionSearchIndexChanges(
      "codex",
      [{ session: { ...session, title: "Late Head A" }, sortIndex: 0 }],
      [],
      () => makeSessionData("one", "late version a"),
      { detailVersions: { one: sessionDetailVersion(firstMeta) } },
    );

    expect(result).toMatchObject({
      changed: 1,
      indexed: 0,
      skipped: 1,
      failures: [{ sessionId: "one", reason: "superseded" }],
    });
    expect(loadCachedSessionRawEntry("codex", "one")?.detailVersion).toBe(
      sessionDetailVersion(firstMeta),
    );
  });
});
