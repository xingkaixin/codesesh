import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../../utils/diagnostics.js";
import { closeCacheStorage } from "../db.js";
import {
  withCacheDb,
  withCacheDbOutcome,
  withCacheDbReadOnly,
  withSearchDb,
  withSearchIndexDb,
} from "../connection.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-diag-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  closeCacheStorage();
  setCoreDiagnostics(null);
});

function collectDiagnostics(
  includeInfo = false,
): Array<{ event: string; detail?: Record<string, unknown> }> {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const diagnostics: CoreDiagnostics = {
    info: includeInfo ? (event, detail) => events.push({ event, detail }) : undefined,
    warn: (event, detail) => events.push({ event, detail }),
  };
  setCoreDiagnostics(diagnostics);
  return events;
}

function failingRead(): never {
  throw Object.assign(new Error("database unavailable"), { code: "SQLITE_IOERR" });
}

describe("withCacheDb diagnostics", () => {
  it("reports cache.write_failed when a SQLite callback throws", () => {
    const events = collectDiagnostics();

    const result = withCacheDb(() => {
      throw Object.assign(new Error("disk full"), { code: "SQLITE_FULL" });
    });

    expect(result).toBeNull();
    expect(events).toEqual([
      {
        event: "cache.write_failed",
        detail: {
          message: "disk full",
          code: "SQLITE_FULL",
          error_class: "Error",
          stack: expect.any(String),
        },
      },
    ]);
  });

  it("reports the error class for a read-only query failure", () => {
    withCacheDb(() => undefined);
    const events = collectDiagnostics();

    const result = withCacheDbReadOnly(() => {
      throw Object.assign(new Error("datatype mismatch"), { code: "SQLITE_MISMATCH" });
    });

    expect(result).toEqual({ status: "failed" });
    expect(events).toEqual([
      {
        event: "cache.read_failed",
        detail: {
          message: "datatype mismatch",
          code: "SQLITE_MISMATCH",
          error_class: "Error",
        },
      },
    ]);
  });

  it.each([
    ["schema-ensuring reads", (): unknown => withCacheDbOutcome(failingRead), { status: "failed" }],
    ["search reads", (): unknown => withSearchDb(failingRead), null],
  ] as const)("reports cache.read_failed for %s", (_label, read, expected) => {
    const events = collectDiagnostics();

    expect(read()).toEqual(expected);
    expect(events).toContainEqual({
      event: "cache.read_failed",
      detail: {
        message: "database unavailable",
        code: "SQLITE_IOERR",
        error_class: "Error",
      },
    });
  });

  it("rethrows programming errors from read-only callbacks", () => {
    withCacheDb(() => undefined);
    const events = collectDiagnostics();

    expect(() =>
      withCacheDbReadOnly(() => {
        throw new TypeError("invalid row projection");
      }),
    ).toThrow(new TypeError("invalid row projection"));
    expect(events).toEqual([]);
  });

  it("rethrows programming errors without discarding the connection", () => {
    const events = collectDiagnostics();
    const connection = withCacheDb((db) => db);

    expect(() =>
      withCacheDb(() => {
        throw new TypeError("invalid cache projection");
      }),
    ).toThrow(new TypeError("invalid cache projection"));

    expect(events).toEqual([]);
    expect(withCacheDb((db) => db)).toBe(connection);
  });

  it("stays silent when no diagnostics sink is injected", () => {
    expect(() =>
      withCacheDb(() => {
        throw Object.assign(new Error("boom"), { code: "SQLITE_IOERR" });
      }),
    ).not.toThrow();
  });

  it("does not run a full FTS integrity check during a normal index write", () => {
    const events = collectDiagnostics(true);

    expect(withSearchIndexDb(() => "ready")).toBe("ready");
    expect(events.some(({ event }) => event === "sqlite.fts_integrity.started")).toBe(false);
    expect(events).toContainEqual({
      event: "sqlite.publication_staging_cleanup.completed",
      detail: {
        duration_ms: expect.any(Number),
        reclaimed: false,
      },
    });
  });
});
