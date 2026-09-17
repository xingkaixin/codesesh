import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeepChatAgent } from "../deepchat.js";
import { sessionDetailVersion } from "../../discovery/cache/detail-version.js";

let root: string;
let dbPath: string;
let db: Database.Database;
let agent: DeepChatAgent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codesesh-deepchat-"));
  mkdirSync(join(root, "app_db"));
  dbPath = join(root, "app_db", "agent.db");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE new_sessions (
      id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, project_dir TEXT,
      parent_session_id TEXT, is_draft INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000, revision INTEGER DEFAULT 0
    );
    CREATE TABLE deepchat_sessions (id TEXT PRIMARY KEY, model_id TEXT, provider_id TEXT);
    CREATE TABLE deepchat_messages (
      id TEXT PRIMARY KEY, session_id TEXT, order_seq INTEGER, role TEXT, content TEXT,
      metadata TEXT, status TEXT DEFAULT 'sent', created_at INTEGER, updated_at INTEGER
    );
    CREATE INDEX message_session ON deepchat_messages(session_id, order_seq);
    CREATE TABLE deepchat_assistant_blocks (
      message_id TEXT, block_index INTEGER, block_type TEXT, status TEXT, text_content TEXT,
      tool_call_id TEXT, tool_name TEXT, tool_params TEXT, tool_response TEXT,
      image_mime_type TEXT, extra_json TEXT, updated_at INTEGER,
      PRIMARY KEY(message_id, block_index)
    );
    CREATE TABLE deepchat_user_messages (message_id TEXT PRIMARY KEY, text TEXT);
    CREATE TABLE deepchat_user_message_files (message_id TEXT, ordinal INTEGER, path TEXT, name TEXT);
    CREATE TABLE deepchat_user_message_links (message_id TEXT, ordinal INTEGER, url TEXT);
    CREATE TABLE deepchat_usage_stats (
      usage_id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT,
      model_id TEXT, provider_id TEXT, input_tokens INTEGER, output_tokens INTEGER,
      total_tokens INTEGER, cached_input_tokens INTEGER, cache_write_input_tokens INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
  `);
  agent = new DeepChatAgent({ sourceRoot: root });
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

function insertSession(id: string, agentId = "deepchat", parent: string | null = null): void {
  db.prepare(
    "INSERT INTO new_sessions (id, agent_id, title, project_dir, parent_session_id) VALUES (?, ?, ?, ?, ?)",
  ).run(id, agentId, `Session ${id}`, "/work/project", parent);
  if (agentId === "deepchat") {
    db.prepare("INSERT INTO deepchat_sessions VALUES (?, ?, ?)").run(
      id,
      "claude-sonnet-4-6",
      "anthropic",
    );
  }
}

function insertMessage(row: {
  id: string;
  sessionId: string;
  role?: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
  order?: number;
  updatedAt?: number;
}): void {
  db.prepare(`INSERT INTO deepchat_messages
    (id, session_id, role, content, metadata, order_seq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.sessionId,
    row.role ?? "assistant",
    JSON.stringify(row.content ?? []),
    JSON.stringify(row.metadata ?? {}),
    row.order ?? 1,
    1000,
    row.updatedAt ?? 3000,
  );
}

