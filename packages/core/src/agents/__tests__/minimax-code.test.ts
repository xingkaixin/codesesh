import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MiniMaxCodeAgent, resolveMiniMaxCodeDataRoot } from "../minimax-code.js";
import { sessionDetailVersion } from "../../discovery/cache/detail-version.js";
import { extractFileActivityOccurrences } from "../../utils/file-activity.js";

let root: string;
let path: string;
let db: Database.Database;
let agent: MiniMaxCodeAgent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codesesh-minimax-"));
  mkdirSync(join(root, "v2", "sqlite"), { recursive: true });
  path = join(root, "v2", "sqlite", "runtime-state.sqlite");
  db = new Database(path);
  db.exec(`
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY, columnar_version INTEGER DEFAULT 3, title TEXT,
      workspace_dir TEXT DEFAULT '/work/project', parent_session_id TEXT,
      created_at_ms INTEGER DEFAULT 1000, updated_at_ms INTEGER DEFAULT 2000,
      agent_name TEXT DEFAULT 'coder', status TEXT DEFAULT 'idle', archived INTEGER DEFAULT 0,
      visibility TEXT DEFAULT 'visible', session_kind TEXT DEFAULT 'conversation',
      extra_data_json TEXT DEFAULT '{}', record_json TEXT DEFAULT '{}'
    );
    CREATE TABLE local_runtime_message_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, msg_id TEXT, role TEXT,
      turn_id TEXT, source TEXT, created_at_ms INTEGER, data_json TEXT,
      UNIQUE(session_id, msg_id)
    );
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_id TEXT, model TEXT,
      ts INTEGER DEFAULT 3000, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0, cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0, cost_usd REAL
    );
  `);
  agent = new MiniMaxCodeAgent({ sourceRoot: root });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

function session(id: string, parent: string | null = null): void {
  db.prepare(
    "INSERT INTO local_runtime_sessions (session_id, title, parent_session_id) VALUES (?, ?, ?)",
  ).run(id, `Session ${id}`, parent);
}

