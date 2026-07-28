/**
 * Owner-only permissions for the files CodeSesh writes.
 *
 * The session cache holds full transcripts; state holds bookmarks and aliases;
 * logs hold project paths and error detail. All of them were created under the
 * process umask, which is commonly 022 — so 0755 directories and 0644 files. On
 * a shared machine with a traversable home, another user could read them.
 *
 * POSIX modes do not apply on Windows, where `chmod` is a no-op; access there is
 * governed by the profile directory's ACL.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCoreDiagnostics } from "./diagnostics.js";

/** Owner read/write/execute. */
export const PRIVATE_DIR_MODE = 0o700;
/** Owner read/write. */
export const PRIVATE_FILE_MODE = 0o600;

/** Sidecars SQLite creates next to a database, which carry the same data. */
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

const isPosix = process.platform !== "win32";

function reportChmodFailure(path: string, error: unknown): void {
  getCoreDiagnostics()?.warn("storage.permissions_failed", {
    path,
    message: error instanceof Error ? error.message : String(error),
  });
}

/** Narrows an existing path's permissions, reporting rather than throwing. */
function restrict(path: string, mode: number): void {
  if (!isPosix || !existsSync(path)) return;
  try {
    // Skip the syscall when it would not change anything.
    if ((statSync(path).mode & 0o777) === mode) return;
    chmodSync(path, mode);
  } catch (error) {
    reportChmodFailure(path, error);
  }
}

/**
 * Creates a directory only its owner can enter, and tightens it if it existed.
 *
 * A failed mkdir propagates — the caller has nowhere to store anything. A failed
 * chmod does not: the directory is usable, just not as private as intended, and
 * that is reported instead.
 */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  // `recursive` skips the mode for a directory that already existed.
  restrict(path, PRIVATE_DIR_MODE);
}

/** Narrows a file CodeSesh owns to owner-only. */
export function restrictPrivateFile(path: string): void {
  restrict(path, PRIVATE_FILE_MODE);
}

/**
 * Tightens files already in a directory — those written before this policy
 * existed, or by an older version. The caller names exactly what it owns, so
 * the sweep never reaches beyond CodeSesh's own files.
 */
export function restrictExistingPrivateFiles(
  directory: string,
  owns: (name: string) => boolean,
): void {
  try {
    for (const entry of readdirSync(directory)) {
      if (owns(entry)) restrictPrivateFile(join(directory, entry));
    }
  } catch (error) {
    reportChmodFailure(directory, error);
  }
}

/** Databases whose neighbouring backups have already been swept this process. */
const sweptBackupsFor = new Set<string>();

/** A backup holds the same rows as the database it came from. */
function restrictExistingBackups(dbPath: string): void {
  if (sweptBackupsFor.has(dbPath)) return;
  sweptBackupsFor.add(dbPath);

  const prefix = `${basename(dbPath)}.`;
  restrictExistingPrivateFiles(
    dirname(dbPath),
    (name) => name.startsWith(prefix) && name.endsWith(".bak"),
  );
}

/**
 * Narrows a database, any sidecar SQLite has created, and backups left beside
 * it. Call after opening: the sidecars do not exist until the connection is
 * established.
 */
export function restrictPrivateDatabase(dbPath: string): void {
  restrictPrivateFile(dbPath);
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) restrictPrivateFile(`${dbPath}${suffix}`);
  restrictExistingBackups(dbPath);
}
