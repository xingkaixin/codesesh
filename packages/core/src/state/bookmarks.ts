import {
  normalizeSessionReference,
  type BookmarkRecord,
  type SessionReference,
} from "../contract/index.js";
import { StateStorageUnavailableError, useMemoryStateStore, withStateDb } from "./database.js";
import type { DatabaseRow, SQLiteDatabase } from "../utils/sqlite.js";

const memoryBookmarks = new Map<string, BookmarkRecord>();

export { StateStorageUnavailableError as BookmarkStorageUnavailableError };

export type { BookmarkRecord };

interface BookmarkRow extends DatabaseRow {
  agent_name?: string;
  session_id?: string;
  bookmarked_at?: number;
}

function getBookmarkKey(reference: SessionReference): string {
  const normalized = normalizeSessionReference(reference);
  return JSON.stringify([normalized.agentName, normalized.sessionId]);
}

function compareBookmarks(left: BookmarkRecord, right: BookmarkRecord): number {
  if (left.bookmarkedAt !== right.bookmarkedAt) {
    return left.bookmarkedAt > right.bookmarkedAt ? -1 : 1;
  }
  return getBookmarkKey(left.reference).localeCompare(getBookmarkKey(right.reference));
}

function normalizeBookmark(bookmark: BookmarkRecord): BookmarkRecord {
  return {
    reference: normalizeSessionReference(bookmark.reference),
    bookmarkedAt: bookmark.bookmarkedAt,
  };
}

function toBookmarkRecord(row: BookmarkRow): BookmarkRecord {
  return {
    reference: normalizeSessionReference({
      agentName: String(row.agent_name ?? ""),
      sessionId: String(row.session_id ?? ""),
    }),
    bookmarkedAt: Number(row.bookmarked_at ?? 0),
  };
}

function readBookmarks(db: SQLiteDatabase): BookmarkRecord[] {
  const rows = db
    .prepare(
      `
        SELECT agent_name, session_id, bookmarked_at
        FROM bookmarks
        ORDER BY bookmarked_at DESC, agent_name ASC, session_id ASC
      `,
    )
    .all() as BookmarkRow[];
  return rows.map(toBookmarkRecord);
}

function listMemoryBookmarks(): BookmarkRecord[] {
  return [...memoryBookmarks.values()].sort(compareBookmarks);
}

export function listBookmarks(): BookmarkRecord[] {
  if (useMemoryStateStore()) return listMemoryBookmarks();
  return withStateDb(readBookmarks);
}

export function upsertBookmark(reference: SessionReference): BookmarkRecord {
  const normalized = normalizeSessionReference(reference);
  const key = getBookmarkKey(normalized);
  if (useMemoryStateStore()) {
    const bookmark = memoryBookmarks.get(key) ?? {
      reference: normalized,
      bookmarkedAt: Date.now(),
    };
    memoryBookmarks.set(key, bookmark);
    return bookmark;
  }

  return withStateDb((db) => {
    db.prepare(
      `
        INSERT INTO bookmarks(agent_name, session_id, bookmarked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_name, session_id) DO NOTHING
      `,
    ).run(normalized.agentName, normalized.sessionId, Date.now());
    const row = db
      .prepare(
        `
          SELECT agent_name, session_id, bookmarked_at
          FROM bookmarks
          WHERE agent_name = ? AND session_id = ?
        `,
      )
      .get(normalized.agentName, normalized.sessionId) as BookmarkRow;
    return toBookmarkRecord(row);
  });
}

export function importBookmarks(bookmarks: readonly BookmarkRecord[]): BookmarkRecord[] {
  const unique = new Map<string, BookmarkRecord>();
  for (const bookmark of bookmarks) {
    const normalized = normalizeBookmark(bookmark);
    const key = getBookmarkKey(normalized.reference);
    if (!unique.has(key)) unique.set(key, normalized);
  }

  if (useMemoryStateStore()) {
    for (const [key, bookmark] of unique) {
      if (!memoryBookmarks.has(key)) memoryBookmarks.set(key, bookmark);
    }
    return listMemoryBookmarks();
  }

  return withStateDb((db) => {
    const insert = db.prepare(
      `
        INSERT INTO bookmarks(agent_name, session_id, bookmarked_at)
        VALUES (?, ?, ?)
        ON CONFLICT(agent_name, session_id) DO NOTHING
      `,
    );
    const write = db.transaction(() => {
      for (const bookmark of unique.values()) {
        insert.run(
          bookmark.reference.agentName,
          bookmark.reference.sessionId,
          bookmark.bookmarkedAt,
        );
      }
    });
    write.immediate();
    return readBookmarks(db);
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