describe("DeepChatAgent", () => {
  it("replays structured content and counts recorded usage once, including compaction", () => {
    insertSession("native");
    insertMessage({
      id: "user",
      sessionId: "native",
      role: "user",
      content: { text: "stale user text" },
      order: 1,
    });
    insertMessage({
      id: "answer",
      sessionId: "native",
      order: 2,
      content: [{ type: "content", content: "stale assistant text" }],
      metadata: { inputTokens: 9999, outputTokens: 9999, model: "stale-model" },
    });
    db.exec(`
      INSERT INTO deepchat_user_messages VALUES ('user', 'Read the attached file');
      INSERT INTO deepchat_user_message_files VALUES ('user', 0, '/work/project/input.txt', 'input.txt');
      INSERT INTO deepchat_user_message_links VALUES ('user', 0, 'https://example.com/reference');
      INSERT INTO deepchat_assistant_blocks
        (message_id, block_index, block_type, status, text_content, updated_at) VALUES
        ('answer', 0, 'reasoning_content', 'success', 'Checking the file', 3500),
        ('answer', 2, 'content', 'success', 'File checked', 4000);
      INSERT INTO deepchat_assistant_blocks
        (message_id, block_index, block_type, status, tool_call_id, tool_name, tool_params, tool_response, updated_at)
        VALUES ('answer', 1, 'tool_call', 'success', 'call-1', 'read_file', '{"path":"input.txt"}', 'file body', 3600);
      INSERT INTO deepchat_usage_stats VALUES
        ('chat-answer', 'native', 'answer', 'claude-sonnet-4-6', 'anthropic', 1300, 200, 1500, 200, 100, 3000, 3000),
        ('compaction-call', 'native', NULL, 'claude-sonnet-4-6', 'anthropic', 100, 10, 110, 0, 0, 3500, 9000);
    `);
    const before = readFileSync(dbPath);
    expect(agent.isAvailable()).toBe(true);
    const head = agent.scan()[0]!;
    const detail = agent.getSessionData("native");
    expect(head).toMatchObject({
      reference: { agentName: "deepchat", sessionId: "native" },
      directory: "/work/project",
      time_updated: 4000,
      stats: {
        message_count: 2,
        total_input_tokens: 1400,
        total_output_tokens: 210,
        total_tokens: 1610,
        total_cache_read_tokens: 200,
        total_cache_create_tokens: 100,
        cost_source: "estimated",
      },
      model_usage: { "claude-sonnet-4-6": 1610 },
    });
    expect(head.stats.total_cost).toBeCloseTo(0.007185);
    expect(detail.stats).toEqual(head.stats);
    expect(detail.messages[0]!.parts).toEqual([
      { type: "text", text: "Read the attached file" },
      { type: "text", text: "Attachment: /work/project/input.txt" },
      { type: "text", text: "https://example.com/reference" },
    ]);
    expect(detail.messages[1]).toMatchObject({
      id: "answer",
      model: "claude-sonnet-4-6",
      agent: "deepchat",
      tokens: { input: 1300, output: 200, cache_read: 200, cache_create: 100 },
      parts: [
        { type: "reasoning", text: "Checking the file" },
        {
          type: "tool",
          tool: "read_file",
          callID: "call-1",
          state: { status: "completed", input: { path: "input.txt" }, output: "file body" },
        },
        { type: "text", text: "File checked" },
      ],
    });
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it("reads ACP sessions without native settings and preserves raw block fallbacks", () => {
    insertSession("acp", "codex-acp");
    insertMessage({
      id: "request",
      sessionId: "acp",
      role: "user",
      content: { text: "Run checks" },
    });
    insertMessage({
      id: "reply",
      sessionId: "acp",
      order: 2,
      metadata: { model: "acp-model", provider: "acp", inputTokens: 50, outputTokens: 10 },
      content: [
        {
          type: "tool_call",
          status: "error",
          tool_call: { id: "failed", name: "execute", params: "invalid json", response: "failed" },
        },
        {
          type: "tool_call",
          status: "loading",
          tool_call: { id: "running", name: "execute", params: '{"command":"check"}' },
        },
        { type: "image", image_data: { data: "aW1hZ2U=", mimeType: "image/png" } },
        { type: "error", content: "The check failed" },
      ],
    });
    db.prepare("UPDATE deepchat_messages SET status = 'pending' WHERE id = 'reply'").run();
    const head = agent.scan()[0]!;
    expect(head.stats).toMatchObject({
      total_input_tokens: 50,
      total_output_tokens: 10,
      total_cost: 0,
    });
    expect(agent.getSessionCacheMeta("acp")?.unpricedModels).toEqual(["acp-model"]);
    const reply = agent.getSessionData("acp").messages[1]!;
    expect(reply).toMatchObject({ agent: "codex-acp", model: "acp-model", provider: "acp" });
    expect(reply.time_completed).toBeUndefined();
    expect(reply.parts).toMatchObject([
      { type: "tool", state: { status: "error", input: "invalid json", error: "failed" } },
      { type: "tool", state: { status: "running", input: { command: "check" } } },
      { type: "image", mime_type: "image/png", data: "aW1hZ2U=" },
      { type: "text", text: "The check failed" },
    ]);
  });

  it("filters by message activity, retains related sessions and omits drafts and empty sessions", () => {
    insertSession("parent");
    insertSession("child", "deepchat", "parent");
    insertSession("grandchild", "deepchat", "child");
    insertSession("empty");
    insertSession("draft");
    insertSession("old");
    db.exec("UPDATE new_sessions SET is_draft = 1 WHERE id = 'draft'");
    for (const id of ["parent", "child", "grandchild", "draft", "old"]) {
      insertMessage({
        id: `message-${id}`,
        sessionId: id,
        updatedAt: id === "parent" ? 8000 : 3000,
      });
    }
    const heads = agent.scan({ from: 7000, to: 9000 });
    expect(heads.map((head) => head.reference.sessionId)).toEqual([
      "parent",
      "child",
      "grandchild",
    ]);
    expect(heads[1]!.parent_reference).toEqual({ agentName: "deepchat", sessionId: "parent" });
    expect(agent.scan({ from: 7000, to: 9000, includeRelatedSessions: false })).toHaveLength(1);
    expect(agent.scan({ to: 2500 })).toEqual([]);
    expect(() => agent.getSessionData("missing")).toThrow();
  });

  it("refreshes WAL writes and invalidates details when earlier messages or blocks change", () => {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    insertSession("live");
    insertMessage({ id: "earlier", sessionId: "live", order: 1, updatedAt: 3000 });
    insertMessage({ id: "latest", sessionId: "live", order: 2, updatedAt: 9000 });
    db.exec(`INSERT INTO deepchat_assistant_blocks
      (message_id, block_index, block_type, status, text_content, updated_at)
      VALUES ('earlier', 0, 'content', 'loading', 'first', 3000)`);
    const first = agent.scan();
    agent.checkForChanges(0, first);
    agent.commitChangeCheck();
    const version = sessionDetailVersion(agent.getSessionCacheMeta("live"));
    expect(agent.checkForChanges(Date.now(), first).hasChanges).toBe(false);
    const databaseBefore = readFileSync(dbPath);
    db.exec(
      "UPDATE deepchat_assistant_blocks SET text_content = 'streamed', updated_at = 4000 WHERE message_id = 'earlier'",
    );
    expect(readFileSync(dbPath)).toEqual(databaseBefore);
    expect(agent.checkForChanges(Date.now(), first).hasChanges).toBe(true);
    const second = agent.scan();
    expect(second[0]!.time_updated).toBe(9000);
    expect(sessionDetailVersion(agent.getSessionCacheMeta("live"))).not.toBe(version);
    expect(agent.getSessionData("live").messages[0]!.parts[0]).toMatchObject({ text: "streamed" });
    const secondVersion = sessionDetailVersion(agent.getSessionCacheMeta("live"));
    db.exec(
      "UPDATE deepchat_messages SET metadata = '{\"inputTokens\":42}', updated_at = 4500 WHERE id = 'earlier'",
    );
    expect(agent.scan()[0]!.stats.total_input_tokens).toBe(42);
    expect(sessionDetailVersion(agent.getSessionCacheMeta("live"))).not.toBe(secondVersion);
    db.exec("DELETE FROM new_sessions WHERE id = 'live'");
    expect(agent.scan()).toEqual([]);
  });

  it("reports unsupported databases instead of treating unreadable history as an empty scan", () => {
    db.close();
    writeFileSync(dbPath, "encrypted or invalid database");
    expect(agent.isAvailable()).toBe(true);
    expect(() => agent.scan()).toThrow("unencrypted DeepChat agent.db");
    rmSync(dbPath);
    expect(agent.isAvailable()).toBe(false);
    expect(agent.scan()).toEqual([]);
    expect(() => agent.getSessionData("missing")).toThrow("agent.db is missing");
  });
});
