import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAgent, resolveOpenCodeDataRoot } from "../opencode.js";
import { SessionScanError } from "../base.js";
import { sessionDetailVersion } from "../../discovery/cache/detail-version.js";

let root: string;
let db: Database.Database;
let agent: OpenCodeAgent;

beforeEach(() => {
  vi.stubEnv("OPENCODE_DB", "");
  root = mkdtempSync(join(tmpdir(), "codesesh-opencode-v2-"));
  db = new Database(join(root, "opencode.db"));
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, title TEXT,
      directory TEXT DEFAULT '/project', path TEXT, version TEXT DEFAULT '2.0.15',
      summary_files INTEGER DEFAULT 0, time_created INTEGER DEFAULT 1000,
      time_updated INTEGER DEFAULT 2000, time_archived INTEGER,
      cost REAL DEFAULT 0, tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0,
      tokens_reasoning INTEGER DEFAULT 0, tokens_cache_read INTEGER DEFAULT 0,
      tokens_cache_write INTEGER DEFAULT 0
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER DEFAULT 1000, time_updated INTEGER DEFAULT 2000, data TEXT,
      UNIQUE(session_id, seq)
    );
  `);
  agent = new OpenCodeAgent({ sourceRoot: root });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

function session(id = "root", parent: string | null = null, time = 2000) {
  db.prepare("INSERT INTO session_v2 (id, parent_id, time_updated) VALUES (?, ?, ?)").run(
    id,
    parent,
    time,
  );
}

function message(type: string, data: Record<string, unknown>, seq: number, sessionId = "root") {
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, data) VALUES (?, ?, ?, ?, ?)",
  ).run(`${sessionId}-${seq}`, sessionId, type, seq, JSON.stringify(data));
}

function tool(name: string, status: string, content?: unknown, metadata?: unknown) {
  return {
    type: "tool",
    id: `call-${name}`,
    name,
    state: { status, input: { path: "a.ts" }, content, metadata },
  };
}

describe("OpenCode V2", () => {
  it("reads archived sessions in sequence order without changing the source", () => {
    session();
    db.exec("UPDATE session_v2 SET time_archived = 3000, path = 'packages/core'");
    message(
      "assistant",
      {
        agent: "build",
        model: { id: "gpt-5", providerID: "openai" },
        time: { completed: 2500 },
        content: [
          { type: "reasoning", text: "Think" },
          { type: "text", text: "Done" },
        ],
      },
      2,
    );
    message("user", { text: "Build a parser" }, 1);
    db.close();
    const before = readFileSync(join(root, "opencode.db"));
    expect(agent.isAvailable()).toBe(true);
    const [head] = agent.scan({ from: 0 });
    const detail = agent.getSessionData("root");
    expect(head).toMatchObject({
      title: "Build a parser",
      directory: "/project",
      stats: { message_count: 2 },
    });
    expect(detail.messages.map((message) => message.id)).toEqual(["root-1", "root-2"]);
    expect(detail.messages[1]).toMatchObject({
      role: "assistant",
      agent: "build",
      model: "gpt-5",
      provider: "openai",
      time_completed: 2500,
      parts: [
        { type: "reasoning", text: "Think" },
        { type: "text", text: "Done" },
      ],
    });
    expect(detail.stats).toEqual(head?.stats);
    expect(readFileSync(join(root, "opencode.db"))).toEqual(before);
  });

  it("uses only completed V2 migrations and never revives legacy sessions", () => {
    db.exec("CREATE TABLE session (id TEXT); CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)");
    session();
    message("user", { text: "New history" }, 1);
    expect(agent.scan()).toHaveLength(1);
    const previous = agent.snapshotSessionCacheMeta();
    db.exec(
      "INSERT INTO session VALUES ('root'), ('deleted'); INSERT INTO kv VALUES ('migration.v1-v2', '{\"phase\":\"sessions\"}')",
    );
    expect(() => agent.scan()).toThrow(SessionScanError);
    expect(agent.snapshotSessionCacheMeta()).toEqual(previous);
    expect(() => agent.getSessionData("root")).toThrow("migration is not complete");
    db.exec('UPDATE kv SET value = \'{"phase":"completed"}\'');
    expect(agent.scan().map((head) => head.reference.sessionId)).toEqual(["root"]);
    expect(() => agent.getSessionData("deleted")).toThrow("Session not found");
    db.exec("DELETE FROM session_v2");
    expect(agent.scan()).toEqual([]);
  });

  it("reports missing or incompatible schemas and malformed message data", () => {
    session();
    message("user", { text: "Before corruption" }, 1);
    agent.scan();
    const previous = agent.snapshotSessionCacheMeta();
    for (const corrupt of ["not json", "[]"]) {
      db.prepare("UPDATE session_message SET data = ?").run(corrupt);
      expect(() => agent.scan()).toThrow(SessionScanError);
      expect(agent.snapshotSessionCacheMeta()).toEqual(previous);
    }
    db.exec("UPDATE session_message SET type = 'assistant', data = '{}'");
    expect(() => agent.scan()).toThrow(SessionScanError);
    db.exec("ALTER TABLE session_v2 RENAME TO session");
    expect(() => agent.scan()).toThrow(SessionScanError);
    db.exec("ALTER TABLE session RENAME TO session_v2; DROP TABLE session_message");
    expect(() => agent.scan()).toThrow(SessionScanError);
  });

  it("selects roots, descendants and orphans without treating forks as children", () => {
    session("root", null, 2000);
    session("child", "root", 1);
    session("grandchild", "child", 1);
    session("orphan", "missing", 2000);
    session("fork", null, 2000);
    session("old", null, 1);
    session("old-child", "old", 2000);
    session("cycle-a", "cycle-b", 2000);
    session("cycle-b", "cycle-a", 2000);
    session("empty");
    db.exec("UPDATE session_v2 SET fork_session_id = 'root' WHERE id = 'fork'");
    for (const id of [
      "root",
      "child",
      "grandchild",
      "orphan",
      "fork",
      "old",
      "old-child",
      "cycle-a",
      "cycle-b",
    ])
      message("user", { text: id }, 1, id);
    const heads = agent.scan({ from: 2000, to: 2000 });
    expect(heads.map((head) => head.reference.sessionId).sort()).toEqual([
      "child",
      "fork",
      "grandchild",
      "orphan",
      "root",
    ]);
    expect(
      heads.find((head) => head.reference.sessionId === "fork")?.parent_reference,
    ).toBeUndefined();
    expect(agent.scan({ from: 2000, to: 2000, includeRelatedSessions: false })).toHaveLength(3);
    expect(agent.scan({ from: 2001 })).toEqual([]);
    expect(agent.getSessionData("child").parent_reference).toEqual({
      agentName: "opencode",
      sessionId: "root",
    });
  });

  it("reads more than one binding batch without losing sessions", () => {
    db.transaction(() => {
      for (let i = 0; i < 501; i++) {
        session(`s-${i}`);
        message("user", { text: `Request ${i}` }, 1, `s-${i}`);
      }
    })();
    expect(agent.scan()).toHaveLength(501);
  });

  it("preserves interleaved tool states, results, errors and a unique subagent link", () => {
    session();
    message(
      "assistant",
      {
        content: [
          { type: "text", text: "Before" },
          { ...tool("shell", "streaming"), state: { status: "streaming", input: '{"command":' } },
          tool("read", "running"),
          tool("subagent", "completed", [{ type: "text", text: "Child done" }], {
            sessionID: "child",
          }),
          tool("mcp_custom", "completed", [
            { type: "file", uri: "file:///output.txt", mime: "text/plain", name: "Output" },
          ]),
          {
            ...tool("edit", "error"),
            state: {
              status: "error",
              error: { message: "Denied" },
              content: [{ type: "text", text: "Details" }],
            },
          },
          { type: "text", text: "After" },
        ],
      },
      1,
    );
    const parsed = agent.getSessionData("root").messages[0]!;
    expect(parsed.subagent_id).toBe("child");
    expect(parsed.parts.map((part) => part.type)).toEqual([
      "text",
      "tool",
      "tool",
      "tool",
      "tool",
      "tool",
      "text",
    ]);
    expect(parsed.parts[1]).toMatchObject({
      tool: "shell",
      callID: "call-shell",
      state: { status: "running", input: '{"command":' },
    });
    expect(parsed.parts[2]).toMatchObject({ tool: "read", state: { status: "running" } });
    expect(parsed.parts[3]).toMatchObject({ state: { status: "completed", output: "Child done" } });
    expect(parsed.parts[4]).toMatchObject({
      state: { output: expect.stringContaining("file:///output.txt") },
    });
    expect(parsed.parts[5]).toMatchObject({
      state: { status: "error", output: "Details", error: { message: "Denied" } },
    });
    message(
      "assistant",
      {
        content: [
          tool("subagent", "running", [], { sessionID: "a" }),
          tool("subagent", "running", [], { sessionID: "b" }),
        ],
      },
      2,
    );
    expect(agent.getSessionData("root").messages[1]?.subagent_id).toBeUndefined();
  });

  it("retains attachments, automatic records, compactions and unknown content", () => {
    session();
    message("system", { text: "Instructions changed" }, 1);
    message("synthetic", { text: "Generated input", description: "Automatic" }, 2);
    message("skill", { name: "review", text: "Skill instructions" }, 3);
    message(
      "user",
      {
        text: "Human request",
        files: [
          { mime: "image/png", data: "aGVsbG8=" },
          { mime: "text/plain", name: "notes", source: { type: "uri", uri: "file:///notes" } },
        ],
        agents: [{ name: "explore" }],
        skills: [{ name: "review" }],
      },
      4,
    );
    message("compaction", { status: "completed", summary: "Summary", recent: "Recent" }, 5);
    message("model-switched", { model: { id: "new-model" } }, 6);
    message("idle", { outcome: "succeeded" }, 7);
    message(
      "assistant",
      { content: [{ type: "future-content", payload: "Keep me" }], error: { message: "Failed" } },
      8,
    );
    message("future-event", { text: "Future event" }, 9);
    const [head] = agent.scan();
    const detail = agent.getSessionData("root");
    expect(head?.title).toBe("Human request");
    expect(detail.messages).toHaveLength(8);
    expect(detail.messages.slice(0, 3).every((message) => message.automated)).toBe(true);
    expect(detail.messages[3]?.parts).toEqual(
      expect.arrayContaining([
        { type: "image", data: "aGVsbG8=", mime_type: "image/png" },
        { type: "text", text: expect.stringContaining("file:///notes") },
        { type: "text", text: "@explore" },
      ]),
    );
    expect(detail.messages[4]).toMatchObject({
      mode: "compaction",
      parts: [{ text: "[Compaction: completed]\n\nSummary\n\nRecent" }],
    });
    expect(JSON.stringify(detail)).toContain("Keep me");
    expect(JSON.stringify(detail)).toContain("Failed");
    expect(JSON.stringify(detail)).toContain("Future event");
  });

  it("renders shell execution outcomes and retained truncation metadata", () => {
    session();
    message(
      "shell",
      {
        command: "pnpm test",
        shellID: "sh_1",
        status: "exited",
        exit: 0,
        output: { output: "Passed", truncated: true },
      },
      1,
    );
    message("shell", { command: "false", status: "exited", exit: 1 }, 2);
    message("shell", { command: "watch", status: "running" }, 3);
    const messages = agent.getSessionData("root").messages;
    expect(messages[0]?.parts[0]).toMatchObject({
      tool: "shell",
      state: {
        status: "completed",
        output: "Passed",
        metadata: { truncated: true, shellID: "sh_1" },
      },
    });
    expect(messages[1]?.parts[0]).toMatchObject({
      state: { status: "error", error: "Shell exited (exit: 1)" },
    });
    expect(messages[2]?.parts[0]).toMatchObject({ state: { status: "running" } });
  });

  it("uses recorded session totals including zero, fork and compaction usage", () => {
    session();
    session("child", "root");
    session("fork");
    db.exec(`UPDATE session_v2 SET tokens_input = 10, tokens_output = 5, tokens_reasoning = 3,
      tokens_cache_read = 7, tokens_cache_write = 2 WHERE id = 'root';
      UPDATE session_v2 SET cost = 50 WHERE id = 'child';
      UPDATE session_v2 SET fork_session_id = 'root' WHERE id = 'fork'`);
    const original = {
      model: { id: "model-a", providerID: "provider" },
      cost: 0,
      tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 7, write: 2 } },
      content: [{ type: "text", text: "Done" }],
    };
    message("assistant", original, 1);
    message("assistant", original, 1, "fork");
    message("user", { text: "Child" }, 1, "child");
    let head = agent.scan().find((head) => head.reference.sessionId === "root")!;
    expect(head.stats).toMatchObject({
      total_cost: 0,
      cost_source: "recorded",
      total_tokens: 27,
      total_cache_read_tokens: 7,
      total_cache_create_tokens: 2,
    });
    expect(head.model_usage).toEqual({ "model-a": 27 });
    expect(agent.getSessionData("root").stats).toEqual(head.stats);
    expect(agent.getSessionData("root").messages[0]).toMatchObject({
      cost: 0,
      cost_source: "recorded",
      tokens: { reasoning: 3, cache_read: 7 },
    });
    const fork = agent.scan().find((head) => head.reference.sessionId === "fork")!;
    expect(fork.stats.total_tokens).toBe(0);
    expect(fork.model_usage).toBeUndefined();
    message(
      "compaction",
      {
        status: "completed",
        model: { id: "model-b" },
        cost: 2,
        summary: "Summary",
        tokens: { input: 4, output: 1 },
      },
      2,
    );
    db.exec(
      "UPDATE session_v2 SET cost = 2, tokens_input = 14, tokens_output = 6 WHERE id = 'root'",
    );
    head = agent.scan().find((head) => head.reference.sessionId === "root")!;
    expect(head.stats.total_cost).toBe(2);
    expect(head.model_usage).toEqual({ "model-a": 27, "model-b": 5 });
    db.exec("DELETE FROM session_message WHERE id = 'root-2'");
    expect(
      agent.scan().find((head) => head.reference.sessionId === "root")?.model_usage,
    ).toBeUndefined();
    expect(agent.getSessionData("root").stats.total_cost).toBe(2);
  });

  it("invalidates details on WAL updates, equal-length edits, usage changes and deletion", () => {
    db.pragma("journal_mode = WAL");
    session();
    message("user", { text: "aaaa" }, 1);
    const heads = agent.scan();
    const original = sessionDetailVersion(agent.snapshotSessionCacheMeta().root);
    agent.checkForChanges(0, heads);
    agent.commitChangeCheck();
    db.prepare("UPDATE session_message SET data = ?").run(JSON.stringify({ text: "bbbb" }));
    expect(agent.checkForChanges(Date.now() + 10000, heads).hasChanges).toBe(true);
    agent.scan();
    const edited = sessionDetailVersion(agent.snapshotSessionCacheMeta().root);
    expect(edited).not.toBe(original);
    agent.scan();
    expect(sessionDetailVersion(agent.snapshotSessionCacheMeta().root)).toBe(edited);
    db.exec("UPDATE session_v2 SET cost = 1");
    agent.scan();
    expect(sessionDetailVersion(agent.snapshotSessionCacheMeta().root)).not.toBe(edited);
    db.exec("DELETE FROM session_message");
    expect(agent.scan()).toEqual([]);
    const stale = new OpenCodeAgent({ sourceRoot: root });
    stale.restoreSessionCacheMeta({
      root: {
        id: "root",
        sourcePath: join(root, "opencode.db"),
        headParserVersion: "opencode-sqlite-head-v1",
      },
    });
    expect(stale.checkForChanges(Date.now() + 10000, heads).hasChanges).toBe(true);
  });

  it("refreshes an old empty cache once and retries until the refresh commits", () => {
    const future = Date.now() + 10000;
    expect(agent.checkForChanges(future, []).hasChanges).toBe(true);
    expect(agent.checkForChanges(future, []).hasChanges).toBe(true);
    agent.scan();
    agent.commitChangeCheck();
    expect(agent.checkForChanges(future, []).hasChanges).toBe(false);
  });

  it("resolves explicit, relative, absolute and unavailable database paths consistently", () => {
    session();
    message("user", { text: "Configured" }, 1);
    db.close();
    vi.stubEnv("XDG_DATA_HOME", root);
    const dataRoot = join(root, "opencode");
    mkdirSync(dataRoot);
    expect(resolveOpenCodeDataRoot()).toBe(dataRoot);
    const custom = join(dataRoot, "custom.db");
    copyFileSync(join(root, "opencode.db"), custom);
    for (const value of ["custom.db", custom]) {
      vi.stubEnv("OPENCODE_DB", value);
      const configured = new OpenCodeAgent();
      expect(configured.isAvailable()).toBe(true);
      expect(configured.scan()).toHaveLength(1);
      expect(configured.getSessionWatchPlan()).toEqual({
        status: "supported",
        targets: ["", "-wal", "-journal"].map((suffix) => ({
          path: `${custom}${suffix}`,
          pollForChanges: true,
        })),
      });
    }
    vi.stubEnv("OPENCODE_DB", "missing.db");
    expect(new OpenCodeAgent().isAvailable()).toBe(false);
    expect(new OpenCodeAgent().scan()).toEqual([]);
    expect(() => new OpenCodeAgent().getSessionData("root")).toThrow("database is missing");
    expect(agent.scan()).toHaveLength(1);
    vi.stubEnv("OPENCODE_DB", ":memory:");
    expect(new OpenCodeAgent().isAvailable()).toBe(false);
    expect(new OpenCodeAgent().getSessionWatchPlan()).toEqual({ status: "supported", targets: [] });
  });
});
