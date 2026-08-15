import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listFileActivity, searchFileActivitySessions } from "../file-activity.js";
import { commitDurableSessionPublication } from "../publication.js";
import { listCachedProjectGroups } from "../project-groups.js";
import {
  loadCachedSessionData,
  loadCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "../sessions.js";
import {
  searchSessions,
  syncSessionSearchIndex,
  syncSessionSearchIndexChanges,
} from "../search.js";
import { setSchemaEnsuredPath } from "../db.js";
import { MESSAGE_PARTS_FORMAT_VERSION } from "../messages.js";
import { withCacheDb, withSearchDb } from "../schema.js";
import { setCoreDiagnostics } from "../../../utils/diagnostics.js";
import type { SessionDetail, SessionHead } from "../../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-test-"));
const SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS = 30_000;

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

const now = Date.now();
const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(now);

function getCacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

function getCachePath(): string {
  return join(getCacheDir(), "codesesh.db");
}

// Isolated temp directory for session fixtures so computeIdentity always
// resolves to a "path" identity regardless of what manifests exist in /tmp.
const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "codesesh-identity-"));

function makeSession(id: string): SessionHead & Pick<SessionDetail, "reference"> {
  return {
    reference: { agentName: "agent", sessionId: id },
    id,
    slug: `agent/${id}`,
    title: `Session ${id}`,
    directory: FIXTURE_DIR,
    project_identity: {
      kind: "path",
      key: FIXTURE_DIR,
      displayName: FIXTURE_DIR.split(/[\\/]/).pop()!,
    },
    time_created: now,
    time_updated: now,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function makeSessionData(id: string, text: string): SessionDetail {
  const session = makeSession(id);
  return {
    ...session,
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        time_created: now,
        parts: [{ type: "text", text }],
      },
    ],
  };
}

function highlightedText(
  result: { snippet: string; snippetHighlights: Array<{ start: number; end: number }> } | undefined,
): string[] {
  return result?.snippetHighlights.map(({ start, end }) => result.snippet.slice(start, end)) ?? [];
}

function createLegacyCacheTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE agent_cache (
      agent_name TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE cached_sessions (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_json TEXT NOT NULL,
      meta_json TEXT,
      PRIMARY KEY (agent_name, session_id)
    );
  `);
}

function getUserVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number(db.pragma("user_version", { simple: true }));
  } finally {
    db.close();
  }
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
  dateNowSpy.mockReturnValue(now);
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(getCacheDir(), { recursive: true, force: true });
});

describe("session detail re-indexing", () => {
  function toolSessionData(id: string, tool: string): SessionDetail {
    const session = makeSession(id);
    return {
      ...session,
      messages: [
        {
          id: `${id}-m1`,
          role: "assistant",
          time_created: now,
          parts: [{ type: "tool", tool, callID: "c1", state: { status: "running" } }],
        },
      ],
    };
  }

  it("refreshes cached detail when the content hash goes stale", () => {
    const session = makeSession("codex-1");
    saveCachedSessions("codex", [session], {});
    syncSessionSearchIndex("codex", [session], (id) => toolSessionData(id, "exec"));

    expect(loadCachedSessionData("codex", "codex-1")?.messages[0]?.parts[0]).toMatchObject({
      tool: "exec",
    });

    // The upgrade migration clears cached content hashes; simulate a stale one.
    const db = new Database(getCachePath());
    db.prepare(
      "UPDATE session_documents SET content_hash = 'stale' WHERE agent_name = 'codex'",
    ).run();
    db.close();

    syncSessionSearchIndex("codex", [session], (id) => toolSessionData(id, "bash"));

    expect(loadCachedSessionData("codex", "codex-1")?.messages[0]?.parts[0]).toMatchObject({
      tool: "bash",
    });
  });

  it("marks Codex details pending once on the exec-decode migration", () => {
    saveCachedSessions("codex", [makeSession("codex-1")], {});
    saveCachedSessions("claudecode", [makeSession("cc-1")], {});
    syncSessionSearchIndex("codex", [makeSession("codex-1")], (id) => toolSessionData(id, "exec"));
    syncSessionSearchIndex("claudecode", [makeSession("cc-1")], (id) =>
      makeSessionData(id, "keep me"),
    );
    expect(loadCachedSessionData("codex", "codex-1")?.messages).toHaveLength(1);

    // Simulate a pre-migration cache and reopen it through the storage boundary.
    const raw = new Database(getCachePath());
    raw.prepare("DELETE FROM cache_meta WHERE key = 'codex_exec_decode_migrated_v3'").run();
    raw.pragma("user_version = 13");
    raw.close();
    setSchemaEnsuredPath(null);
    withCacheDb(() => undefined);

    // Schema v19 cannot prove which parser/source version produced legacy
    // projections, so all existing details remain readable as stale raw data
    // but the legacy cache API reports them pending until rebuilt.
    expect(loadCachedSessionData("codex", "codex-1")?.messages).toHaveLength(0);
    expect(loadCachedSessionData("claudecode", "cc-1")?.messages).toHaveLength(0);

    // Idempotent: re-parsed rows survive a second run because the flag is set.
    syncSessionSearchIndex("codex", [makeSession("codex-1")], (id) => toolSessionData(id, "bash"));
    setSchemaEnsuredPath(null);
    withCacheDb(() => undefined);
    expect(loadCachedSessionData("codex", "codex-1")?.messages[0]?.parts[0]).toMatchObject({
      tool: "bash",
    });
  });
});

describe("durable publication", () => {
  it("rolls back when the head write fails", () => {
    const original = makeSession("head-failure");
    saveCachedSessions("codex", [original]);
    syncSessionSearchIndex("codex", [original], () =>
      makeSessionData(original.id, "head old content"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec(`
        CREATE TRIGGER fail_atomic_head_update
        BEFORE UPDATE ON sessions
        WHEN NEW.title = 'Head failure'
        BEGIN
          SELECT RAISE(ABORT, 'forced head failure');
        END;
      `);
    } finally {
      db.close();
    }

    const result = commitDurableSessionPublication(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions: [{ ...original, title: "Head failure" }],
        meta: {},
        completeness: "complete",
        removedSessionIds: [],
      },
      () => makeSessionData(original.id, "head updated content"),
    );

    expect(result).toMatchObject({ status: "rolled-back", stage: "cache" });
    expect(loadCachedSessions("codex")?.sessions[0]?.title).toBe(original.title);
    expect(searchSessions("head old content")).toHaveLength(1);
    expect(searchSessions("head updated content")).toHaveLength(0);
  });

  it("rolls back the head cache when the search write fails", () => {
    const original = makeSession("atomic");
    saveCachedSessions("codex", [original], { atomic: { id: "atomic", sourcePath: "/old" } });
    syncSessionSearchIndex("codex", [original], () => makeSessionData("atomic", "old content"));

    const db = new Database(getCachePath());
    try {
      db.exec(`
        CREATE TRIGGER fail_atomic_search_update
        BEFORE UPDATE ON session_documents
        WHEN NEW.title = 'Updated atomic'
        BEGIN
          SELECT RAISE(ABORT, 'forced search failure');
        END;
      `);
    } finally {
      db.close();
    }

    const updated = { ...original, title: "Updated atomic" };
    const diagnosticEvents: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    let failed: ReturnType<typeof commitDurableSessionPublication>;
    try {
      setCoreDiagnostics({
        info: (event, detail) => diagnosticEvents.push({ event, detail }),
        warn: (event, detail) => diagnosticEvents.push({ event, detail }),
      });
      failed = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions: [updated],
          meta: { atomic: { id: "atomic", sourcePath: "/updated" } },
          completeness: "complete",
          removedSessionIds: [],
          publicationId: "scan.refresh:codex:1",
        },
        () => makeSessionData("atomic", "updated content"),
      );
    } finally {
      setCoreDiagnostics(null);
    }

    expect(failed).toMatchObject({
      status: "rolled-back",
      stage: "search_index",
      publicationId: "scan.refresh:codex:1",
    });

    expect(loadCachedSessions("codex")?.sessions[0]?.title).toBe(original.title);
    expect(loadCachedSessions("codex")?.meta.atomic?.sourcePath).toBe("/old");
    expect(searchSessions("old content")).toHaveLength(1);
    expect(searchSessions("updated content")).toHaveLength(0);
    expect(diagnosticEvents).toContainEqual({
      event: "search_index.publication_stage",
      detail: expect.objectContaining({
        publication_id: failed.publicationId,
        stage: "rolled_back",
        failure_stage: "search_index",
      }),
    });

    const retryDb = new Database(getCachePath());
    try {
      retryDb.exec("DROP TRIGGER fail_atomic_search_update");
    } finally {
      retryDb.close();
    }
    const retried = commitDurableSessionPublication(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions: [updated],
        meta: { atomic: { id: "atomic", sourcePath: "/updated" } },
        completeness: "complete",
        removedSessionIds: [],
      },
      () => makeSessionData("atomic", "updated content"),
    );

    expect(retried.status).toBe("committed");
    expect(loadCachedSessions("codex")?.sessions[0]?.title).toBe(updated.title);
    expect(loadCachedSessions("codex")?.meta.atomic?.sourcePath).toBe("/updated");
    expect(searchSessions("updated content")).toHaveLength(1);
  });

  it("rolls back staged rows when the transaction commit fails", () => {
    const original = makeSession("commit-failure");
    saveCachedSessions("codex", [original]);
    syncSessionSearchIndex("codex", [original], () =>
      makeSessionData(original.id, "commit old content"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec(`
        CREATE TABLE publication_commit_parent(id INTEGER PRIMARY KEY);
        CREATE TABLE publication_commit_failure(
          parent_id INTEGER,
          FOREIGN KEY(parent_id) REFERENCES publication_commit_parent(id)
            DEFERRABLE INITIALLY DEFERRED
        );
        CREATE TRIGGER fail_atomic_publication_commit
        AFTER UPDATE ON sessions
        WHEN NEW.title = 'Commit failure'
        BEGIN
          INSERT INTO publication_commit_failure(parent_id) VALUES (1);
        END;
      `);
    } finally {
      db.close();
    }

    const result = commitDurableSessionPublication(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions: [{ ...original, title: "Commit failure" }],
        meta: {},
        completeness: "complete",
        removedSessionIds: [],
      },
      () => makeSessionData(original.id, "commit updated content"),
    );

    expect(result).toMatchObject({ status: "rolled-back", stage: "commit" });
    expect(loadCachedSessions("codex")?.sessions[0]?.title).toBe(original.title);
    expect(searchSessions("commit old content")).toHaveLength(1);
    expect(searchSessions("commit updated content")).toHaveLength(0);
    const verifyDb = new Database(getCachePath(), { readonly: true });
    try {
      expect(
        verifyDb.prepare("SELECT COUNT(*) AS value FROM publication_commit_failure").get(),
      ).toEqual({ value: 0 });
    } finally {
      verifyDb.close();
    }
  });

  it(
    "pre-stages a backlog larger than one commit chunk and commits it fully",
    () => {
      const sessions = Array.from({ length: 70 }, (_, index) => makeSession(`bulk-${index}`));

      const result = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        (sessionId) => makeSessionData(sessionId, `${sessionId} bulk needle`),
      );

      expect(result.status).toBe("committed");
      expect(result.status === "committed" && result.searchIndex).toMatchObject({
        changed: 70,
        indexed: 70,
        skipped: 0,
      });
      expect(loadCachedSessions("codex")?.sessions).toHaveLength(70);
      expect(searchSessions("bulk-42 bulk needle")).toHaveLength(1);
      expect(
        withCacheDb((db) =>
          db.prepare("SELECT COUNT(*) AS value FROM search_index_publication_entries").get(),
        ),
      ).toEqual({ value: 0 });

      const loadAgain = vi.fn((sessionId: string) =>
        makeSessionData(sessionId, `${sessionId} bulk needle`),
      );
      const unchanged = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        loadAgain,
      );

      expect(unchanged.status).toBe("committed");
      expect(unchanged.status === "committed" && unchanged.searchIndex).toMatchObject({
        changed: 0,
        indexed: 0,
      });
      expect(loadAgain).not.toHaveBeenCalled();
    },
    SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "discards shadow entries when a large publication rolls back",
    () => {
      const historical = makeSession("historical");
      saveCachedSessions("codex", [historical], {
        historical: { id: historical.id, sourcePath: "/historical" },
      });
      syncSessionSearchIndex("codex", [historical], () =>
        makeSessionData(historical.id, "historical content"),
      );

      const sessions = Array.from({ length: 70 }, (_, index) => makeSession(`rollback-${index}`));
      const meta = Object.fromEntries(
        sessions.map((session) => [session.id, { id: session.id, sourcePath: `/${session.id}` }]),
      );
      const db = new Database(getCachePath());
      try {
        db.exec(`
          CREATE TRIGGER fail_large_publication_head_write
          BEFORE INSERT ON sessions
          WHEN NEW.meta_json IS NOT NULL
          BEGIN
            SELECT RAISE(ABORT, 'forced large publication failure');
          END;
        `);
      } finally {
        db.close();
      }

      const result = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions,
          meta,
          completeness: "complete",
          removedSessionIds: [],
        },
        (sessionId) => makeSessionData(sessionId, `${sessionId} rollback content`),
      );

      expect(result).toMatchObject({ status: "rolled-back", stage: "cache" });
      expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).toEqual([historical.id]);
      expect(searchSessions("rollback-42 rollback content")).toHaveLength(0);
      const verifyDb = new Database(getCachePath(), { readonly: true });
      try {
        expect(
          verifyDb
            .prepare(
              "SELECT COUNT(*) AS value FROM sessions WHERE agent_name = ? AND publication_id IS NULL",
            )
            .get("codex"),
        ).toEqual({ value: 1 });
        expect(
          verifyDb
            .prepare(
              "SELECT COUNT(*) AS value FROM sessions WHERE agent_name = ? AND publication_id = ?",
            )
            .get("codex", result.publicationId),
        ).toEqual({ value: 0 });
        expect(
          verifyDb
            .prepare("SELECT COUNT(*) AS value FROM session_documents WHERE agent_name = ?")
            .get("codex"),
        ).toEqual({ value: 1 });
        expect(
          verifyDb
            .prepare(
              "SELECT COUNT(*) AS value FROM search_index_publication_entries WHERE publication_id = ?",
            )
            .get(result.publicationId),
        ).toEqual({ value: 0 });
      } finally {
        verifyDb.close();
      }
    },
    SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "keeps live details aligned with heads when an updated backlog rolls back",
    () => {
      const originals = Array.from({ length: 70 }, (_, index) => makeSession(`aligned-${index}`));
      saveCachedSessions("codex", originals);
      syncSessionSearchIndex("codex", originals, (sessionId) =>
        makeSessionData(sessionId, `${sessionId} old detail`),
      );

      const updated = originals.map((session) => ({
        ...session,
        title: `Updated ${session.id}`,
      }));
      const db = new Database(getCachePath());
      try {
        db.exec(`
          CREATE TRIGGER fail_updated_backlog_head_write
          BEFORE UPDATE ON sessions
          WHEN NEW.title LIKE 'Updated aligned-%'
          BEGIN
            SELECT RAISE(ABORT, 'forced updated backlog failure');
          END;
        `);
      } finally {
        db.close();
      }

      const failed = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions: updated,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
          publicationId: "scan.refresh:codex:aligned",
        },
        (sessionId) => makeSessionData(sessionId, `${sessionId} new detail`),
      );

      expect(failed).toMatchObject({ status: "rolled-back", stage: "cache" });
      expect(loadCachedSessions("codex")?.sessions[0]?.title).toBe(originals[0]?.title);
      expect(loadCachedSessionData("codex", "aligned-0")?.messages[0]?.parts).toEqual([
        { type: "text", text: "aligned-0 old detail" },
      ]);
      expect(searchSessions("aligned-0 new detail")).toHaveLength(0);

      const retryDb = new Database(getCachePath());
      try {
        retryDb.exec("DROP TRIGGER fail_updated_backlog_head_write");
      } finally {
        retryDb.close();
      }
      const retryLoader = vi.fn((sessionId: string) =>
        makeSessionData(sessionId, `${sessionId} new detail`),
      );
      const retried = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions: updated,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        retryLoader,
      );

      expect(retried.status).toBe("committed");
      expect(retryLoader).toHaveBeenCalledTimes(70);
      expect(searchSessions("aligned-0 new detail")).toHaveLength(1);
    },
    SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS,
  );

  it(
    "resumes a large backlog without re-parsing sessions from finished chunks",
    () => {
      const sessions = Array.from({ length: 70 }, (_, index) => makeSession(`resume-${index}`));
      const failingIds = new Set(["resume-68", "resume-69"]);

      const firstPass = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        (sessionId) => {
          if (failingIds.has(sessionId)) throw new Error(`cannot parse ${sessionId}`);
          return makeSessionData(sessionId, `${sessionId} resume needle`);
        },
      );

      expect(firstPass.status).toBe("committed");
      expect(firstPass.status === "committed" && firstPass.searchIndex).toMatchObject({
        changed: 70,
        indexed: 68,
        skipped: 2,
      });

      const retryLoader = vi.fn((sessionId: string) =>
        makeSessionData(sessionId, `${sessionId} resume needle`),
      );
      const secondPass = commitDurableSessionPublication(
        {
          kind: "snapshot",
          agentName: "codex",
          sessions,
          meta: {},
          completeness: "complete",
          removedSessionIds: [],
        },
        retryLoader,
      );

      expect(secondPass.status).toBe("committed");
      expect(secondPass.status === "committed" && secondPass.searchIndex).toMatchObject({
        changed: 2,
        indexed: 2,
        skipped: 0,
      });
      expect(retryLoader.mock.calls.map(([sessionId]) => sessionId).sort()).toEqual([
        "resume-68",
        "resume-69",
      ]);
      expect(searchSessions("resume-69 resume needle")).toHaveLength(1);
    },
    SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS,
  );

  it("commits partial snapshots and incremental changes through the same interface", () => {
    const historical = makeSession("historical");
    const recent = makeSession("recent");
    const removed = makeSession("removed");
    const initial = [historical, recent, removed];
    saveCachedSessions("codex", initial);
    syncSessionSearchIndex("codex", initial, (sessionId) =>
      makeSessionData(sessionId, `${sessionId} publication content`),
    );

    const updatedRecent = { ...recent, title: "Recent partial" };
    const partial = commitDurableSessionPublication(
      {
        kind: "snapshot",
        agentName: "codex",
        sessions: [updatedRecent],
        meta: {},
        completeness: "partial",
        removedSessionIds: [removed.id],
      },
      () => makeSessionData(recent.id, "recent partial content"),
    );

    expect(partial.status).toBe("committed");
    expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).toEqual(
      expect.arrayContaining([recent.id, historical.id]),
    );
    expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).not.toContain(removed.id);
    expect(searchSessions("historical publication")).toHaveLength(1);
    expect(searchSessions("removed publication")).toHaveLength(0);

    const updatedHistorical = { ...historical, title: "Historical incremental" };
    const incremental = commitDurableSessionPublication(
      {
        kind: "changes",
        agentName: "codex",
        changes: [{ session: updatedHistorical, sortIndex: 0 }],
        removedSessionIds: [recent.id],
        meta: {},
      },
      () => makeSessionData(historical.id, "historical incremental content"),
    );

    expect(incremental.status).toBe("committed");
    expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).toEqual([historical.id]);
    expect(searchSessions("historical incremental")).toHaveLength(1);
    expect(searchSessions("recent partial")).toHaveLength(0);
  });
});

describe("searchSessions", () => {
  it("preserves strict cost qualifier comparisons", () => {
    const below = {
      ...makeSession("below"),
      time_updated: now + 1,
      stats: { ...makeSession("below").stats, total_cost: 0.99 },
    };
    const boundary = {
      ...makeSession("boundary"),
      time_updated: now + 2,
      stats: { ...makeSession("boundary").stats, total_cost: 1 },
    };
    const above = {
      ...makeSession("above"),
      time_updated: now + 3,
      stats: { ...makeSession("above").stats, total_cost: 1.01 },
    };

    saveCachedSessions("codex", [below, boundary, above]);

    expect(searchSessions("cost:>1").map((result) => result.session.id)).toEqual(["above"]);
    expect(searchSessions("cost:<1").map((result) => result.session.id)).toEqual(["below"]);
    expect(searchSessions("cost:>=1").map((result) => result.session.id)).toEqual([
      "above",
      "boundary",
    ]);
    expect(searchSessions("cost:<=1").map((result) => result.session.id)).toEqual([
      "boundary",
      "below",
    ]);
  });

  it("filters indexed parents by inclusive child cost", () => {
    const parent = {
      ...makeSession("inclusive-parent"),
      slug: "codex/inclusive-parent",
      stats: { ...makeSession("inclusive-parent").stats, total_cost: 0 },
    };
    const child = {
      ...makeSession("inclusive-child"),
      slug: "codex/inclusive-child",
      parent_reference: { agentName: "codex", sessionId: "inclusive-parent" },
      stats: { ...makeSession("inclusive-child").stats, total_cost: 2 },
    };
    const details = new Map<string, SessionDetail>([
      [
        parent.id,
        {
          ...parent,
          reference: { agentName: "codex", sessionId: parent.id },
          messages: [
            {
              id: "parent-message",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "inclusivecostneedle" }],
            },
          ],
        },
      ],
      [
        child.id,
        {
          ...child,
          reference: { agentName: "codex", sessionId: child.id },
          messages: [],
        },
      ],
    ]);
    syncSessionSearchIndex("codex", [parent, child], (sessionId) => details.get(sessionId)!);

    expect(
      searchSessions("inclusivecostneedle cost:>1").map((result) => result.session.id),
    ).toEqual(["inclusive-parent"]);
  });

  it("creates cache storage when syncing search index first", () => {
    const session = makeSession("first-search");

    const result = syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "first search creates the sqlite cache"),
    );

    expect(result).toMatchObject({
      changed: 1,
      indexed: 1,
      skipped: 0,
    });
    expect(searchSessions("sqlite")).toHaveLength(1);
  });

  it("loads full session data from the SQLite message cache", () => {
    const session: SessionHead = {
      ...makeSession("cached-detail"),
      stats: {
        message_count: 1,
        total_input_tokens: 3,
        total_output_tokens: 5,
        total_cost: 0.02,
        cost_source: "estimated" as const,
      },
    };
    syncSessionSearchIndex("codex", [session], (sessionId) => ({
      ...makeSessionData(sessionId, "detail view reads sqlite"),
      messages: [
        {
          id: "m1",
          role: "assistant",
          time_created: now,
          tokens: { input: 3, output: 5 },
          cost: 0.02,
          cost_source: "estimated",
          parts: [{ type: "text", text: "detail view reads sqlite" }],
        },
      ],
    }));

    const data = loadCachedSessionData("codex", "cached-detail");

    expect(data).toMatchObject({
      id: "cached-detail",
      title: "Session cached-detail",
      stats: {
        message_count: 1,
        total_input_tokens: 3,
        total_output_tokens: 5,
        total_cost: 0.02,
        cost_source: "estimated",
      },
      messages: [
        {
          id: "m1",
          role: "assistant",
          tokens: { input: 3, output: 5 },
          cost: 0.02,
          cost_source: "estimated",
          parts: [{ type: "text", text: "detail view reads sqlite" }],
        },
      ],
    });
  });

  it("indexes session content and returns highlighted matches", () => {
    const session = {
      ...makeSession("s1"),
      stats: {
        message_count: 1,
        total_input_tokens: 11,
        total_output_tokens: 7,
        total_cost: 0.03,
      },
    };
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "sqlite fts search is now enabled"),
    );

    const results = searchSessions("sqlite");
    expect(results).toHaveLength(1);
    expect(results[0]?.reference.agentName).toBe("claudecode");
    expect(results[0]?.session.id).toBe("s1");
    expect(results[0]?.session.stats).toMatchObject({
      message_count: 1,
      total_input_tokens: 11,
      total_output_tokens: 7,
      total_cost: 0.03,
    });
    expect(highlightedText(results[0])).toContain("sqlite");
  });

  it("exposes literal mark text beside a highlighted match", () => {
    const session = makeSession("literal-mark");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "literal <mark>text</mark> before sqlite"),
    );

    const results = searchSessions("sqlite");

    expect(results[0]?.snippet).toContain("literal <mark>text</mark>");
    expect(highlightedText(results[0])).toEqual(["sqlite"]);
  });

  it("filters indexed search by complete project identity", () => {
    const remote = {
      ...makeSession("remote"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/acme/app",
        displayName: "app",
      },
    };
    const path = {
      ...makeSession("path"),
      project_identity: {
        kind: "path" as const,
        key: "github.com/acme/app",
        displayName: "app path",
      },
    };
    const sessions = [remote, path];
    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessions.find((session) => session.id === sessionId)!,
      messages: makeSessionData(sessionId, "identity collision needle").messages,
    }));

    expect(
      searchSessions("collision", {
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      }).map((result) => result.session.id),
    ).toEqual(["remote"]);
    expect(searchSessions("collision", { projectKey: "github.com/acme/app" })).toEqual([]);
  });

  it("resolves search match metadata from message-level FTS", () => {
    const title = {
      ...makeSession("title"),
      title: "titleonly search title",
    };
    const user = makeSession("user");
    const assistant = makeSession("assistant");
    const tool = makeSession("tool");
    const quoted = makeSession("quoted");
    const orFirst = {
      ...makeSession("or-first"),
      stats: { ...makeSession("or-first").stats, message_count: 2 },
    };
    const punctuated = {
      ...makeSession("punctuated"),
      stats: { ...makeSession("punctuated").stats, message_count: 2 },
    };
    const sessions = [title, user, assistant, tool, quoted, orFirst, punctuated];
    const dataById = new Map<string, SessionDetail>([
      [
        "title",
        {
          ...title,
          messages: [
            {
              id: "title-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "body without the title token" }],
            },
          ],
        },
      ],
      [
        "user",
        {
          ...user,
          messages: [
            {
              id: "user-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "userneedle request" }],
            },
          ],
        },
      ],
      [
        "assistant",
        {
          ...assistant,
          messages: [
            {
              id: "assistant-m1",
              role: "assistant",
              time_created: now,
              parts: [{ type: "text", text: "assistantneedle reply" }],
            },
          ],
        },
      ],
      [
        "tool",
        {
          ...tool,
          messages: [
            {
              id: "tool-m1",
              role: "assistant",
              mode: "tool",
              time_created: now,
              parts: [
                {
                  type: "tool",
                  tool: "bash",
                  state: { status: "completed", output: "toolneedle output" },
                },
              ],
            },
          ],
        },
      ],
      [
        "quoted",
        {
          ...quoted,
          messages: [
            {
              id: "quoted-m1",
              role: "user",
              time_created: now,
              parts: [{ type: "text", text: "exact quoted phrase marker" }],
            },
          ],
        },
      ],
      [
        "or-first",
        {
          ...orFirst,
          messages: [
            {
              id: "or-first-m1",
              role: "assistant",
              time_created: now,
              parts: [{ type: "text", text: "betaneedle first" }],
            },
            {
              id: "or-first-m2",
              role: "user",
              time_created: now + 1,
              parts: [{ type: "text", text: "alphaneedle second" }],
            },
          ],
        },
      ],
      [
        "punctuated",
        {
          ...punctuated,
          messages: [
            {
              id: "punctuated-m1",
              role: "assistant",
              time_created: now,
              parts: [{ type: "text", text: "ÉCOLE needle without punctuation" }],
            },
            {
              id: "punctuated-m2",
              role: "user",
              time_created: now + 1,
              parts: [{ type: "text", text: "exact ÉCOLE-needle match" }],
            },
          ],
        },
      ],
    ]);

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => dataById.get(sessionId)!);

    expect(searchSessions("titleonly")[0]?.matchType).toBe("title");
    expect(searchSessions("userneedle")[0]?.matchType).toBe("user_message");
    expect(searchSessions("assistantneedle")[0]?.matchType).toBe("assistant_reply");
    expect(searchSessions("toolneedle")[0]?.matchType).toBe("tool_output");
    expect(highlightedText(searchSessions('"quoted phrase"')[0])).toContain("quoted phrase");

    const allTermResults = searchSessions("assistantneedle reply");
    expect(allTermResults[0]?.session.id).toBe("assistant");
    expect(allTermResults[0]?.matchType).toBe("assistant_reply");

    const orResults = searchSessions("alphaneedle OR betaneedle");
    expect(orResults[0]?.session.id).toBe("or-first");
    expect(orResults[0]?.matchType).toBe("assistant_reply");
    expect(highlightedText(orResults[0])).toContain("betaneedle");

    const punctuatedResults = searchSessions('"école-needle"');
    expect(punctuatedResults[0]?.matchType).toBe("user_message");
    expect(highlightedText(punctuatedResults[0])).toContain("ÉCOLE-needle");
  });

  it("bounds message enrichment to one row per candidate", () => {
    const sessions = Array.from({ length: 3 }, (_, sessionIndex) => ({
      ...makeSession(`bulk-match-${sessionIndex}`),
      stats: { ...makeSession(`bulk-match-${sessionIndex}`).stats, message_count: 30 },
    }));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessions.find((session) => session.id === sessionId)!,
      messages: Array.from({ length: 30 }, (_, messageIndex) => ({
        id: `${sessionId}-m${messageIndex}`,
        role: "user" as const,
        time_created: now + messageIndex,
        parts: [
          {
            type: "text" as const,
            text: `bulkneedle ${sessionId} ${messageIndex}`,
          },
        ],
      })),
    }));

    const preparedSql: string[] = [];
    let returnedMessageRows: number | undefined;
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      preparedSql.push(source);
      const statement = originalPrepare.call(this, source);
      if (!source.includes("first_message_matches")) return statement;

      const originalAll = statement.all.bind(statement);
      statement.all = (...params: unknown[]) => {
        const result = (originalAll as (...boundParams: unknown[]) => unknown[])(...params);
        returnedMessageRows = result.length;
        return result;
      };
      return statement;
    });

    try {
      expect(searchSessions("bulkneedle")).toHaveLength(3);
    } finally {
      prepareSpy.mockRestore();
    }

    const normalizedSql = preparedSql.map((sql) => sql.replace(/\s+/g, " ").trim());
    const messageLookupSql = normalizedSql.filter((sql) =>
      sql.includes("first_message_matches AS MATERIALIZED"),
    );
    expect(messageLookupSql).toHaveLength(1);
    expect(messageLookupSql[0]).toContain("INDEXED BY idx_messages_session");
    expect(messageLookupSql[0]).toContain("codesesh_message_matches_terms(m.content_text)");
    expect(messageLookupSql[0]).not.toContain("messages_fts");
    expect(messageLookupSql[0]).toContain("ORDER BY m.message_index LIMIT 1");
    expect(returnedMessageRows).toBe(sessions.length);
    expect(
      normalizedSql.some((sql) =>
        /FROM messages WHERE agent_name = \? AND session_id = \? ORDER BY message_index/.test(sql),
      ),
    ).toBe(false);
  });

  it("keeps FTS searchable through a chunked large initial index", () => {
    const sessions = Array.from({ length: 101 }, (_, index) => {
      const session = makeSession(`bulk-${index}`);
      if (index === 42) {
        return {
          ...session,
          directory: "/tmp/bulk-project",
          project_identity: {
            kind: "path" as const,
            key: "/tmp/bulk-project",
            displayName: "bulk-project",
          },
        };
      }
      if (index === 43) {
        return {
          ...session,
          directory: "/tmp/other-project",
          project_identity: {
            kind: "path" as const,
            key: "/tmp/other-project",
            displayName: "other-project",
          },
        };
      }
      return session;
    });
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    const result = syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessionMap.get(sessionId)!,
      messages: [
        {
          id: `${sessionId}-m1`,
          role: "user",
          time_created: now,
          parts: [
            {
              type: "text",
              text:
                sessionId === "bulk-42" || sessionId === "bulk-43"
                  ? "bulk needle project filter"
                  : `bulk filler ${sessionId}`,
            },
          ],
        },
      ],
    }));

    // Large backlogs commit in durable chunks with FTS triggers active
    // instead of one bulk rebuild transaction.
    expect(result).toMatchObject({
      mode: "incremental",
      sessions: 101,
      changed: 101,
      deleted: 0,
      indexed: 101,
      skipped: 0,
    });

    const allResults = searchSessions("needle");
    expect(allResults).toHaveLength(2);

    const filteredResults = searchSessions("needle", {
      projectScope: {
        identity: { kind: "path", key: "/tmp/bulk-project" },
        path: "/tmp/bulk-project",
      },
    });
    expect(filteredResults).toHaveLength(1);
    expect(filteredResults[0]?.session.id).toBe("bulk-42");
    expect(highlightedText(filteredResults[0])).toContain("needle");
  });

  it("keeps ancestor and descendant directory scope matches when identities differ", () => {
    const scopeRoot = "/tmp/codesesh-scope";
    const sessions = [
      {
        ...makeSession("scope-ancestor"),
        directory: scopeRoot,
        project_identity: {
          kind: "path" as const,
          key: "/tmp/unrelated-ancestor",
          displayName: "unrelated-ancestor",
        },
      },
      {
        ...makeSession("scope-descendant"),
        directory: `${scopeRoot}/child`,
        project_identity: {
          kind: "path" as const,
          key: "/tmp/unrelated-descendant",
          displayName: "unrelated-descendant",
        },
      },
      {
        ...makeSession("scope-sibling"),
        directory: `${scopeRoot}-sibling`,
        project_identity: {
          kind: "path" as const,
          key: "/tmp/unrelated-sibling",
          displayName: "unrelated-sibling",
        },
      },
    ];
    const sessionById = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessionById.get(sessionId)!,
      messages: [
        {
          id: `${sessionId}-m1`,
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "symmetric scope needle" }],
        },
      ],
    }));

    expect(
      searchSessions("symmetric scope needle", {
        projectScope: {
          identity: { kind: "path", key: "/tmp/no-identity-match" },
          path: `${scopeRoot}/child`,
        },
      })
        .map(({ session }) => session.id)
        .sort(),
    ).toEqual(["scope-ancestor", "scope-descendant"]);
  });

  it("writes each full search entry before loading the next one", () => {
    const sessions = Array.from({ length: 4 }, (_, index) => makeSession(`stream-${index}`));
    let loadedCount = 0;
    let firstWriteLoadedCount: number | undefined;
    const originalPrepare = Database.prototype.prepare;
    const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      const statement = originalPrepare.call(this, source);
      if (!source.includes("INSERT INTO session_documents(")) return statement;

      const originalRun = statement.run.bind(statement);
      statement.run = (...params: unknown[]) => {
        firstWriteLoadedCount ??= loadedCount;
        return (originalRun as (...boundParams: unknown[]) => Database.RunResult)(...params);
      };
      return statement;
    });

    try {
      const result = syncSessionSearchIndex("claudecode", sessions, (sessionId) => {
        loadedCount += 1;
        return makeSessionData(sessionId, `streamed ${sessionId}`);
      });

      expect(result).toMatchObject({ changed: 4, indexed: 4, skipped: 0 });
    } finally {
      prepareSpy.mockRestore();
    }

    expect(loadedCount).toBe(4);
    expect(firstWriteLoadedCount).toBe(1);
  });

  it("validates normalized message counts instead of raw agent counts", () => {
    const session = {
      ...makeSession("normalized-count"),
      stats: { ...makeSession("normalized-count").stats, message_count: 5 },
    };
    const loadSession = vi.fn(() => ({
      ...session,
      messages: makeSessionData(session.id, "normalized content").messages,
    }));

    syncSessionSearchIndex("codex", [session], loadSession);
    loadSession.mockClear();

    const result = syncSessionSearchIndex("codex", [session], loadSession);

    expect(result).toMatchObject({ changed: 0, indexed: 0, skipped: 0 });
    expect(loadSession).not.toHaveBeenCalled();
  });

  it("backfills normalized message counts when migrating existing search documents", () => {
    const session = makeSession("normalized-count-migration");
    syncSessionSearchIndex("codex", [session], () =>
      makeSessionData(session.id, "normalized migration content"),
    );

    const db = new Database(getCachePath());
    try {
      db.prepare("UPDATE session_documents SET indexed_message_count = 0").run();
      db.pragma("user_version = 13");
      db.prepare("UPDATE cache_meta SET value = '13' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    searchSessions("normalized migration");

    const migratedDb = new Database(getCachePath(), { readonly: true });
    try {
      const row = migratedDb
        .prepare("SELECT indexed_message_count FROM session_documents")
        .get() as { indexed_message_count: number };
      expect(row.indexed_message_count).toBe(1);
    } finally {
      migratedDb.close();
    }
    expect(getUserVersion(getCachePath())).toBe(29);
  });

  it("keeps small incremental updates searchable immediately", () => {
    const session = makeSession("small");
    const updated = {
      ...session,
      stats: { ...session.stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "old search content"),
    );

    saveCachedSessions("claudecode", [updated]);
    const result = syncSessionSearchIndex("claudecode", [updated], () => ({
      ...updated,
      messages: [
        {
          id: "small-m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "old search content" }],
        },
        {
          id: "small-m2",
          role: "assistant",
          time_created: now + 1,
          parts: [{ type: "text", text: "instant incremental token" }],
        },
      ],
    }));

    expect(result).toMatchObject({
      mode: "incremental",
      changed: 1,
      indexed: 1,
      deleted: 0,
    });
    expect(result?.rebuildDurationMs).toBeUndefined();
    expect(searchSessions("instant")).toHaveLength(1);
  });

  it("syncs changed search rows without diffing untouched sessions", () => {
    const keep = {
      ...makeSession("keep"),
      stats: { ...makeSession("keep").stats, message_count: 2 },
    };
    const changed = {
      ...makeSession("changed"),
      stats: { ...makeSession("changed").stats, message_count: 2 },
    };
    const removed = {
      ...makeSession("removed"),
      stats: { ...makeSession("removed").stats, message_count: 2 },
    };
    const sessions = [keep, changed, removed];
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));
    const makeIndexedData = (session: SessionHead, text: string, path: string): SessionDetail => ({
      ...session,
      reference: { agentName: "claudecode", sessionId: session.id },
      messages: [
        {
          id: `${session.id}-m1`,
          role: "user",
          time_created: now,
          parts: [{ type: "text", text }],
        },
        {
          id: `${session.id}-m2`,
          role: "assistant",
          time_created: now + 1,
          parts: [
            {
              type: "tool",
              tool: "read",
              state: { status: "completed", input: { path } },
            },
          ],
        },
      ],
    });

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) =>
      makeIndexedData(sessionMap.get(sessionId)!, `${sessionId}token`, `src/${sessionId}.ts`),
    );

    const updated = {
      ...changed,
      title: "Changed updated",
      stats: { ...changed.stats, message_count: 2 },
    };
    const loadChanged = vi.fn((sessionId: string) => {
      if (sessionId !== "changed") {
        throw new Error(`unexpected load ${sessionId}`);
      }
      return makeIndexedData(updated, "updatedtoken", "src/changed-new.ts");
    });

    saveCachedSessionChanges("claudecode", [{ session: updated, sortIndex: 0 }], ["removed"]);
    const result = syncSessionSearchIndexChanges(
      "claudecode",
      [{ session: updated, sortIndex: 0 }],
      ["removed"],
      loadChanged,
    );

    expect(loadChanged).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      mode: "incremental",
      changed: 1,
      deleted: 1,
      indexed: 1,
    });
    expect(searchSessions("updatedtoken").map((item) => item.session.id)).toEqual(["changed"]);
    expect(searchSessions("changedtoken")).toHaveLength(0);
    expect(searchSessions("removedtoken")).toHaveLength(0);
    expect(searchSessions("keeptoken").map((item) => item.session.id)).toEqual(["keep"]);
    expect(
      listFileActivity({ agent: "claudecode" })
        .map((item) => item.path)
        .sort(),
    ).toEqual(["src/changed-new.ts", "src/keep.ts"]);
  });

  it(
    "reads incremental search index state in bounded batches",
    () => {
      const multiBatchSessionCount = 901;
      const sessions = Array.from({ length: multiBatchSessionCount }, (_, index) =>
        makeSession(`batch-${index}`),
      );
      const sessionMap = new Map(sessions.map((session) => [session.id, session]));

      saveCachedSessions("claudecode", sessions);
      syncSessionSearchIndex("claudecode", sessions, (sessionId) =>
        makeSessionData(sessionMap.get(sessionId)!.id, `content ${sessionId}`),
      );

      let stateQueryExecutions = 0;
      const originalPrepare = Database.prototype.prepare;
      const prepareSpy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
        this: Database.Database,
        source: string,
      ) {
        const statement = originalPrepare.call(this, source);
        const normalized = source.replace(/\s+/g, " ").trim();
        const isStateQuery =
          normalized.startsWith("SELECT content_hash FROM session_documents") ||
          normalized.startsWith("SELECT COUNT(*) AS value FROM messages") ||
          normalized.startsWith("WITH requested_session_ids");
        if (!isStateQuery) {
          return statement;
        }

        const originalGet = statement.get.bind(statement);
        statement.get = (...params: unknown[]) => {
          stateQueryExecutions += 1;
          return (originalGet as (...boundParams: unknown[]) => unknown)(...params);
        };
        const originalAll = statement.all.bind(statement);
        statement.all = (...params: unknown[]) => {
          stateQueryExecutions += 1;
          return (originalAll as (...boundParams: unknown[]) => unknown[])(...params);
        };
        return statement;
      });

      const batchExecutions: number[] = [];
      try {
        for (const changeCount of [10, 100, multiBatchSessionCount]) {
          const executionsBeforeSync = stateQueryExecutions;
          const result = syncSessionSearchIndexChanges(
            "claudecode",
            sessions.slice(0, changeCount).map((session, sortIndex) => ({ session, sortIndex })),
            [],
            () => {
              throw new Error("unchanged sessions must not be loaded");
            },
          );
          expect(result?.changed).toBe(0);
          batchExecutions.push(stateQueryExecutions - executionsBeforeSync);
        }
      } finally {
        prepareSpy.mockRestore();
      }

      expect(batchExecutions).toEqual([1, 1, 2]);
    },
    SEARCH_INDEX_BATCH_TEST_TIMEOUT_MS,
  );

  it("preserves incremental state defaults and duplicate change semantics", () => {
    const missingDocument = makeSession("missing-document");
    const missingMessages = makeSession("missing-messages");
    const zeroMessages = {
      ...makeSession("zero-messages"),
      stats: { ...makeSession("zero-messages").stats, message_count: 0 },
    };
    const sessions = [missingDocument, missingMessages, zeroMessages];
    const sessionMap = new Map(sessions.map((session) => [session.id, session]));

    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (sessionId) => ({
      ...sessionMap.get(sessionId)!,
      messages: sessionId === zeroMessages.id ? [] : makeSessionData(sessionId, sessionId).messages,
    }));

    const db = new Database(getCachePath());
    try {
      db.prepare("DELETE FROM session_documents WHERE agent_name = ? AND session_id = ?").run(
        "claudecode",
        missingDocument.id,
      );
      db.prepare("DELETE FROM messages WHERE agent_name = ? AND session_id = ?").run(
        "claudecode",
        missingMessages.id,
      );
    } finally {
      db.close();
    }

    const loadSession = vi.fn((sessionId: string) =>
      makeSessionData(sessionId, `reindexed ${sessionId}`),
    );
    const result = syncSessionSearchIndexChanges(
      "claudecode",
      [
        { session: missingDocument, sortIndex: 0 },
        { session: missingMessages, sortIndex: 1 },
        { session: missingMessages, sortIndex: 1 },
        { session: zeroMessages, sortIndex: 2 },
      ],
      [],
      loadSession,
    );

    expect(result).toMatchObject({
      sessions: 4,
      changed: 3,
      indexed: 3,
      skipped: 0,
    });
    expect(loadSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      missingDocument.id,
      missingMessages.id,
      missingMessages.id,
    ]);
  });

  it("restores missing FTS triggers before incremental sync", () => {
    const session = makeSession("trigger");
    const updated = {
      ...session,
      title: "Updated trigger",
      stats: { ...session.stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "old trigger content"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec(`
        DROP TRIGGER session_documents_ai;
        DROP TRIGGER session_documents_ad;
        DROP TRIGGER session_documents_au;
      `);
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    saveCachedSessions("claudecode", [updated]);
    syncSessionSearchIndex("claudecode", [updated], () => ({
      ...updated,
      messages: [
        {
          id: "trigger-m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "old trigger content" }],
        },
        {
          id: "trigger-m2",
          role: "assistant",
          time_created: now + 1,
          parts: [{ type: "text", text: "healed trigger content" }],
        },
      ],
    }));

    const triggerDb = new Database(getCachePath(), { readonly: true });
    try {
      const row = triggerDb
        .prepare(
          "SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'session_documents_%'",
        )
        .get() as { value?: number };
      expect(row.value).toBe(3);
    } finally {
      triggerDb.close();
    }

    expect(searchSessions("healed")).toHaveLength(1);
  });

  it("upserts normalized message rows for indexed sessions", () => {
    const session = {
      ...makeSession("s1"),
      stats: { ...makeSession("s1").stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "first message" }],
        },
        {
          id: "m2",
          role: "assistant",
          time_created: now + 1,
          parts: [
            {
              type: "tool",
              tool: "grep",
              title: "Search",
              state: { status: "completed", output: "result" },
            },
          ],
        },
      ],
    }));

    syncSessionSearchIndex(
      "claudecode",
      [{ ...session, stats: { ...session.stats, message_count: 1 } }],
      () => ({
        ...session,
        stats: { ...session.stats, message_count: 1 },
        messages: [
          {
            id: "m1-updated",
            role: "user",
            time_created: now,
            parts: [{ type: "text", text: "updated sqlite message" }],
          },
        ],
      }),
    );

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT message_id, role, content_text, tool_metadata_json, parts_format_version FROM messages ORDER BY message_index",
        )
        .all() as Array<{
        message_id?: string;
        role?: string;
        content_text?: string;
        tool_metadata_json?: string | null;
        parts_format_version?: number;
      }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.message_id).toBe("m1-updated");
      expect(rows[0]?.role).toBe("user");
      expect(rows[0]?.content_text).toContain("updated sqlite message");
      expect(rows[0]?.parts_format_version).toBe(MESSAGE_PARTS_FORMAT_VERSION);
    } finally {
      db.close();
    }

    expect(searchSessions("updated")).toHaveLength(1);
  });

  it("uses the structured tool index for tool filters", () => {
    const target = {
      ...makeSession("tool-target"),
      stats: { ...makeSession("tool-target").stats, message_count: 1 },
    };
    const other = {
      ...makeSession("tool-other"),
      stats: { ...makeSession("tool-other").stats, message_count: 1 },
    };

    saveCachedSessions("claudecode", [target, other]);
    syncSessionSearchIndex("claudecode", [target, other], (sessionId) => ({
      ...(sessionId === target.id ? target : other),
      messages: [
        {
          id: `${sessionId}-tool`,
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: sessionId === target.id ? "apply_patch" : "grep",
              state: { status: "completed" },
            },
          ],
        },
      ],
    }));

    expect(searchSessions("tool:apply_patch").map((result) => result.session.id)).toEqual([
      "tool-target",
    ]);

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const rows = db
        .prepare("SELECT session_id, tool_name FROM message_tools ORDER BY session_id, tool_name")
        .all();
      expect(rows).toEqual([
        { session_id: "tool-other", tool_name: "grep" },
        { session_id: "tool-target", tool_name: "apply_patch" },
      ]);

      const plan = db
        .prepare(
          `
            EXPLAIN QUERY PLAN
            SELECT s.session_id
            FROM sessions s
            WHERE EXISTS (
              SELECT 1
              FROM message_tools mt
              WHERE mt.tool_name = ?
                AND mt.agent_name = s.agent_name
                AND mt.session_id = s.session_id
            )
          `,
        )
        .all("apply_patch")
        .map((row) => String((row as { detail?: unknown }).detail ?? ""))
        .join("\n");
      expect(plan).toContain("idx_message_tools_filter");
    } finally {
      db.close();
    }
  });

  it("indexes file activity from tool calls", () => {
    const session = {
      ...makeSession("files"),
      project_identity: {
        kind: "git_remote" as const,
        key: "github.com/acme/app",
        displayName: "app",
      },
      stats: { ...makeSession("files").stats, message_count: 2 },
    };

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: "Read",
              time_created: now,
              state: { status: "completed", input: { file_path: "src/App.tsx" } },
            },
            {
              type: "tool",
              tool: "write_file",
              time_created: now + 5,
              state: { status: "completed", input: { path: "src/direct.ts" } },
            },
            {
              type: "tool",
              tool: "patch",
              time_created: now + 10,
              state: {
                status: "completed",
                input: {
                  content: [
                    { type: "edit_file", path: "src/App.tsx" },
                    { type: "write_file", path: "src/new.ts" },
                    { type: "delete_file", path: "src/old.ts" },
                  ],
                },
              },
            },
          ],
        },
      ],
    }));

    expect(
      listFileActivity({
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        path: "src/App",
        limit: 10,
      }).map(({ kind, path, count }) => ({ kind, path, count })),
    ).toEqual([
      { kind: "edit", path: "src/App.tsx", count: 1 },
      { kind: "read", path: "src/App.tsx", count: 1 },
    ]);

    expect(
      listFileActivity({
        agent: "claudecode",
        sessionId: "files",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        projectScope: {
          identity: { kind: "path", key: FIXTURE_DIR },
          path: FIXTURE_DIR,
        },
        path: "src/App",
        kind: "edit",
        from: now + 9,
        to: now + 11,
        limit: 10,
      }).map(({ kind, path, count }) => ({ kind, path, count })),
    ).toEqual([{ kind: "edit", path: "src/App.tsx", count: 1 }]);

    const searchResults = searchFileActivitySessions("src/new.ts");
    expect(searchResults).toHaveLength(1);
    expect(searchResults[0]?.session.id).toBe("files");
    expect(highlightedText(searchResults[0])).toContain("src/new.ts");

    const directWriteResults = searchFileActivitySessions("src/direct.ts");
    expect(directWriteResults).toHaveLength(1);
    expect(directWriteResults[0]?.snippet).toContain("write");
  });

  it("CS-134: applies the search limit to sessions, not activity rows", () => {
    const sessions = [
      { id: "dense", paths: 6, time: now + 100 },
      { id: "sparse", paths: 1, time: now },
    ].map(({ id, paths, time }) => {
      const session = { ...makeSession(id), time_updated: time };
      const activityParts = Array.from({ length: paths }, (_, index) => ({
        type: "tool" as const,
        tool: "Read",
        time_created: time + index,
        state: {
          status: "completed" as const,
          input: { file_path: `src/shared/module-${id}-${index}.ts` },
        },
      }));
      return { session, activityParts };
    });

    saveCachedSessions(
      "claudecode",
      sessions.map(({ session }) => session),
    );
    syncSessionSearchIndex(
      "claudecode",
      sessions.map(({ session }) => session),
      (sessionId) => {
        const entry = sessions.find(({ session }) => session.id === sessionId)!;
        return {
          ...entry.session,
          messages: [
            {
              id: "m1",
              role: "assistant",
              time_created: entry.session.time_updated!,
              parts: entry.activityParts,
            },
          ],
        } as SessionDetail;
      },
    );

    // The denser session owns the six most recent matching rows; a row-level
    // limit would spend the whole budget there and never reach "sparse".
    const results = searchFileActivitySessions("src/shared/module", { limit: 2 });

    expect(results.map((result) => result.session.id)).toEqual(["dense", "sparse"]);
  });

  it("CS-134: keeps same-id sessions from different agents apart", () => {
    for (const agent of ["claudecode", "codex"]) {
      const session = { ...makeSession("shared-id"), slug: `${agent}/shared-id` };
      saveCachedSessions(agent, [session]);
      syncSessionSearchIndex(
        agent,
        [session],
        () =>
          ({
            ...session,
            messages: [
              {
                id: "m1",
                role: "assistant",
                time_created: now,
                parts: [
                  {
                    type: "tool" as const,
                    tool: "Read",
                    time_created: now,
                    state: {
                      status: "completed" as const,
                      input: { file_path: "src/cross/agent.ts" },
                    },
                  },
                ],
              },
            ],
          }) as SessionDetail,
      );
    }

    const results = searchFileActivitySessions("src/cross/agent.ts", { limit: 10 });

    expect(results.map((result) => result.reference.agentName).sort()).toEqual([
      "claudecode",
      "codex",
    ]);
  });

  it("CS-134: picks the top-ranked row for the snippet on a tie", () => {
    const session = makeSession("tied");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex(
      "claudecode",
      [session],
      () =>
        ({
          ...session,
          messages: [
            {
              id: "m1",
              role: "assistant",
              time_created: now,
              parts: ["b.ts", "a.ts", "c.ts"].map((name) => ({
                type: "tool" as const,
                tool: "Read",
                time_created: now,
                state: { status: "completed" as const, input: { file_path: `src/tie/${name}` } },
              })),
            },
          ],
        }) as SessionDetail,
    );

    const results = searchFileActivitySessions("src/tie", { limit: 10 });

    expect(results).toHaveLength(1);
    // Equal latest_time and count, so the path breaks the tie.
    expect(results[0]?.snippet).toContain("src/tie/a.ts");
    expect(highlightedText(results[0])).toEqual(["src/tie"]);
  });

  it("uses latest-time indexes for recent file activity query plans", () => {
    saveCachedSessions("claudecode", [makeSession("indexed")]);

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const explain = (where: string, ...params: unknown[]) =>
        (
          db
            .prepare(
              `
                EXPLAIN QUERY PLAN
                SELECT
                  fa.agent_name,
                  fa.session_id,
                  fa.project_identity_key,
                  fa.path,
                  fa.kind,
                  fa.count,
                  fa.latest_time
                FROM session_file_activity fa
                JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
                ${where}
                ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
                LIMIT ?
              `,
            )
            .all(...params, 50) as Array<{ detail?: string }>
        )
          .map((row) => String(row.detail ?? ""))
          .join("\n");

      expect(explain("")).toContain("USING INDEX idx_file_activity_latest");
      expect(explain("WHERE fa.agent_name = ?", "claudecode")).toContain(
        "USING INDEX idx_file_activity_agent_latest",
      );
      expect(explain("WHERE fa.project_identity_key = ?", "/tmp/project")).toContain(
        "USING INDEX idx_file_activity_project_latest_ordered",
      );
      const pathPlan = explain(
        "WHERE fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)",
        '"src/App"',
      );
      expect(pathPlan).toContain("session_file_activity_path_fts");
      expect(pathPlan).not.toContain("SCAN fa\n");

      // CS-134: ranking one row per session stays a single pass over the FTS
      // matches — not a correlated lookup per session.
      const rankedPlan = (
        db
          .prepare(
            `
              EXPLAIN QUERY PLAN
              SELECT fa.agent_name, fa.session_id, fa.path
              FROM (
                SELECT
                  fa.rowid AS activity_rowid,
                  ROW_NUMBER() OVER (
                    PARTITION BY fa.agent_name, fa.session_id
                    ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
                  ) AS session_rank
                FROM session_file_activity fa
                JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
                WHERE fa.rowid IN (SELECT rowid FROM session_file_activity_path_fts WHERE path MATCH ?)
              ) ranked
              JOIN session_file_activity fa ON fa.rowid = ranked.activity_rowid
              JOIN sessions s ON s.agent_name = fa.agent_name AND s.session_id = fa.session_id
              WHERE ranked.session_rank = 1
              ORDER BY fa.latest_time DESC, fa.count DESC, fa.path
              LIMIT ?
            `,
          )
          .all('"src/App"', 50) as Array<{ detail?: string }>
      )
        .map((row) => String(row.detail ?? ""))
        .join("\n");

      expect(rankedPlan).toContain("session_file_activity_path_fts");
      expect(rankedPlan).not.toContain("CORRELATED");
      expect(rankedPlan).not.toContain("SCAN fa\n");
    } finally {
      db.close();
    }
  });

  it("rebuilds path search index when migrating existing file activity rows", () => {
    const session = makeSession("path-migration");

    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "path-migration-tool",
          role: "assistant",
          time_created: now,
          parts: [
            {
              type: "tool",
              tool: "Read",
              state: {
                status: "completed",
                input: { file_path: "src/migrated/App.tsx" },
              },
            },
          ],
        },
      ],
    }));

    const db = new Database(getCachePath());
    try {
      db.exec(`
        DROP TRIGGER IF EXISTS session_file_activity_path_ai;
        DROP TRIGGER IF EXISTS session_file_activity_path_ad;
        DROP TRIGGER IF EXISTS session_file_activity_path_au;
        DROP TABLE IF EXISTS session_file_activity_path_fts;
        PRAGMA user_version = 9;
      `);
      db.prepare("UPDATE cache_meta SET value = '9' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    expect(listFileActivity({ path: "migrated/App", limit: 10 }).map((item) => item.path)).toEqual([
      "src/migrated/App.tsx",
    ]);
    expect(getUserVersion(getCachePath())).toBe(29);
  });

  it("refreshes cached project identities when migrating to schema version 12", () => {
    const directory = join(testHomeDir, "Documents", "Codex", "2026-05-22", "new-chat");
    saveCachedSessions("codex", [{ ...makeSession("codex-scratch"), directory }]);

    const db = new Database(getCachePath());
    try {
      db.prepare(
        `
          UPDATE sessions
          SET project_identity_kind = 'path',
              project_identity_key = ?,
              project_display_name = 'new-chat'
        `,
      ).run(directory);
      db.prepare(
        `
          UPDATE project_sessions
          SET identity_kind = 'path',
              identity_key = ?,
              display_name = 'new-chat'
        `,
      ).run(directory);
      db.pragma("user_version = 11");
      db.prepare("UPDATE cache_meta SET value = '11' WHERE key = 'version'").run();
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    // loadCachedSessions opens the writable connection, so it's what actually
    // runs the pending migration; listCachedProjectGroups now reads through
    // the read-only connection and must not trigger migrations itself.
    expect(loadCachedSessions("codex")?.sessions[0]?.project_identity).toEqual({
      kind: "synthetic",
      key: "codex:scratch",
      displayName: "Chats",
    });
    expect(listCachedProjectGroups()).toEqual([
      {
        identityKind: "synthetic",
        identityKey: "codex:scratch",
        displayName: "Chats",
        sources: ["codex"],
        sessionCount: 1,
        lastActivity: now,
      },
    ]);
  });

  it("combines full text with structured filters", () => {
    const codex = {
      ...makeSession("structured"),
      slug: "codex/structured",
      title: "Structured Retrieval",
      directory: "/tmp/codesesh",
      project_identity: {
        kind: "path" as const,
        key: "/tmp/codesesh",
        displayName: "codesesh",
      },
      smart_tags: ["feature-dev" as const],
      smart_tags_source_updated_at: now,
      stats: {
        message_count: 2,
        total_input_tokens: 1,
        total_output_tokens: 1,
        total_cost: 2,
      },
    };
    const other = {
      ...makeSession("other"),
      slug: "cursor/other",
      directory: "/tmp/other",
      smart_tags: ["docs" as const],
    };

    saveCachedSessions("codex", [codex]);
    saveCachedSessions("cursor", [other]);
    syncSessionSearchIndex("codex", [codex], () => ({
      ...codex,
      messages: [
        {
          id: "structured-user",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "needle structured search" }],
        },
        {
          id: "structured-tool",
          role: "assistant",
          time_created: now + 1,
          mode: "tool",
          parts: [
            {
              type: "tool",
              tool: "apply_patch",
              state: { status: "completed", input: { path: "src/App.tsx" } },
            },
          ],
        },
      ],
    }));
    syncSessionSearchIndex("cursor", [other], () => makeSessionData("other", "needle other"));

    const results = searchSessions(
      "needle agent:codex project:codesesh tag:feature-dev tool:apply_patch file:App.tsx cost:>1",
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("structured");
    expect(results[0]?.matchType).toBe("user_message");
    expect(results[0]?.session.smart_tags).toEqual(["feature-dev"]);
  });

  it("returns recent sessions for structured-only queries", () => {
    const recent = {
      ...makeSession("recent"),
      slug: "codex/recent",
      time_updated: now + 10,
      smart_tags: ["testing" as const],
    };
    const old = {
      ...makeSession("old"),
      slug: "codex/old",
      time_updated: now - 10,
      smart_tags: ["docs" as const],
    };

    saveCachedSessions("codex", [old, recent]);
    syncSessionSearchIndex("codex", [old, recent], (sessionId) =>
      makeSessionData(sessionId, "indexed content"),
    );

    const results = searchSessions("agent:codex tag:testing");

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("recent");
    expect(results[0]?.matchType).toBe("recent");
  });

  it("preserves omitted durable facts in a partial publication", () => {
    const old = makeSession("old");
    const recent = makeSession("recent");
    const removed = makeSession("removed");
    const sessions = [old, recent, removed];
    const meta = Object.fromEntries(
      sessions.map((session) => [
        session.id,
        { id: session.id, sourcePath: `/${session.id}.jsonl` },
      ]),
    );
    saveCachedSessions("codex", sessions, meta);
    syncSessionSearchIndex("codex", sessions, (sessionId) => {
      const session = sessions.find(({ id }) => id === sessionId)!;
      const text =
        sessionId === "old"
          ? "historicalscope"
          : sessionId === "removed"
            ? "deletedscope"
            : "recentscope";
      return {
        ...session,
        messages: [
          {
            id: `${sessionId}-message`,
            role: "user",
            time_created: now,
            parts: [
              { type: "text", text },
              ...(sessionId === "old"
                ? [
                    {
                      type: "tool" as const,
                      tool: "Read",
                      state: {
                        status: "completed" as const,
                        input: { file_path: "src/historical.ts" },
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      };
    });

    const updatedRecent = { ...recent, title: "Recent updated" };
    saveCachedSessions(
      "codex",
      [updatedRecent],
      { recent: meta.recent! },
      { completeness: "partial", removedSessionIds: [removed.id] },
    );
    syncSessionSearchIndex(
      "codex",
      [updatedRecent],
      () => makeSessionData("recent", "recentscope updated"),
      { completeness: "partial", removedSessionIds: [removed.id] },
    );

    expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["old", "recent"]),
    );
    expect(loadCachedSessions("codex")?.sessions.map(({ id }) => id)).not.toContain("removed");
    expect(loadCachedSessions("codex")?.meta.old).toEqual(meta.old);
    expect(loadCachedSessionData("codex", "old")?.messages).toHaveLength(1);
    expect(searchSessions("historicalscope").map(({ session }) => session.id)).toEqual(["old"]);
    expect(searchSessions("deletedscope")).toEqual([]);
    expect(
      listFileActivity({ agent: "codex", sessionId: "old", limit: 10 }).map(({ path }) => path),
    ).toContain("src/historical.ts");
  });

  it("upserts parent session rows before indexed messages", () => {
    const session = {
      ...makeSession("windowed"),
      slug: "claudecode/windowed",
      stats: { ...makeSession("windowed").stats, message_count: 1 },
    };

    saveCachedSessions("cursor", [makeSession("existing")]);
    syncSessionSearchIndex("claudecode", [session], () => ({
      ...session,
      messages: [
        {
          id: "m1",
          role: "user",
          time_created: now,
          parts: [{ type: "text", text: "windowed sqlite index" }],
        },
      ],
    }));

    const results = searchSessions("windowed");
    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("windowed");

    const db = new Database(getCachePath(), { readonly: true });
    try {
      const parent = db
        .prepare("SELECT session_id FROM sessions WHERE agent_name = ? AND session_id = ?")
        .get("claudecode", "windowed") as { session_id?: string };
      const child = db
        .prepare("SELECT COUNT(*) AS value FROM messages WHERE agent_name = ? AND session_id = ?")
        .get("claudecode", "windowed") as { value?: number };

      expect(parent.session_id).toBe("windowed");
      expect(child.value).toBe(1);
    } finally {
      db.close();
    }
  });

  it("supports OR queries and agent filters", () => {
    const alpha = makeSession("alpha");
    const beta = makeSession("beta");
    saveCachedSessions("claudecode", [alpha]);
    saveCachedSessions("cursor", [beta]);
    syncSessionSearchIndex("claudecode", [alpha], (sessionId) =>
      makeSessionData(sessionId, "search alpha term"),
    );
    syncSessionSearchIndex("cursor", [beta], (sessionId) =>
      makeSessionData(sessionId, "search beta term"),
    );

    const allResults = searchSessions("alpha OR beta");
    expect(allResults).toHaveLength(2);

    const filteredResults = searchSessions("alpha OR beta", { agent: "cursor" });
    expect(filteredResults).toHaveLength(1);
    expect(filteredResults[0]?.reference.agentName).toBe("cursor");
  });

  it("rebuilds an empty FTS index when content rows exist", () => {
    mkdirSync(getCacheDir(), { recursive: true });
    const db = new Database(getCachePath());
    try {
      createLegacyCacheTables(db);
      db.prepare("INSERT INTO cache_meta(key, value) VALUES ('version', '4')").run();
      db.exec(`
        CREATE TABLE session_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          slug TEXT NOT NULL,
          title TEXT NOT NULL,
          directory TEXT NOT NULL,
          time_created INTEGER NOT NULL,
          time_updated INTEGER,
          activity_time INTEGER NOT NULL,
          content_text TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          indexed_at INTEGER NOT NULL,
          UNIQUE(agent_name, session_id)
        );

        CREATE VIRTUAL TABLE session_documents_fts USING fts5(
          title,
          content_text,
          content='session_documents',
          content_rowid='id'
        );
      `);
      db.prepare(
        `
          INSERT INTO session_documents(
            agent_name,
            session_id,
            slug,
            title,
            directory,
            time_created,
            time_updated,
            activity_time,
            content_text,
            content_hash,
            indexed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        "claudecode",
        "fts-empty",
        "claudecode/fts-empty",
        "FTS Empty",
        FIXTURE_DIR,
        now,
        now,
        now,
        "orphan index content",
        "old",
        now,
      );
    } finally {
      db.close();
    }

    const results = searchSessions("orphan");

    expect(results).toHaveLength(1);
    expect(results[0]?.session.id).toBe("fts-empty");
    expect(highlightedText(results[0])).toContain("orphan");
  });

  it("rebuilds the session FTS index when update triggers are missing", () => {
    const session = makeSession("missing-fts-triggers");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "original indexed content"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec("DROP TRIGGER session_documents_au");
      db.prepare(
        "UPDATE session_documents SET content_text = ? WHERE agent_name = ? AND session_id = ?",
      ).run("documentrepairneedle", "claudecode", session.id);
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    const match = withSearchDb(
      (searchDb) =>
        searchDb
          .prepare(
            "SELECT COUNT(*) AS value FROM session_documents_fts WHERE session_documents_fts MATCH ?",
          )
          .get("documentrepairneedle") as { value: number },
    );

    expect(match?.value).toBe(1);
  });

  it("recreates and rebuilds a missing FTS table", () => {
    const session = makeSession("missing-fts-table");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, "tablerepairneedle"),
    );

    const db = new Database(getCachePath());
    try {
      db.exec("DROP TABLE session_documents_fts");
    } finally {
      db.close();
    }
    setSchemaEnsuredPath(null);

    expect(searchSessions("tablerepairneedle")[0]?.session.id).toBe(session.id);
  });

  it("validates and rebuilds FTS indexes after SQLite reports corruption", () => {
    const session = makeSession("corrupt-fts");
    const content = Array.from({ length: 200 }, (_, index) => `recoverytoken${index}`).join(" ");
    saveCachedSessions("claudecode", [session]);
    syncSessionSearchIndex("claudecode", [session], (sessionId) =>
      makeSessionData(sessionId, content),
    );

    const db = new Database(getCachePath());
    try {
      const row = db
        .prepare(
          "SELECT id, block FROM session_documents_fts_data WHERE id > 10 AND length(block) > 4 LIMIT 1",
        )
        .get() as { id: number; block: Buffer } | undefined;
      if (!row) throw new Error("Expected an FTS segment block");

      const corruptBlock = Buffer.from(row.block);
      const corruptIndex = Math.floor(corruptBlock.length / 2);
      corruptBlock[corruptIndex] = (corruptBlock[corruptIndex] ?? 0) ^ 0xff;
      db.unsafeMode(true);
      db.prepare("UPDATE session_documents_fts_data SET block = ? WHERE id = ?").run(
        corruptBlock,
        row.id,
      );
      db.unsafeMode(false);
    } finally {
      db.close();
    }

    const result = withSearchDb((searchDb) => {
      searchDb.exec(
        "INSERT INTO session_documents_fts(session_documents_fts, rank) VALUES ('integrity-check', 1)",
      );
      return "recovered";
    });

    expect(result).toBe("recovered");
    expect(searchSessions("recoverytoken42")[0]?.session.id).toBe(session.id);
  });
});
