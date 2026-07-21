import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDatabaseIfPopulated,
  openDb,
  openDbReadOnly,
  type SQLiteDatabase,
} from "../sqlite.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

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

describe("sqlite open failures", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setCoreDiagnostics(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function collectDiagnostics(): Array<{ event: string; detail?: Record<string, unknown> }> {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const diagnostics: CoreDiagnostics = {
      warn: (event, detail) => events.push({ event, detail }),
    };
    setCoreDiagnostics(diagnostics);
    return events;
  }

  it("reports sqlite.open_failed when the write path can't be created", () => {
    // A file can't be used as a directory segment, so mkdirSync(dirname(dbPath))
    // fails and openDb hits its catch branch instead of opening a handle.
    const dir = mkdtempSync(join(tmpdir(), "codesesh-sqlite-open-test-"));
    tempDirs.push(dir);
    const blockerFile = join(dir, "blocker");
    writeFileSync(blockerFile, "not a directory");
    const dbPath = join(blockerFile, "sub", "cache.db");

    const events = collectDiagnostics();
    expect(openDb(dbPath)).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("sqlite.open_failed");
    expect(events[0]?.detail?.dbPath).toBe(dbPath);
    expect(events[0]?.detail?.readonly).toBe(false);
  });

  it("reports sqlite.open_failed when a read-only handle can't be opened", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-sqlite-open-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "missing", "cache.db");

    const events = collectDiagnostics();
    expect(openDbReadOnly(dbPath)).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("sqlite.open_failed");
    expect(events[0]?.detail?.dbPath).toBe(dbPath);
    expect(events[0]?.detail?.readonly).toBe(true);
  });
});
