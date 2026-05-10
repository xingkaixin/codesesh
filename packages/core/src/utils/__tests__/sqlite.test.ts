import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backupDatabaseIfPopulated, type SQLiteDatabase } from "../sqlite.js";

describe("sqlite migration helpers", () => {
  it("skips backups for in-memory databases", () => {
    const db = new Database(":memory:") as unknown as SQLiteDatabase;
    try {
      db.exec(`
        CREATE TABLE rows (
          id INTEGER PRIMARY KEY
        );
        INSERT INTO rows(id) VALUES (1);
      `);

      expect(backupDatabaseIfPopulated(db, ":memory:", "migration", ["rows"])).toBeNull();
    } finally {
      db.close();
    }
  });
});
