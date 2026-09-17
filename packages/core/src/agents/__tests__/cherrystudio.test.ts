import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CherryStudioAgent } from "../cherrystudio.js";
import { sessionDetailVersion } from "../../discovery/cache/detail-version.js";

let root: string;
let dbPath: string;
let db: Database.Database;
let agent: CherryStudioAgent;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codesesh-cherrystudio-"));
  mkdirSync(join(root, "Data"));
  dbPath = join(root, "Data", "cherrystudio.sqlite");
  db = new Database(dbPath);
  db.exec(`
    CREATE TABLE agent_workspace (id TEXT PRIMARY KEY, path TEXT);
    INSERT INTO agent_workspace VALUES ('workspace', '/work/project');
    CREATE TABLE agent_session (
      id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT DEFAULT 'workspace',
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000,
      last_activity_at INTEGER DEFAULT 3000, deleted_at INTEGER
    );
    CREATE TABLE topic (
      id TEXT PRIMARY KEY, name TEXT, active_node_id TEXT,
      created_at INTEGER DEFAULT 1000, updated_at INTEGER DEFAULT 2000,
      last_activity_at INTEGER DEFAULT 3000, deleted_at INTEGER
    );
    CREATE TABLE agent_session_message (
      id TEXT PRIMARY KEY, session_id TEXT, role TEXT, data TEXT, stats TEXT,
      model_id TEXT, message_snapshot TEXT, status TEXT DEFAULT 'success',
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX agent_message_session ON agent_session_message(session_id, created_at, id);
    CREATE TABLE message (
      id TEXT PRIMARY KEY, topic_id TEXT, parent_id TEXT, role TEXT, data TEXT, stats TEXT,
      model_id TEXT, message_snapshot TEXT, status TEXT DEFAULT 'success',
      created_at INTEGER, updated_at INTEGER, deleted_at INTEGER
    );
    CREATE INDEX message_topic ON message(topic_id, created_at, id);
  `);
  agent = new CherryStudioAgent({ sourceRoot: root });
});

