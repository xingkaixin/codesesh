import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { SessionStats } from "../types/index.js";
import { openDb, type DatabaseRow } from "../utils/sqlite.js";

const BOOKMARK_DB_FILENAME = "state.db";
const BOOKMARK_DB_VERSION = 1;

export interface BookmarkRecord {
  agentKey: string;
  sessionId: string;
  fullPath: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated?: number;
  stats: SessionStats;
  bookmarked_at: number;
}

interface BookmarkRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  slug?: string;
  title?: string;
  directory?: string;
  time_created?: number;
  time_updated?: number | null;
  stats_json?: string;
  bookmarked_at?: number;
}

function getStateDir(): string {
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Application Support", "codesesh");
  }
  if (p === "win32") {
    const appData = process.env.APPDATA ?? process.env.LOCALAPPDATA;
    return join(appData ?? join(homedir(), "AppData", "Roaming"), "codesesh");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "codesesh");
}

function getStateDbPath(): string {
  return join(getStateDir(), BOOKMARK_DB_FILENAME);
}

function ensureSchema(db: NonNullable<ReturnType<typeof openDb>>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bookmarks (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER,
      stats_json TEXT NOT NULL,
      bookmarked_at INTEGER NOT NULL,
      PRIMARY KEY (agent_name, session_id)
    );
  `);

  const row = db.prepare("SELECT value FROM state_meta WHERE key = 'version'").get() as
    | DatabaseRow
    | undefined;
  const version = Number(row?.value ?? 0);
  if (version === BOOKMARK_DB_VERSION) return;

  db.prepare(
    `
      INSERT INTO state_meta(key, value)
      VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(String(BOOKMARK_DB_VERSION));
}

function withStateDb<T>(fn: (db: NonNullable<ReturnType<typeof openDb>>) => T): T {
  const db = openDb(getStateDbPath());
  if (!db) {
    throw new Error("SQLite state database is unavailable");
  }

  try {
    ensureSchema(db);
    return fn(db);
  } finally {
    db.close();
  }
}

function toBookmarkRecord(row: BookmarkRow): BookmarkRecord {
  return {
    agentKey: String(row.agent_name ?? ""),
    sessionId: String(row.session_id ?? ""),
    fullPath: String(row.slug ?? ""),
    title: String(row.title ?? ""),
    directory: String(row.directory ?? ""),
    time_created: Number(row.time_created ?? 0),
    time_updated: row.time_updated == null ? undefined : Number(row.time_updated),
    stats: JSON.parse(String(row.stats_json ?? "{}")) as SessionStats,
    bookmarked_at: Number(row.bookmarked_at ?? 0),
  };
}

export function listBookmarks(): BookmarkRecord[] {
  return withStateDb((db) => {
    const rows = db
      .prepare(
        `
          SELECT
            agent_name,
            session_id,
            slug,
            title,
            directory,
            time_created,
            time_updated,
            stats_json,
            bookmarked_at
          FROM bookmarks
          ORDER BY COALESCE(time_updated, time_created) DESC, bookmarked_at DESC
        `,
      )
      .all() as BookmarkRow[];

    return rows.map(toBookmarkRecord);
  });
}

export function upsertBookmark(bookmark: Omit<BookmarkRecord, "bookmarked_at">): BookmarkRecord {
  return withStateDb((db) => {
    const existing = db
      .prepare(
        `
          SELECT bookmarked_at
          FROM bookmarks
          WHERE agent_name = ? AND session_id = ?
        `,
      )
      .get(bookmark.agentKey, bookmark.sessionId) as DatabaseRow | undefined;
    const bookmarkedAt = Number(existing?.bookmarked_at ?? Date.now());

    db.prepare(
      `
        INSERT INTO bookmarks(
          agent_name,
          session_id,
          slug,
          title,
          directory,
          time_created,
          time_updated,
          stats_json,
          bookmarked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_name, session_id) DO UPDATE SET
          slug = excluded.slug,
          title = excluded.title,
          directory = excluded.directory,
          time_created = excluded.time_created,
          time_updated = excluded.time_updated,
          stats_json = excluded.stats_json
      `,
    ).run(
      bookmark.agentKey,
      bookmark.sessionId,
      bookmark.fullPath,
      bookmark.title,
      bookmark.directory,
      bookmark.time_created,
      bookmark.time_updated ?? null,
      JSON.stringify(bookmark.stats),
      bookmarkedAt,
    );

    return { ...bookmark, bookmarked_at: bookmarkedAt };
  });
}

export function importBookmarks(
  bookmarks: Omit<BookmarkRecord, "bookmarked_at">[],
): BookmarkRecord[] {
  return withStateDb((db) => {
    const existingRows = db
      .prepare("SELECT agent_name, session_id, bookmarked_at FROM bookmarks")
      .all() as DatabaseRow[];
    const existingTimes = new Map(
      existingRows.map((row) => [
        `${String(row.agent_name ?? "")}:${String(row.session_id ?? "")}`,
        Number(row.bookmarked_at ?? 0),
      ]),
    );

    const upsert = db.prepare(
      `
        INSERT INTO bookmarks(
          agent_name,
          session_id,
          slug,
          title,
          directory,
          time_created,
          time_updated,
          stats_json,
          bookmarked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_name, session_id) DO UPDATE SET
          slug = excluded.slug,
          title = excluded.title,
          directory = excluded.directory,
          time_created = excluded.time_created,
          time_updated = excluded.time_updated,
          stats_json = excluded.stats_json
      `,
    );

    const write = db.transaction(() => {
      for (const bookmark of bookmarks) {
        const key = `${bookmark.agentKey}:${bookmark.sessionId}`;
        upsert.run(
          bookmark.agentKey,
          bookmark.sessionId,
          bookmark.fullPath,
          bookmark.title,
          bookmark.directory,
          bookmark.time_created,
          bookmark.time_updated ?? null,
          JSON.stringify(bookmark.stats),
          existingTimes.get(key) ?? Date.now(),
        );
      }
    });

    write();
    const rows = db
      .prepare(
        `
          SELECT
            agent_name,
            session_id,
            slug,
            title,
            directory,
            time_created,
            time_updated,
            stats_json,
            bookmarked_at
          FROM bookmarks
          ORDER BY COALESCE(time_updated, time_created) DESC, bookmarked_at DESC
        `,
      )
      .all() as BookmarkRow[];
    return rows.map(toBookmarkRecord);
  });
}

export function deleteBookmark(agentKey: string, sessionId: string): void {
  withStateDb((db) => {
    db.prepare(
      `
        DELETE FROM bookmarks
        WHERE agent_name = ? AND session_id = ?
      `,
    ).run(agentKey, sessionId);
  });
}
