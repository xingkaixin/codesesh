import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { deleteSessionAlias, listSessionAliases, upsertSessionAlias } from "../session-aliases.js";
import { setStateSchemaEnsuredPath } from "../database.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-aliases-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
    platform: vi.fn(() => "linux"),
  };
});

beforeEach(() => {
  rmSync(join(testHomeDir, ".local"), { recursive: true, force: true });
  setStateSchemaEnsuredPath(null);
  vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setStateSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".local"), { recursive: true, force: true });
});

describe("session aliases", () => {
  it("persists aliases by agent and session ID", () => {
    upsertSessionAlias(
      { agentName: "codex", sessionId: "shared" },
      "Investigate cache invalidation",
    );
    upsertSessionAlias({ agentName: "claudecode", sessionId: "shared" }, "Fix checkout regression");

    expect(listSessionAliases()).toEqual([
      {
        reference: { agentName: "codex", sessionId: "shared" },
        alias: "Investigate cache invalidation",
        updatedAt: 1_700_000_000_000,
      },
      {
        reference: { agentName: "claudecode", sessionId: "shared" },
        alias: "Fix checkout regression",
        updatedAt: 1_700_000_000_000,
      },
    ]);
  });

  it("updates and removes aliases", () => {
    const reference = { agentName: "codex", sessionId: "s1" };
    upsertSessionAlias(reference, "First title");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_100);
    upsertSessionAlias(reference, "Second title");

    expect(listSessionAliases()[0]).toMatchObject({
      alias: "Second title",
      updatedAt: 1_700_000_000_100,
    });

    deleteSessionAlias(reference);
    expect(listSessionAliases()).toEqual([]);
  });
});
