import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchSessions } from "../search.js";
import {
  readPendingSearchIndexMaintenance,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "../search-index-writer.js";
import { setSchemaEnsuredPath } from "../db.js";
import { commitDurableSessionPublication } from "../publication.js";
import { withCacheDb } from "../schema.js";
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

  it("recomputes the message hash chain when an indexed prefix changes", () => {
    const session = {
      ...makeSessionHead("chain"),
      stats: { ...makeSessionHead("chain").stats, message_count: 2 },
    };
    const firstMeta = { id: session.id, sourcePath: "/chain", sourceFingerprint: "first" };
    const nextMeta = { ...firstMeta, sourceFingerprint: "next" };
    const detail = (firstText: string, secondText: string) => ({
      ...makeSessionData(session.id),
      ...session,
      messages: [
        {
          id: "m1",
          role: "user" as const,
          time_created: 1,
          parts: [{ type: "text" as const, text: firstText }],
        },
        {
          id: "m2",
          role: "assistant" as const,
          time_created: 2,
          parts: [{ type: "text" as const, text: secondText }],
        },
      ],
    });
    const readDigests = () =>
      withCacheDb(
        (db) =>
          db
            .prepare(
              "SELECT content_chain_digest FROM messages WHERE agent_name = ? AND session_id = ? ORDER BY message_index",
            )
            .all("codex", session.id) as Array<{ content_chain_digest?: string | null }>,
      )?.map((row) => row.content_chain_digest);

    saveCachedSessions("codex", [session], { [session.id]: firstMeta });
    syncSessionSearchIndex("codex", [session], () => detail("first", "second"));
    const firstDigests = readDigests();

    saveCachedSessions("codex", [session], { [session.id]: nextMeta });
    syncSessionSearchIndex("codex", [session], () => detail("rewritten", "second"));
    const nextDigests = readDigests();

    expect(firstDigests).toHaveLength(2);
    expect(firstDigests?.every((digest) => /^[a-f0-9]{64}$/.test(digest ?? ""))).toBe(true);
    expect(nextDigests).toHaveLength(2);
    expect(nextDigests).not.toEqual(firstDigests);
  });

  it("rolls back message hash chains with their rows", () => {
    const session = {
      ...makeSessionHead("rollback"),
      stats: { ...makeSessionHead("rollback").stats, message_count: 2 },
    };
    const firstMeta = { id: session.id, sourcePath: "/rollback", sourceFingerprint: "first" };
    const nextMeta = { ...firstMeta, sourceFingerprint: "next" };
    const detail = (firstText: string, secondText: string) => ({
      ...makeSessionData(session.id),
      ...session,
      messages: [
        {
          id: "m1",
          role: "user" as const,
          time_created: 1,
          parts: [{ type: "text" as const, text: firstText }],
        },
        {
          id: "m2",
          role: "assistant" as const,
          time_created: 2,
          parts: [{ type: "text" as const, text: secondText }],
        },
      ],
    });

    saveCachedSessions("codex", [session], { [session.id]: firstMeta });
    syncSessionSearchIndex("codex", [session], () => detail("first", "second"));
    const before = loadCachedSessionRawEntry("codex", session.id)?.messageRows.map((row) => ({
      partsJson: row.parts_json,
      digest: row.content_chain_digest,
    }));
    withCacheDb((db) => {
      db.exec(`
        CREATE TRIGGER reject_message_chain_update
        BEFORE UPDATE OF content_chain_digest ON messages
        WHEN NEW.agent_name = 'codex' AND NEW.session_id = 'rollback' AND NEW.message_index = 1
        BEGIN
          SELECT RAISE(ABORT, 'reject message hash chain update');
        END;
      `);
    });
    saveCachedSessions("codex", [session], { [session.id]: nextMeta });

    expect(
      syncSessionSearchIndex("codex", [session], () => detail("rewritten", "second")),
    ).toBeNull();
    const after = loadCachedSessionRawEntry("codex", session.id)?.messageRows.map((row) => ({
      partsJson: row.parts_json,
      digest: row.content_chain_digest,
    }));

    expect(after).toEqual(before);
  });

  it("keeps migration reindex work out of foreground publications", () => {
    const session = makeSessionHead("one");
    const loadSession = vi.fn(() => makeSessionData("one", "migration needle"));
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], loadSession);
    withCacheDb((db) => {
      db.prepare("INSERT INTO pending_reindex(agent_name, session_id) VALUES (?, ?)").run(
        "codex",
        session.id,
      );
      db.prepare(
        "UPDATE session_documents SET content_hash = '' WHERE agent_name = ? AND session_id = ?",
      ).run("codex", session.id);
    });
    loadSession.mockClear();

    expect(readPendingSearchIndexMaintenance("codex", 16)).toEqual({
      sessionIds: [session.id],
      total: 1,
    });
    const foregroundPublication = commitDurableSessionPublication(
      {
        kind: "changes",
        agentName: "codex",
        changes: [{ session, sortIndex: 0 }],
        removedSessionIds: [],
        meta: {},
      },
      loadSession,
    );
    expect(foregroundPublication).toMatchObject({
      status: "committed",
      searchIndex: { changed: 0, indexed: 0 },
    });
    expect(loadSession).not.toHaveBeenCalled();
    expect(readPendingSearchIndexMaintenance("codex", 16)?.total).toBe(1);

    expect(
      syncSessionSearchIndexChanges("codex", [{ session, sortIndex: 0 }], [], loadSession, {
        isBulk: false,
      }),
    ).toMatchObject({ changed: 1, indexed: 1 });
    expect(readPendingSearchIndexMaintenance("codex", 16)).toEqual({
      sessionIds: [],
      total: 0,
    });
  });

  it("still indexes a real head change while maintenance is pending", () => {
    const session = makeSessionHead("one");
    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => makeSessionData("one", "old detail"));
    withCacheDb((db) => {
      db.prepare("INSERT INTO pending_reindex(agent_name, session_id) VALUES (?, ?)").run(
        "codex",
        session.id,
      );
      db.prepare(
        "UPDATE session_documents SET content_hash = '' WHERE agent_name = ? AND session_id = ?",
      ).run("codex", session.id);
    });
    const updated = { ...session, title: "Updated head" };
    const loadSession = vi.fn(() => ({ ...makeSessionData("one", "new detail"), ...updated }));

    const publication = commitDurableSessionPublication(
      {
        kind: "changes",
        agentName: "codex",
        changes: [{ session: updated, sortIndex: 0 }],
        removedSessionIds: [],
        meta: {},
      },
      loadSession,
    );

    expect(publication).toMatchObject({
      status: "committed",
      searchIndex: { changed: 1, indexed: 1 },
    });
    expect(loadSession).toHaveBeenCalledOnce();
    expect(readPendingSearchIndexMaintenance("codex", 16)?.total).toBe(0);
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