afterEach(() => {
  if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

function insertMessage(row: {
  id: string;
  conversation?: string;
  kind?: "agent" | "topic";
  parent?: string;
  role?: string;
  parts?: unknown[];
  stats?: Record<string, unknown>;
  model?: string;
  snapshot?: Record<string, unknown>;
  time?: number;
}): void {
  const table = row.kind === "topic" ? "message" : "agent_session_message";
  const column = row.kind === "topic" ? "topic_id" : "session_id";
  db.prepare(`INSERT INTO ${table}
    (id, ${column}, role, data, stats, model_id, message_snapshot, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id,
    row.conversation ?? "session",
    row.role ?? "assistant",
    JSON.stringify({ parts: row.parts ?? [{ type: "text", text: row.id }] }),
    row.stats ? JSON.stringify(row.stats) : null,
    row.model ?? null,
    row.snapshot ? JSON.stringify(row.snapshot) : null,
    row.time ?? 1000,
    row.time ?? 1000,
  );
  if (row.kind === "topic" && row.parent) {
    db.prepare("UPDATE message SET parent_id = ? WHERE id = ?").run(row.parent, row.id);
  }
}

describe("CherryStudioAgent", () => {
  it("replays Agent messages, tool states and model snapshots without writing the source", () => {
    db.exec("INSERT INTO agent_session (id, name) VALUES ('session', 'Inspect project')");
    insertMessage({
      id: "user",
      role: "user",
      time: 1000,
      parts: [
        { type: "text", text: "Read the file" },
        {
          type: "file",
          filename: "input.txt",
          url: "file:///work/input.txt",
          mediaType: "text/plain",
        },
        { type: "file", url: "file:///work/image.png", mediaType: "image/png" },
      ],
    });
    insertMessage({
      id: "answer",
      time: 2000,
      model: "stale::model",
      snapshot: {
        name: "Pi agent",
        model: { id: "claude-sonnet-4-6", provider: "anthropic" },
      },
      stats: {
        inputTokens: 1300,
        outputTokens: 200,
        totalTokens: 1500,
        inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 100 },
        outputTokenDetails: { textTokens: 150, reasoningTokens: 50 },
        costs: [
          {
            currency: "USD",
            amount: 0.25,
            providerReportedRequestCount: 1,
            computedRequestCount: 0,
          },
        ],
      },
      parts: [
        { type: "reasoning", text: "Checking the file" },
        {
          type: "tool-read",
          toolCallId: "read-1",
          state: "output-available",
          input: { path: "input.txt" },
          output: "file body",
        },
        {
          type: "dynamic-tool",
          toolName: "execute",
          toolCallId: "failed",
          state: "output-error",
          errorText: "Execution failed",
        },
        { type: "tool-write", toolCallId: "denied", state: "output-denied" },
        {
          type: "tool-read",
          toolCallId: "pending",
          state: "input-available",
          input: { path: "next.txt" },
        },
        { type: "data-agent-task-event", data: { event: "started", taskId: "task" } },
        { type: "text", text: "File checked" },
      ],
    });
    const before = readFileSync(dbPath);
    const [head] = agent.scan();
    expect(head).toMatchObject({
      reference: { agentName: "cherrystudio", sessionId: "agent:session" },
      directory: "/work/project",
      time_updated: 3000,
      stats: {
        message_count: 2,
        total_input_tokens: 1300,
        total_output_tokens: 200,
        total_cache_read_tokens: 200,
        total_cache_create_tokens: 100,
        total_tokens: 1500,
        total_cost: 0.25,
        cost_source: "recorded",
      },
      model_usage: { "claude-sonnet-4-6": 1500 },
    });
    const detail = agent.getSessionData("agent:session");
    expect(detail.stats).toEqual(head!.stats);
    expect(detail.messages[0]!.parts).toEqual([
      { type: "text", text: "Read the file" },
      { type: "text", text: "Attachment: input.txt" },
      { type: "image", url: "file:///work/image.png", mime_type: "image/png" },
    ]);
    expect(detail.messages[1]).toMatchObject({
      agent: "Pi agent",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      time_completed: 2000,
      cost: 0.25,
      tokens: { input: 1300, output: 200, reasoning: 50 },
      parts: [
        { type: "reasoning", text: "Checking the file" },
        {
          type: "tool",
          tool: "read",
          callID: "read-1",
          state: { status: "completed", input: { path: "input.txt" }, output: "file body" },
        },
        { type: "tool", tool: "execute", state: { status: "error", error: "Execution failed" } },
        { type: "tool", tool: "write", state: { status: "error" } },
        { type: "tool", tool: "read", state: { status: "running" } },
        { type: "text", text: "File checked" },
      ],
    });
    expect(readFileSync(dbPath)).toEqual(before);
  });

  it("selects the active chat branch and keeps topic IDs separate from Agent IDs", () => {
    db.exec(`INSERT INTO agent_session (id, name) VALUES ('session', 'Agent');
      INSERT INTO topic (id, name, active_node_id) VALUES ('session', 'Chat', 'reply');`);
    insertMessage({ id: "agent-message" });
    insertMessage({ id: "root", kind: "topic", role: "root", parts: [] });
    insertMessage({ id: "question", kind: "topic", role: "user", parent: "root", time: 2000 });
    insertMessage({
      id: "alternative",
      kind: "topic",
      parent: "question",
      time: 3000,
      stats: { inputTokens: 99999 },
    });
    insertMessage({
      id: "reply",
      kind: "topic",
      parent: "question",
      time: 4000,
      stats: { inputTokens: 10, outputTokens: 5 },
    });
    insertMessage({ id: "deleted", kind: "topic", parent: "reply", time: 5000 });
    db.exec("UPDATE message SET deleted_at = 6000 WHERE id = 'deleted'");
    const heads = agent.scan();
    expect(heads.map((head) => head.reference.sessionId)).toEqual([
      "agent:session",
      "topic:session",
    ]);
    const detail = agent.getSessionData("topic:session");
    expect(detail.directory).toBe(root);
    expect(detail.messages.map((message) => message.id)).toEqual(["question", "reply"]);
    expect(detail.stats).toMatchObject({
      message_count: 2,
      total_input_tokens: 10,
      total_output_tokens: 5,
    });
    db.exec("UPDATE topic SET active_node_id = NULL");
    expect(agent.scan().map((head) => head.reference.sessionId)).toEqual(["agent:session"]);
    db.exec("UPDATE topic SET active_node_id = 'reply', deleted_at = 7000");
    expect(() => agent.getSessionData("topic:session")).toThrow();
    expect(() => agent.getSessionData("agent:missing")).toThrow();
    expect(() => agent.getSessionData("session")).toThrow("Invalid Cherry Studio session");
  });

  it("uses projected usage once and estimates non-USD costs without double-counting reasoning", () => {
    db.exec("INSERT INTO agent_session (id, name) VALUES ('session', 'Usage')");
    insertMessage({ id: "user", role: "user", stats: { inputTokens: 9999, outputTokens: 9999 } });
    insertMessage({
      id: "estimate",
      model: "anthropic::claude-sonnet-4-6",
      stats: {
        inputTokens: 1000,
        outputTokens: 200,
        outputTokenDetails: { reasoningTokens: 100 },
        costs: [{ currency: "CNY", amount: 100, computedRequestCount: 1 }],
      },
    });
    insertMessage({
      id: "computed",
      stats: {
        costs: [
          {
            currency: "USD",
            amount: 0.5,
            computedRequestCount: 1,
            providerReportedRequestCount: 0,
          },
        ],
      },
    });
    insertMessage({
      id: "unknown",
      model: "custom::unpriced-cherry-model",
      stats: { inputTokens: 100, outputTokens: 10 },
    });
    db.exec("UPDATE agent_session_message SET status = 'pending' WHERE id = 'unknown'");
    const [head] = agent.scan();
    expect(head!.stats).toMatchObject({
      total_input_tokens: 1100,
      total_output_tokens: 210,
      cost_source: "estimated",
    });
    expect(head!.stats.total_cost).toBeCloseTo(0.506);
    expect(agent.getSessionCacheMeta("agent:session")?.unpricedModels).toEqual([
      "unpriced-cherry-model",
    ]);
    const unknown = agent
      .getSessionData("agent:session")
      .messages.find((message) => message.id === "unknown")!;
    expect(unknown.provider).toBe("custom");
    expect(unknown.time_completed).toBeUndefined();
  });

  it("supports earlier 2.x schemas, uses activity time and excludes empty or deleted sessions", () => {
    db.exec(`ALTER TABLE agent_session DROP COLUMN deleted_at;
      ALTER TABLE agent_session_message DROP COLUMN deleted_at;
      INSERT INTO agent_session (id, name, last_activity_at, updated_at) VALUES
        ('session', 'Older schema', 5000, 9000), ('empty', 'Empty', 5000, 9000);
      INSERT INTO topic (id, name, active_node_id, deleted_at) VALUES ('session', 'Deleted', 'topic-message', 4000);`);
    insertMessage({ id: "message" });
    insertMessage({ id: "topic-message", kind: "topic" });
    insertMessage({ id: "orphan", conversation: "missing" });
    expect(agent.scan({ from: 4500, to: 5500 }).map((head) => head.reference.sessionId)).toEqual([
      "agent:session",
    ]);
    expect(agent.scan({ from: 6000 })).toEqual([]);
  });

  it("refreshes WAL writes, earlier message edits, branch switches and removals", () => {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.exec("INSERT INTO topic (id, name, active_node_id) VALUES ('session', 'Chat', 'latest')");
    insertMessage({ id: "first", kind: "topic", role: "user" });
    insertMessage({ id: "latest", kind: "topic", parent: "first", time: 9000 });
    insertMessage({ id: "other", kind: "topic", parent: "first", time: 8000 });
    const first = agent.scan();
    agent.checkForChanges(0, first);
    agent.commitChangeCheck();
    expect(agent.checkForChanges(Date.now(), first).hasChanges).toBe(false);
    const before = readFileSync(dbPath);
    const version = sessionDetailVersion(agent.getSessionCacheMeta("topic:session"));
    db.prepare("UPDATE message SET data = ? WHERE id = 'first'").run(
      JSON.stringify({ parts: [{ type: "text", text: "edited" }] }),
    );
    expect(readFileSync(dbPath)).toEqual(before);
    expect(agent.checkForChanges(Date.now(), first).hasChanges).toBe(true);
    agent.scan();
    expect(sessionDetailVersion(agent.getSessionCacheMeta("topic:session"))).not.toBe(version);
    expect(agent.getSessionData("topic:session").messages[0]!.parts).toEqual([
      { type: "text", text: "edited" },
    ]);
    db.exec("UPDATE topic SET active_node_id = 'other'");
    expect(agent.getSessionData("topic:session").messages.map((message) => message.id)).toEqual([
      "first",
      "other",
    ]);
    db.exec("UPDATE topic SET deleted_at = 10000");
    expect(agent.scan()).toEqual([]);
  });

  it("reports corrupt content, cyclic branches and unsupported databases as scan failures", () => {
    db.exec("INSERT INTO topic (id, name, active_node_id) VALUES ('session', 'Chat', 'message')");
    insertMessage({ id: "message", kind: "topic", parent: "message" });
    expect(() => agent.scan()).toThrow("reading Cherry Studio 2.x");
    db.exec("UPDATE message SET parent_id = NULL, data = '{broken'");
    expect(() => agent.scan()).toThrow("reading Cherry Studio 2.x");
    db.exec("DROP TABLE message");
    expect(() => agent.scan()).toThrow("reading Cherry Studio 2.x");
    db.close();
    writeFileSync(dbPath, "invalid database");
    expect(agent.isAvailable()).toBe(true);
    expect(() => agent.scan()).toThrow("reading Cherry Studio 2.x");
    rmSync(dbPath);
    expect(agent.isAvailable()).toBe(false);
    expect(agent.scan()).toEqual([]);
  });
});
