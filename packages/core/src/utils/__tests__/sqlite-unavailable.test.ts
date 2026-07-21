import { afterEach, describe, expect, it, vi } from "vitest";
import { setCoreDiagnostics, type CoreDiagnostics } from "../diagnostics.js";

// sqlite.ts loads better-sqlite3 via createRequire at module-evaluation time,
// before any host has a chance to call setCoreDiagnostics — so simulating an
// unavailable native module requires faking createRequire itself rather than
// vi.mock("better-sqlite3"), which only intercepts the ESM graph.
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const nodeRequire = actual.createRequire(url);
      return Object.assign((id: string) => {
        if (id === "better-sqlite3") {
          throw new Error("Cannot find module 'better-sqlite3'");
        }
        return nodeRequire(id);
      }, nodeRequire);
    },
  };
});

import { isSqliteAvailable, openDb, openDbReadOnly } from "../sqlite.js";

describe("sqlite unavailable", () => {
  afterEach(() => {
    setCoreDiagnostics(null);
  });

  it("reports sqlite.unavailable once, on the first open attempt after a sink is injected", () => {
    expect(isSqliteAvailable()).toBe(false);

    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const diagnostics: CoreDiagnostics = {
      warn: (event, detail) => events.push({ event, detail }),
    };
    setCoreDiagnostics(diagnostics);

    expect(openDb("/tmp/codesesh-sqlite-unavailable-test.db")).toBeNull();
    expect(openDbReadOnly("/tmp/codesesh-sqlite-unavailable-test.db")).toBeNull();

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("sqlite.unavailable");
    expect(events[0]?.detail?.message).toContain("better-sqlite3");
  });
});
