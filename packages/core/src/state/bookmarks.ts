import type { SessionStats } from "../types/index.js";
import type { BookmarkRecord } from "../contract/index.js";
import { StateStorageUnavailableError, useMemoryStateStore, withStateDb } from "./database.js";
import type { DatabaseRow } from "../utils/sqlite.js";

const memoryBookmarks = new Map<string, BookmarkRecord>();

export { StateStorageUnavailableError as BookmarkStorageUnavailableError };

export type { BookmarkRecord };

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

function getBookmarkKey(agentKey: string, sessionId: string): string {
  return JSON.stringify([agentKey, sessionId]);
}

function getActivityTime(bookmark: BookmarkRecord): number {
  return bookmark.time_updated ?? bookmark.time_created;
}

function sortBookmarks(bookmarks: BookmarkRecord[]): BookmarkRecord[] {
  return bookmarks.sort((a, b) => {
    const activityDelta = getActivityTime(b) - getActivityTime(a);
    return activityDelta || b.bookmarked_at - a.bookmarked_at;
  });
}

function listMemoryBookmarks(): BookmarkRecord[] {
  return sortBookmarks(Array.from(memoryBookmarks.values()));
}

function upsertMemoryBookmark(bookmark: Omit<BookmarkRecord, "bookmarked_at">): BookmarkRecord {
  const key = getBookmarkKey(bookmark.agentKey, bookmark.sessionId);
  const saved = {
    ...bookmark,
    bookmarked_at: memoryBookmarks.get(key)?.bookmarked_at ?? Date.now(),
  };
  memoryBookmarks.set(key, saved);
  return saved;
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
  if (useMemoryStateStore()) {
    return listMemoryBookmarks();
  }

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
  if (useMemoryStateStore()) {
    return upsertMemoryBookmark(bookmark);
  }

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
  if (useMemoryStateStore()) {
    for (const bookmark of bookmarks) {
      upsertMemoryBookmark(bookmark);
    }
    return listMemoryBookmarks();
  }

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
  if (useMemoryStateStore()) {
    memoryBookmarks.delete(getBookmarkKey(agentKey, sessionId));
    return;
  }

  withStateDb((db) => {
    db.prepare(
      `
        DELETE FROM bookmarks
        WHERE agent_name = ? AND session_id = ?
      `,
    ).run(agentKey, sessionId);
  });
}
