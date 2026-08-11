import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCoreDiagnostics } from "../../../utils/diagnostics.js";
import {
  clearCache,
  getCacheInfo,
  loadCachedSessionHeads,
  loadCachedSessions,
  saveCachedSessionChanges,
  saveCachedSessions,
} from "../sessions.js";
import { setSchemaEnsuredPath } from "../db.js";
import { withCacheDb } from "../schema.js";
import { makeSessionHead } from "./fixtures.js";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-sessions-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

afterEach(() => {
  setCoreDiagnostics(null);
  rmSync(join(testHomeDir, ".cache"), { recursive: true, force: true });
  setSchemaEnsuredPath(null);
});

describe("cached sessions", () => {
  it("persists full snapshots and metadata", () => {
    saveCachedSessions("codex", [makeSessionHead("one")], {
      one: { id: "one", sourcePath: "/transcripts/one.jsonl" },
    });

    expect(loadCachedSessions("codex")).toMatchObject({
      sessions: [{ id: "one" }],
      meta: { one: { sourcePath: "/transcripts/one.jsonl" } },
    });
    expect(getCacheInfo().size).toBe(1);
  });

  it("applies changed and removed session ids atomically", () => {
    saveCachedSessions("codex", [makeSessionHead("keep"), makeSessionHead("remove")]);
    const changed = makeSessionHead("keep", { title: "Updated" });

    saveCachedSessionChanges("codex", [{ session: changed, sortIndex: 0 }], ["remove"]);

    expect(loadCachedSessions("codex")?.sessions).toEqual([
      expect.objectContaining({ id: "keep", title: "Updated" }),
    ]);
  });

  it("preserves and reports metadata omitted from an incremental change", () => {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({ warn: (event, detail) => events.push({ event, detail }) });
    saveCachedSessions("codex", [makeSessionHead("one")], {
      one: { id: "one", sourcePath: "/transcripts/one.jsonl" },
    });

    saveCachedSessionChanges(
      "codex",
      [{ session: makeSessionHead("one", { title: "Updated" }), sortIndex: 0 }],
      [],
    );

    const cached = loadCachedSessions("codex");
    expect(cached?.sessions[0]?.title).toBe("Updated");
    expect(cached?.meta.one).toEqual({
      id: "one",
      sourcePath: "/transcripts/one.jsonl",
    });
    expect(
      withCacheDb(
        (db) =>
          (
            db
              .prepare("SELECT source_path FROM sessions WHERE agent_name = ? AND session_id = ?")
              .get("codex", "one") as { source_path?: string }
          ).source_path,
      ),
    ).toBe("/transcripts/one.jsonl");
    expect(events).toEqual([
      {
        event: "cache.session_meta_missing",
        detail: { agent: "codex", session_id: "one" },
      },
    ]);
  });

  it("round-trips parent references through the structured cache", () => {
    const child = makeSessionHead("child", {
      parent_reference: { agentName: "codex", sessionId: "parent" },
    });
    saveCachedSessions("codex", [makeSessionHead("parent"), child]);

    expect(loadCachedSessions("codex")?.sessions[1]?.parent_reference).toEqual({
      agentName: "codex",
      sessionId: "parent",
    });
  });

  it("loads only requested session heads by compound identity", () => {
    saveCachedSessions("codex", [makeSessionHead("shared"), makeSessionHead("other")]);
    saveCachedSessions("cursor", [
      makeSessionHead("shared", { slug: "cursor/shared", title: "Cursor shared" }),
    ]);

    const sessions = loadCachedSessionHeads([
      { agentName: " CoDeX ", sessionId: "shared" },
      { agentName: "cursor", sessionId: "shared" },
      { agentName: "codex", sessionId: "shared" },
      { agentName: "codex", sessionId: "missing" },
    ]);

    expect(sessions).toEqual([
      expect.objectContaining({
        reference: { agentName: "codex", sessionId: "shared" },
        session: expect.objectContaining({ title: "Session shared" }),
      }),
      expect.objectContaining({
        reference: { agentName: "cursor", sessionId: "shared" },
        session: expect.objectContaining({ title: "Cursor shared" }),
      }),
    ]);
  });

  it("chunks large targeted session-head lookups", () => {
    saveCachedSessions("codex", [makeSessionHead("session-400")]);
    const references = Array.from({ length: 401 }, (_, index) => ({
      agentName: "codex",
      sessionId: `session-${index}`,
    }));

    const resolved = loadCachedSessionHeads(references);

    expect(resolved).toEqual([
      expect.objectContaining({
        reference: { agentName: "codex", sessionId: "session-400" },
      }),
    ]);
  });

  it("CS-137: reports whether the write reached disk", () => {
    expect(saveCachedSessions("codex", [makeSessionHead("one")])).toBe(true);
    expect(
      saveCachedSessionChanges("codex", [{ session: makeSessionHead("one"), sortIndex: 0 }], []),
    ).toBe(true);
    expect(saveCachedSessionChanges("codex", [], [])).toBe(true);

    withCacheDb((db) => db.exec("DROP TABLE sessions"));

    expect(saveCachedSessions("codex", [makeSessionHead("two")])).toBe(false);
    expect(
      saveCachedSessionChanges("codex", [{ session: makeSessionHead("two"), sortIndex: 0 }], []),
    ).toBe(false);
  });

  it("clears persisted rows without leaving stale state", () => {
    saveCachedSessions("codex", [makeSessionHead("one")]);
    clearCache();

    expect(loadCachedSessions("codex")).toBeNull();
    expect(getCacheInfo()).toEqual({ lastScanTime: null, size: 0 });
  });
});
