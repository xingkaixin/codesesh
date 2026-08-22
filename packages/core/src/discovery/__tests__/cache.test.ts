import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCache,
  loadCachedSessionData,
  readCachedSessions,
  saveCachedSessions,
  type CachedResult,
} from "../cache/sessions.js";
import { searchSessions, syncSessionSearchIndex } from "../cache/search.js";
import { setSchemaEnsuredPath } from "../cache/db.js";
import { searchIndexStateQuery } from "../cache/search-index-writer.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cache-smoke-test-"));

function readCachedValue(agentName: string): CachedResult | null {
  const outcome = readCachedSessions(agentName);
  expect(outcome.status).toBe("success");
  return outcome.status === "success" ? outcome.value : null;
}

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  clearCache();
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setSchemaEnsuredPath(null);
});

describe("session cache integration", () => {
  it("persists, indexes, searches, and restores one session", () => {
    const session: SessionHead = {
      reference: { agentName: "codex", sessionId: "smoke" },
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
    const data: SessionDetail = {
      ...session,
      reference: { agentName: "codex", sessionId: session.reference.sessionId },
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
        reference: { agentName: "codex", sessionId: "smoke" },
        session: expect.objectContaining({
          reference: { agentName: "codex", sessionId: "smoke" },
        }),
      }),
    ]);
    expect(loadCachedSessionData("codex", "smoke")).toMatchObject({
      reference: { agentName: "codex", sessionId: "smoke" },
      messages: [{ id: "message" }],
    });

    // Every scan re-probes each cached session for index drift. content_text
    // holds the whole session body, so a plan that reaches the document rows
    // makes that probe cost the corpus size rather than the session count.
    const db = new Database(join(testHomeDir, ".cache", "codesesh", "codesesh.db"), {
      readonly: true,
    });
    try {
      const plan = db
        .prepare(`EXPLAIN QUERY PLAN ${searchIndexStateQuery(1)}`)
        .all("smoke", "codex", "codex", "codex") as Array<{ detail: string }>;
      expect(plan.map(({ detail }) => detail)).toContainEqual(
        expect.stringContaining("COVERING INDEX idx_session_documents_state"),
      );
      expect(plan.map(({ detail }) => detail)).toContainEqual(
        expect.stringMatching(/COVERING INDEX .*messages/),
      );
    } finally {
      db.close();
    }
  });

  it("merges a partial snapshot without deleting data outside its window", () => {
    const old: SessionHead = {
      reference: { agentName: "codex", sessionId: "old" },
      title: "Old session",
      directory: "/workspace/project",
      project_identity: {
        kind: "path",
        key: "/workspace/project",
        displayName: "project",
      },
      time_created: 1,
      time_updated: 1,
      stats: {
        message_count: 2,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    };
    const recent: SessionHead = {
      ...old,
      reference: { agentName: "codex", sessionId: "recent" },
      title: "Recent session",
      time_created: 2,
      time_updated: 2,
    };
    saveCachedSessions("codex", [recent, old], {
      old: { id: "old", sourcePath: "/sessions/old.jsonl" },
      recent: { id: "recent", sourcePath: "/sessions/recent.jsonl" },
    });
    syncSessionSearchIndex("codex", [recent, old], (sessionId) => {
      const head = sessionId === "old" ? old : recent;
      return {
        ...head,
        reference: { agentName: "codex", sessionId },
        messages:
          sessionId === "old"
            ? [
                {
                  id: "old-user",
                  role: "user",
                  time_created: 1,
                  parts: [{ type: "text", text: "historical-window-needle" }],
                },
                {
                  id: "old-tool",
                  role: "assistant",
                  time_created: 2,
                  parts: [
                    {
                      type: "tool",
                      tool: "apply_patch",
                      state: {
                        status: "completed",
                        input: { path: "src/legacy.ts" },
                      },
                    },
                  ],
                },
              ]
            : [],
      } as SessionDetail;
    });

    const updatedRecent = { ...recent, title: "Updated recent", time_updated: 3 };
    saveCachedSessions("codex", [updatedRecent], {}, { completeness: "partial" });

    expect(readCachedValue("codex")).toMatchObject({
      sessions: [
        {
          reference: { agentName: "codex", sessionId: "recent" },
          title: "Updated recent",
        },
        { reference: { agentName: "codex", sessionId: "old" } },
      ],
      meta: { old: { sourcePath: "/sessions/old.jsonl" } },
    });
    expect(loadCachedSessionData("codex", "old")).toMatchObject({
      messages: [{ id: "old-user" }, { id: "old-tool" }],
      file_activity: [{ path: "src/legacy.ts" }],
    });
    expect(searchSessions("historical-window-needle")[0]?.session.reference.sessionId).toBe("old");

    saveCachedSessions("codex", [updatedRecent]);

    expect(loadCachedSessionData("codex", "old")).toBeNull();
    expect(searchSessions("historical-window-needle")).toEqual([]);
  });
});
