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
    upsertSessionAlias("codex", "shared", "Investigate cache invalidation");
    upsertSessionAlias("claudecode", "shared", "Fix checkout regression");

    expect(listSessionAliases()).toEqual([
      {
        agentKey: "codex",
        sessionId: "shared",
        alias: "Investigate cache invalidation",
        updated_at: 1_700_000_000_000,
      },
      {
        agentKey: "claudecode",
        sessionId: "shared",
        alias: "Fix checkout regression",
        updated_at: 1_700_000_000_000,
      },
    ]);
  });

  it("updates and removes aliases", () => {
    upsertSessionAlias("codex", "s1", "First title");
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_100);
    upsertSessionAlias("codex", "s1", "Second title");

    expect(listSessionAliases()[0]).toMatchObject({
      alias: "Second title",
      updated_at: 1_700_000_000_100,
    });

    deleteSessionAlias("codex", "s1");
    expect(listSessionAliases()).toEqual([]);
  });
});
