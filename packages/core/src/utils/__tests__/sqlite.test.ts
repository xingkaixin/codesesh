import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupDatabaseIfPopulated,
  getUserVersion,
  openDb,
  openDbReadOnly,
  runSchemaMigrations,
  type SQLiteDatabase,
} from "../sqlite.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

describe("sqlite migration helpers", () => {
  afterEach(() => {
    setCoreDiagnostics(null);
  });

  function collectMigrationDiagnostics(): Array<{
    level: "info" | "warn";
    event: string;
    detail?: Record<string, unknown>;
  }> {
    const events: Array<{
      level: "info" | "warn";
      event: string;
      detail?: Record<string, unknown>;
    }> = [];
    setCoreDiagnostics({
      info: (event, detail) => events.push({ level: "info", event, detail }),
      warn: (event, detail) => events.push({ level: "warn", event, detail }),
    });
    return events;
  }

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

  it("reports migration start and completion", () => {
    const db = new Database(":memory:") as unknown as SQLiteDatabase;
    const events = collectMigrationDiagnostics();
    try {
      runSchemaMigrations(db, {
        dbPath: ":memory:",
        currentVersion: 0,
        targetVersion: 1,
        migrations: [{ version: 1, migrate: (database) => database.exec("CREATE TABLE rows(id)") }],
        backupTables: [],
        backupLabel: "test-migration",
      });

      expect(events).toEqual([
        {
          level: "info",
          event: "sqlite.migration.started",
          detail: {
            label: "test-migration",
            from_version: 0,
            to_version: 1,
            destructive: false,
          },
        },
        {
          level: "info",
          event: "sqlite.migration.completed",
          detail: expect.objectContaining({
            label: "test-migration",
            from_version: 0,
            to_version: 1,
            destructive: false,
            backup_created: false,
            duration_ms: expect.any(Number),
          }),
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("reports migration failures before rethrowing", () => {
    const db = new Database(":memory:") as unknown as SQLiteDatabase;
    const events = collectMigrationDiagnostics();
    try {
      expect(() =>
        runSchemaMigrations(db, {
          dbPath: ":memory:",
          currentVersion: 0,
          targetVersion: 1,
          migrations: [
            {
              version: 1,
              migrate() {
                throw new Error("migration boom");
              },
            },
          ],
          backupTables: [],
          backupLabel: "test-migration",
        }),
      ).toThrow("migration boom");

      expect(events.map(({ level, event }) => ({ level, event }))).toEqual([
        { level: "info", event: "sqlite.migration.started" },
        { level: "warn", event: "sqlite.migration.failed" },
      ]);
      expect(events[1]?.detail).toEqual(
        expect.objectContaining({
          from_version: 0,
          to_version: 1,
          message: "migration boom",
          duration_ms: expect.any(Number),
        }),
      );
    } finally {
      db.close();
    }
  });

  it("keeps the source and backup recoverable when a destructive migration fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-migration-recovery-"));
    const dbPath = join(dir, "cache.db");
    const db = new Database(dbPath) as unknown as SQLiteDatabase;
    try {
      db.exec("CREATE TABLE rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO rows(id, value) VALUES (1, 'before')").run();

      expect(() =>
        runSchemaMigrations(db, {
          dbPath,
          currentVersion: 0,
          targetVersion: 1,
          migrations: [
            {
              version: 1,
              destructive: true,
              migrate(database) {
                database.exec("ALTER TABLE rows ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1");
                database.exec("UPDATE rows SET value = 'during'");
                throw new Error("migration interrupted");
              },
            },
          ],
          backupTables: ["rows"],
          backupLabel: "recovery",
        }),
      ).toThrow("migration interrupted");

      expect(getUserVersion(db)).toBe(0);
      expect(db.prepare("SELECT * FROM rows").all()).toEqual([{ id: 1, value: "before" }]);
      expect(
        db
          .prepare("PRAGMA table_info(rows)")
          .all()
          .map((row) => row.name),
      ).toEqual(["id", "value"]);

      const backupName = readdirSync(dir).find((name) => name.endsWith(".recovery.bak"));
      expect(backupName).toBeDefined();
      const backup = new Database(join(dir, backupName!), { readonly: true });
      try {
        expect(backup.prepare("SELECT * FROM rows").all()).toEqual([{ id: 1, value: "before" }]);
      } finally {
        backup.close();
      }

      runSchemaMigrations(db, {
        dbPath,
        currentVersion: 0,
        targetVersion: 1,
        migrations: [
          {
            version: 1,
            destructive: true,
            migrate(database) {
              database.exec("ALTER TABLE rows ADD COLUMN migrated INTEGER NOT NULL DEFAULT 1");
            },
          },
        ],
        backupTables: ["rows"],
        backupLabel: "recovery",
      });

      expect(getUserVersion(db)).toBe(1);
      expect(db.prepare("SELECT * FROM rows").all()).toEqual([
        { id: 1, value: "before", migrated: 1 },
      ]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("openDb pragmas", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sets a busy_timeout so lock contention waits instead of failing immediately", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-sqlite-busy-timeout-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");

    const db = openDb(dbPath);
    expect(db).not.toBeNull();
    try {
      const pragmaCapable = db as unknown as { pragma(sql: string): unknown };
      expect(pragmaCapable.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
    } finally {
      db?.close();
    }
  });

  it("sets the same busy_timeout on read-only connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "codesesh-sqlite-read-busy-timeout-test-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "state.db");
    openDb(dbPath)?.close();

    const db = openDbReadOnly(dbPath);
    expect(db).not.toBeNull();
    try {
      const pragmaCapable = db as unknown as { pragma(sql: string): unknown };
      expect(pragmaCapable.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
    } finally {
      db?.close();
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
