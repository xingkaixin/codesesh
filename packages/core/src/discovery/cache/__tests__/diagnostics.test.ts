import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../../utils/diagnostics.js";
import { withCacheDb } from "../schema.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-diag-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  setCoreDiagnostics(null);
});

function collectDiagnostics(): Array<{ event: string; detail?: Record<string, unknown> }> {
  const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const diagnostics: CoreDiagnostics = {
    warn: (event, detail) => events.push({ event, detail }),
  };
  setCoreDiagnostics(diagnostics);
  return events;
}

describe("withCacheDb diagnostics", () => {
  it("reports cache.write_failed when the callback throws", () => {
    const events = collectDiagnostics();

    const result = withCacheDb(() => {
      throw new Error("disk full");
    });

    expect(result).toBeNull();
    expect(events).toEqual([{ event: "cache.write_failed", detail: { message: "disk full" } }]);
  });

  it("stays silent when no diagnostics sink is injected", () => {
    expect(() =>
      withCacheDb(() => {
        throw new Error("boom");
      }),
    ).not.toThrow();
  });
});
