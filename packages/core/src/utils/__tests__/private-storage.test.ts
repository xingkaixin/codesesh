import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDirectory,
  restrictPrivateDatabase,
  restrictPrivateFile,
} from "../private-storage.js";
import { backupDatabase, openDb } from "../sqlite.js";

const isPosix = process.platform !== "win32";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "codesesh-private-"));
  tempDirs.push(dir);
  return dir;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("CS-141: private storage", () => {
  it.runIf(isPosix)("creates a directory only its owner can enter", () => {
    const dir = join(workspace(), "nested", "cache");

    ensurePrivateDirectory(dir);

    expect(mode(dir)).toBe(PRIVATE_DIR_MODE);
  });

  it.runIf(isPosix)("tightens a directory that already existed too openly", () => {
    const dir = join(workspace(), "cache");
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);

    ensurePrivateDirectory(dir);

    expect(mode(dir)).toBe(PRIVATE_DIR_MODE);
  });

  it.runIf(isPosix)("tightens an existing world-readable file", () => {
    const path = join(workspace(), "codesesh.log");
    writeFileSync(path, "entry");
    chmodSync(path, 0o644);

    restrictPrivateFile(path);

    expect(mode(path)).toBe(PRIVATE_FILE_MODE);
  });

  it.runIf(isPosix)("tightens a database and every sidecar", () => {
    const dir = workspace();
    const dbPath = join(dir, "state.db");
    for (const suffix of ["", "-wal", "-shm"]) {
      writeFileSync(`${dbPath}${suffix}`, "");
      chmodSync(`${dbPath}${suffix}`, 0o644);
    }

    restrictPrivateDatabase(dbPath);

    for (const suffix of ["", "-wal", "-shm"]) {
      expect(mode(`${dbPath}${suffix}`), suffix || "main").toBe(PRIVATE_FILE_MODE);
    }
  });

  it.runIf(isPosix)("opens a database with private permissions", () => {
    const dbPath = join(workspace(), "nested", "cache.db");

    const db = openDb(dbPath);
    db?.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db?.close();

    expect(mode(join(dbPath, ".."))).toBe(PRIVATE_DIR_MODE);
    expect(mode(dbPath)).toBe(PRIVATE_FILE_MODE);
  });

  it.runIf(isPosix)("keeps a migration backup private", () => {
    const dir = workspace();
    const dbPath = join(dir, "source.db");
    const source = new Database(dbPath);
    source.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    source.prepare("INSERT INTO t (id) VALUES (1)").run();

    const backupPath = backupDatabase(source as never, dbPath, "test");
    source.close();

    expect(backupPath).not.toBeNull();
    expect(mode(backupPath!)).toBe(PRIVATE_FILE_MODE);
  });

  it.runIf(isPosix)("tightens a backup left beside the database", () => {
    const dir = workspace();
    const dbPath = join(dir, "cache.db");
    const backupPath = `${dbPath}.2026-01-01T000000-000Z.migration.bak`;
    const unrelated = join(dir, "other.db.2026-01-01T000000-000Z.migration.bak");
    for (const path of [dbPath, backupPath, unrelated]) {
      writeFileSync(path, "");
      chmodSync(path, 0o644);
    }

    restrictPrivateDatabase(dbPath);

    expect(mode(backupPath)).toBe(PRIVATE_FILE_MODE);
    // Scoped to this database's own backups.
    expect(mode(unrelated)).toBe(0o644);
  });

  it("does not throw for a missing path", () => {
    const missing = join(workspace(), "absent.db");

    expect(() => restrictPrivateFile(missing)).not.toThrow();
    expect(() => restrictPrivateDatabase(missing)).not.toThrow();
  });

  it.runIf(!isPosix)("is a no-op on Windows", () => {
    const dir = join(workspace(), "cache");

    expect(() => ensurePrivateDirectory(dir)).not.toThrow();
    expect(() => restrictPrivateFile(join(dir, "file.log"))).not.toThrow();
  });
});