function message(
  id: string,
  data: Record<string, unknown>,
  sessionId = "root",
  turn = "turn-1",
): void {
  db.prepare(`INSERT INTO local_runtime_message_rows
    (session_id, msg_id, role, turn_id, source, created_at_ms, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId,
    id,
    data.role ?? "assistant",
    turn,
    data.source ?? "user",
    data.timestamp ?? 2500,
    JSON.stringify({ ...data, msg_id: id }),
  );
}

function call(name: string, status: number, input: unknown, output?: unknown) {
  return {
    tool_name: name,
    tool_call_id: `call-${name}`,
    tool_call_status: status,
    tool_call_args: JSON.stringify(input),
    tool_call_result_data: JSON.stringify(output),
  };
}

describe("MiniMaxCodeAgent", () => {
  it("reads columnar metadata, messages and usage without changing the source", () => {
    session("root");
    db.exec(`UPDATE local_runtime_sessions SET title = '', archived = 1,
      record_json = '{"title":"obsolete","archived":true,"visibility":"hidden"}',
      extra_data_json = '{"effectiveModel":"do-not-apply-to-history"}'`);
    message("user", {
      role: "user",
      msg_content: "Check the project",
      attachments: [
        { type: "file", file_path: "/work/project/input.txt", mime_type: "text/plain" },
        { type: "image", file_path: "https://example.com/input.png", mime_type: "image/png" },
      ],
    });
    message("tools", {
      thinking_content: "Inspect the source",
      tool_calls: [
        call("read", 2, { path: "input.txt" }, { text: "file body" }),
        call(
          "task",
          2,
          { agent_name: "reviewer" },
          { text: "Reviewed", details: { sub_session_id: "child" } },
        ),
      ],
    });
    message("answer", {
      msg_content: "Looks good",
      finish_reason: "stop",
      usage: { input_tokens: 99999 },
    });
    message("compact", { kind: "compaction", timestamp: 3500 });
    db.exec(`INSERT INTO local_runtime_token_usage
      (session_id, turn_id, model, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      VALUES ('root', 'turn-1', 'minimax/MiniMax-M3', 100, 20, 5, 40, 10, 0.025),
      ('root', 'turn-1', 'minimax/MiniMax-M3', 50, 10, 0, 0, 0, 0);`);
    const before = readFileSync(path);
    expect(agent.isAvailable()).toBe(true);
    const [head] = agent.scan();
    const detail = agent.getSessionData("root");
    expect(head).toMatchObject({
      reference: { agentName: "minimax-code", sessionId: "root" },
      title: "Check the project",
      directory: "/work/project",
      time_updated: 3500,
      stats: {
        message_count: 4,
        total_input_tokens: 150,
        total_output_tokens: 30,
        total_tokens: 235,
        total_cache_read_tokens: 40,
        total_cache_create_tokens: 10,
        total_cost: 0.025,
        cost_source: "recorded",
      },
      model_usage: { "minimax/MiniMax-M3": 235 },
    });
    expect(detail.stats).toEqual(head?.stats);
    expect(detail.messages[0]?.parts).toMatchObject([
      { type: "text", text: "Check the project" },
      { type: "text", text: "Attachment: /work/project/input.txt (text/plain)" },
      { type: "text", text: "Attachment: https://example.com/input.png (image/png)" },
    ]);
    expect(detail.messages[1]).toMatchObject({
      subagent_id: "child",
      agent: "coder",
      parts: [
        { type: "reasoning", text: "Inspect the source" },
        {
          type: "tool",
          tool: "read",
          callID: "call-read",
          state: { status: "completed", input: { path: "input.txt" } },
        },
        { type: "tool", tool: "task" },
      ],
    });
    expect(detail.messages[1]?.tokens).toBeUndefined();
    expect(detail.messages[2]).toMatchObject({
      model: "minimax/MiniMax-M3",
      tokens: {
        input: 150,
        output: 30,
        reasoning: 5,
        cache_read: 40,
        cache_create: 10,
      },
      cost: 0.025,
      cost_source: "recorded",
    });
    expect(detail.messages[3]).toMatchObject({
      mode: "compaction",
      parts: [{ type: "text", text: "Context compacted" }],
    });
    expect(readFileSync(path)).toEqual(before);
    expect(extractFileActivityOccurrences(detail.messages)[0]).toMatchObject({
      path: "input.txt",
      kind: "read",
    });
  });

  it("retains errors, incomplete tools, opaque payloads and lifecycle events", () => {
    session("root");
    message("automated", {
      role: "user",
      source: "background-task",
      msg_content: "Continue automatically",
    });
    message("tools", {
      tool_calls: [
        {
          tool_name: "mcp_invoke",
          tool_call_id: "opaque",
          tool_call_status: 4,
          tool_call_args: "{unfinished",
          tool_call_result_data: "raw output",
        },
        call("bash", 1, { command: "sleep 10" }),
        call("read", 5, { path: "file" }),
        call("edit", 3, {}, { error: "Not found" }),
        call("plugin_tool", 2, {}, { text: "Denied", isError: true }),
      ],
    });
    message("event", { kind: "review_failed", error: "Review unavailable" });
    message("future", {
      kind: "future_event",
      msg_content: "New event",
      attachments: [
        { type: "image", file_path: "/missing.png", data_url: "data:image/png;base64,unused" },
      ],
    });
    const detail = agent.getSessionData("root");
    expect(detail.messages[0]?.automated).toBe(true);
    expect(detail.messages[1]?.parts).toMatchObject([
      {
        tool: "mcp_invoke",
        state: { status: "running", input: "{unfinished", output: "raw output" },
      },
      { tool: "bash", state: { status: "running" } },
      { tool: "read", state: { status: "running" } },
      { tool: "edit", state: { status: "error", error: "Not found" } },
      { tool: "plugin_tool", state: { status: "error", error: "Denied" } },
    ]);
    expect(detail.messages[2]?.parts).toEqual([
      { type: "text", text: "Review failed" },
      { type: "text", text: "Review unavailable" },
    ]);
    expect(detail.messages[3]?.parts).toEqual([
      { type: "text", text: "Event: future_event" },
      { type: "text", text: "New event" },
      { type: "text", text: "Attachment: /missing.png" },
    ]);
  });

  it("keeps parent trees across time windows without exposing hidden roots", () => {
    for (const id of ["root", "hidden", "internal", "empty", "orphan"]) session(id);
    session("child", "root");
    session("grandchild", "child");
    for (const id of ["root", "hidden", "internal", "orphan", "child", "grandchild"])
      message(id, { msg_content: id, timestamp: 1000 }, id);
    db.exec(`UPDATE local_runtime_sessions SET visibility = 'hidden' WHERE session_id IN ('hidden', 'child');
      UPDATE local_runtime_sessions SET session_kind = 'cron' WHERE session_id = 'internal';
      UPDATE local_runtime_sessions SET parent_session_id = 'missing' WHERE session_id = 'orphan';
      UPDATE local_runtime_sessions SET updated_at_ms = 1000 WHERE session_id IN ('child', 'grandchild');`);
    expect(
      agent
        .scan({ from: 1500, to: 2500 })
        .map((head) => head.reference.sessionId)
        .sort(),
    ).toEqual(["child", "grandchild", "orphan", "root"]);
    expect(
      agent
        .scan({ from: 1500, includeRelatedSessions: false })
        .map((head) => head.reference.sessionId)
        .sort(),
    ).toEqual(["orphan", "root"]);
    expect(agent.getSessionData("child").parent_reference).toEqual({
      agentName: "minimax-code",
      sessionId: "root",
    });
  });

  it("invalidates only changed sessions after same-size edits, usage updates and removal", () => {
    for (const id of ["root", "other"]) {
      session(id);
      message(id, { msg_content: "before" }, id);
    }
    agent.scan();
    const original = agent.snapshotSessionCacheMeta();
    const version = sessionDetailVersion(original.root);
    db.exec(
      `UPDATE local_runtime_message_rows SET data_json = replace(data_json, 'before', 'after!') WHERE session_id = 'root'`,
    );
    agent.scan();
    expect(sessionDetailVersion(agent.getSessionCacheMeta("root"))).not.toBe(version);
    expect(agent.getSessionCacheMeta("other")).toEqual(original.other);
    const updated = sessionDetailVersion(agent.getSessionCacheMeta("root"));
    db.exec(
      `INSERT INTO local_runtime_token_usage (session_id, turn_id, model, input_tokens, cost_usd) VALUES ('root', 'turn-1', 'test', 1, 0);`,
    );
    agent.scan();
    expect(sessionDetailVersion(agent.getSessionCacheMeta("root"))).not.toBe(updated);
    db.exec("DELETE FROM local_runtime_message_rows WHERE session_id = 'root'");
    expect(agent.scan().map((head) => head.reference.sessionId)).toEqual(["other"]);
    expect(agent.getSessionData("root").messages).toEqual([]);
  });

  it("detects WAL writes and retains the change baseline until commit", () => {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    session("root");
    message("user", { role: "user", msg_content: "Start" });
    const heads = agent.scan();
    agent.checkForChanges(0, heads);
    agent.commitChangeCheck();
    expect(agent.checkForChanges(Date.now(), heads).hasChanges).toBe(false);
    message("answer", { msg_content: "Finished" });
    expect(agent.checkForChanges(Date.now(), heads).hasChanges).toBe(true);
    expect(agent.checkForChanges(Date.now(), heads).hasChanges).toBe(true);
    agent.commitChangeCheck();
    expect(agent.checkForChanges(Date.now(), heads).hasChanges).toBe(false);
  });

  it("preserves zero costs, estimates missing prices and does not guess ambiguous message models", () => {
    session("root");
    message("answer", { msg_content: "First" });
    message("next", { msg_content: "Second" }, "root", "turn-2");
    db.exec(`INSERT INTO local_runtime_token_usage (session_id, turn_id, model, input_tokens, output_tokens, cost_usd) VALUES
      ('root', 'turn-1', 'claude-sonnet-4-6', 100, 20, 0),
      ('root', 'turn-2', 'claude-sonnet-4-6', 100, 20, NULL),
      ('root', 'turn-2', 'unknown-model', 30, 5, NULL);`);
    const [head] = agent.scan();
    const detail = agent.getSessionData("root");
    expect(head?.stats.total_cost).toBeCloseTo(0.0006);
    expect(head?.stats.total_tokens).toBe(275);
    expect(head?.stats.cost_source).toBe("estimated");
    expect(agent.getSessionCacheMeta("root")?.unpricedModels).toContain("unknown-model");
    expect(detail.messages[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      cost: 0,
      cost_source: "recorded",
    });
    expect(detail.messages[1]?.model).toBeUndefined();
    expect(detail.messages[1]?.tokens).toBeUndefined();
  });

  it("reports incompatible schemas and corrupt messages as failures", () => {
    session("root");
    message("answer", { msg_content: "Answer" });
    agent.scan();
    const meta = agent.snapshotSessionCacheMeta();
    db.exec("UPDATE local_runtime_sessions SET columnar_version = 4");
    expect(() => agent.scan()).toThrow(/MiniMax/);
    expect(agent.snapshotSessionCacheMeta()).toEqual(meta);
    db.exec(
      "UPDATE local_runtime_sessions SET columnar_version = 3; UPDATE local_runtime_message_rows SET data_json = '{invalid'",
    );
    expect(() => agent.scan()).toThrow(/MiniMax/);
    expect(() => agent.getSessionData("missing")).toThrow(/MiniMax/);
  });

  it("honors configured roots without falling back to another installation", () => {
    vi.stubEnv("MAVIS_DATA_DIR", root);
    vi.stubEnv("MINIMAX_DATA_DIR", "  ");
    expect(resolveMiniMaxCodeDataRoot()).toBe(root);
    expect(new MiniMaxCodeAgent().isAvailable()).toBe(true);
    const missing = join(root, "missing");
    vi.stubEnv("MINIMAX_DATA_DIR", missing);
    expect(resolveMiniMaxCodeDataRoot()).toBe(missing);
    expect(new MiniMaxCodeAgent().isAvailable()).toBe(false);
    expect(new MiniMaxCodeAgent().scan()).toEqual([]);
    expect(agent.isAvailable()).toBe(true);
    expect(agent.getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: ["", "-wal", "-journal"].map((suffix) => ({
        path: `${path}${suffix}`,
        pollForChanges: true,
      })),
    });
    vi.stubEnv("MAVIS_DATA_DIR", "");
    vi.stubEnv("MINIMAX_DATA_DIR", "");
    expect(new MiniMaxCodeAgent().getSessionWatchPlan()).toEqual({
      status: "supported",
      targets: [".minimax", ".minimax-code"].flatMap((name) =>
        ["", "-wal", "-journal"].map((suffix) => ({
          path: `${join(homedir(), name, "v2", "sqlite", "runtime-state.sqlite")}${suffix}`,
          pollForChanges: true,
        })),
      ),
    });
  });
});
