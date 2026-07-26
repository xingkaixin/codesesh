import type { SessionStats } from "../types/index.js";
import {
  formatSessionReference,
  normalizeSessionReference,
  type BookmarkRecord,
  type SessionReference,
} from "../contract/index.js";
import { StateStorageUnavailableError, useMemoryStateStore, withStateDb } from "./database.js";
import type { DatabaseRow } from "../utils/sqlite.js";

const memoryBookmarks = new Map<string, BookmarkRecord>();

export { StateStorageUnavailableError as BookmarkStorageUnavailableError };

export type { BookmarkRecord };

interface BookmarkRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  title?: string;
  directory?: string;
  time_created?: number;
  time_updated?: number | null;
  stats_json?: string;
  bookmarked_at?: number;
}

function getBookmarkKey(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return JSON.stringify([normalized.agentName, normalized.sessionId]);
}

function getActivityTime(bookmark: BookmarkRecord): number {
  return bookmark.session.time_updated ?? bookmark.session.time_created;
}

function sortBookmarks(bookmarks: BookmarkRecord[]): BookmarkRecord[] {
  return bookmarks.sort((a, b) => {
    const activityDelta = getActivityTime(b) - getActivityTime(a);
    return activityDelta || b.bookmarkedAt - a.bookmarkedAt;
  });
}

function listMemoryBookmarks(): BookmarkRecord[] {
  return sortBookmarks(Array.from(memoryBookmarks.values()));
}

function normalizeBookmark(
  bookmark: Omit<BookmarkRecord, "bookmarkedAt">,
): Omit<BookmarkRecord, "bookmarkedAt"> {
  const reference = normalizeSessionReference(bookmark.reference);
  return {
    reference,
    session: {
      ...bookmark.session,
      id: reference.sessionId,
      slug: formatSessionReference(reference),
    },
  };
}

function upsertMemoryBookmark(bookmark: Omit<BookmarkRecord, "bookmarkedAt">): BookmarkRecord {
  const key = getBookmarkKey(bookmark.reference);
  const saved = {
    ...bookmark,
    bookmarkedAt: memoryBookmarks.get(key)?.bookmarkedAt ?? Date.now(),
  };
  memoryBookmarks.set(key, saved);
  return saved;
}

function toBookmarkRecord(row: BookmarkRow): BookmarkRecord {
  const reference = normalizeSessionReference({
    agentName: String(row.agent_name ?? ""),
    sessionId: String(row.session_id ?? ""),
  });
  return {
    reference,
    session: {
      id: reference.sessionId,
      slug: formatSessionReference(reference),
      title: String(row.title ?? ""),
      directory: String(row.directory ?? ""),
      time_created: Number(row.time_created ?? 0),
      time_updated: row.time_updated == null ? undefined : Number(row.time_updated),
      stats: JSON.parse(String(row.stats_json ?? "{}")) as SessionStats,
    },
    bookmarkedAt: Number(row.bookmarked_at ?? 0),
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

export function upsertBookmark(bookmark: Omit<BookmarkRecord, "bookmarkedAt">): BookmarkRecord {
  const normalized = normalizeBookmark(bookmark);
  if (useMemoryStateStore()) {
    return upsertMemoryBookmark(normalized);
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
      .get(normalized.reference.agentName, normalized.reference.sessionId) as
      | DatabaseRow
      | undefined;
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
      normalized.reference.agentName,
      normalized.reference.sessionId,
      formatSessionReference(normalized.reference),
      normalized.session.title,
      normalized.session.directory,
      normalized.session.time_created,
      normalized.session.time_updated ?? null,
      JSON.stringify(normalized.session.stats),
      bookmarkedAt,
    );

    return { ...normalized, bookmarkedAt };
  });
}

export function importBookmarks(
  bookmarks: Omit<BookmarkRecord, "bookmarkedAt">[],
): BookmarkRecord[] {
  const normalizedBookmarks = bookmarks.map(normalizeBookmark);
  if (useMemoryStateStore()) {
    for (const bookmark of normalizedBookmarks) {
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
        getBookmarkKey({
          agentName: String(row.agent_name ?? ""),
          sessionId: String(row.session_id ?? ""),
        }),
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
      for (const bookmark of normalizedBookmarks) {
        const key = getBookmarkKey(bookmark.reference);
        upsert.run(
          bookmark.reference.agentName,
          bookmark.reference.sessionId,
          formatSessionReference(bookmark.reference),
          bookmark.session.title,
          bookmark.session.directory,
          bookmark.session.time_created,
          bookmark.session.time_updated ?? null,
          JSON.stringify(bookmark.session.stats),
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

export function deleteBookmark(reference: SessionReference): void {
  const normalized = normalizeSessionReference(reference);
  if (useMemoryStateStore()) {
    memoryBookmarks.delete(getBookmarkKey(normalized));
    return;
  }

  withStateDb((db) => {
    db.prepare(
      `
        DELETE FROM bookmarks
        WHERE agent_name = ? AND session_id = ?
      `,
    ).run(normalized.agentName, normalized.sessionId);
  });
}
