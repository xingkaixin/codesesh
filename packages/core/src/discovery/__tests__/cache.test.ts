import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  loadCachedSessionData,
  saveCachedSessions,
  searchSessions,
  syncSessionSearchIndex,
} from "../cache.js";
import { setFtsIntegrityCheckedPath, setSchemaEnsuredPath } from "../cache/db.js";
import type { SessionData, SessionHead } from "../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-smoke-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  clearCache();
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setFtsIntegrityCheckedPath(null);
  setSchemaEnsuredPath(null);
});

describe("session cache integration", () => {
  it("persists, indexes, searches, and restores one session", () => {
    const session: SessionHead = {
      id: "smoke",
      slug: "codex/smoke",
      title: "Cache smoke",
      directory: "/workspace/project",
      project_identity: {
        kind: "path",
        key: "/workspace/project",
        displayName: "project",
      },
      time_created: 1_700_000_000_000,
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    };
    const data: SessionData = {
      ...session,
      messages: [
        {
          id: "message",
          role: "user",
          time_created: session.time_created,
          parts: [{ type: "text", text: "integration needle" }],
        },
      ],
    };

    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => data);

    expect(searchSessions("needle")).toEqual([
      expect.objectContaining({
        agentName: "codex",
        session: expect.objectContaining({ id: "smoke" }),
      }),
    ]);
    expect(loadCachedSessionData("codex", "smoke")).toMatchObject({
      id: "smoke",
      messages: [{ id: "message" }],
    });
  });
});
