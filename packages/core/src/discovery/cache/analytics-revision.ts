import type { SQLiteDatabase } from "../../utils/sqlite.js";
import { hasCacheStorage } from "./db.js";
import { withCacheDbReadOnly } from "./connection.js";

const ANALYTICS_REVISION_KEY = "analytics_revision";

interface AnalyticsRevisionRow {
  value?: string | number;
}

export function readAnalyticsRevision(db: SQLiteDatabase): string {
  const row = db
    .prepare("SELECT value FROM cache_meta WHERE key = ?")
    .get(ANALYTICS_REVISION_KEY) as AnalyticsRevisionRow | undefined;
  return String(row?.value ?? "0");
}

export function advanceAnalyticsRevision(db: SQLiteDatabase): void {
  db.prepare(
    `
      INSERT INTO cache_meta(key, value)
      VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
    `,
  ).run(ANALYTICS_REVISION_KEY);
}

export function getAnalyticsRevision(): string | null {
  if (!hasCacheStorage()) return null;

  const read = withCacheDbReadOnly((db) => readAnalyticsRevision(db));
  return read.status === "success" ? read.value : null;
}
