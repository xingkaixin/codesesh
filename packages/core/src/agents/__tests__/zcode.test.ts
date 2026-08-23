import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeAgent } from "../zcode.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";
import { buildSessionTree } from "../../contract/session-tree.js";

let tempDirs: string[] = [];

function createZCodeDb(tempDir: string): string {
  const databaseDir = join(tempDir, "cli", "db");
  mkdirSync(databaseDir, { recursive: true });
  const dbPath = join(databaseDir, "db.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      path TEXT,
      version TEXT,
      summary_files INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  db.close();
  return dbPath;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  setCoreDiagnostics(null);
});

function createZCodeDbWithSubagent(tempDir: string): string {
  const databaseDir = join(tempDir, "cli", "db");
  mkdirSync(databaseDir, { recursive: true });
  const dbPath = join(databaseDir, "db.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      path TEXT,
      version TEXT,
      summary_files INTEGER,
      task_type TEXT,
      parent_id TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  db.close();
  return dbPath;
}

function insertMessage(
  db: Database.Database,
  id: string,
  sessionId: string,
  data: Record<string, unknown>,
  timeCreated: number,
) {
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, timeCreated, timeCreated, JSON.stringify(data));
}

function insertTextPart(
  db: Database.Database,
  id: string,
  messageId: string,
  sessionId: string,
  text: string,
  timeCreated: number,
) {
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, messageId, sessionId, timeCreated, timeCreated, JSON.stringify({ type: "text", text }));
}

describe("ZCodeAgent parsing", () => {
  it("reads ZCode SQLite sessions through the OpenCode-compatible schema", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-test-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDb(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sess_1", "", 1_000, 2_000, "/tmp/project", "/tmp/project", "0.14.8", 3);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_user",
      "sess_1",
      1_000,
      1_000,
      JSON.stringify({
        role: "user",
        tokens: { input: 10, output: 0 },
        cost: 0.01,
        modelID: "GLM-5.2",
        providerID: "zai",
      }),
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "part_user",
      "msg_user",
      "sess_1",
      1_000,
      1_000,
      JSON.stringify({ type: "text", text: "Build the ZCode adapter" }),
    );
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "msg_assistant",
      "sess_1",
      1_500,
      1_500,
      JSON.stringify({
        role: "assistant",
        tokens: { input: 20, output: 30 },
        modelID: "GLM-5.2",
        providerID: "zai",
      }),
    );
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "part_tool",
      "msg_assistant",
      "sess_1",
      1_500,
      1_500,
      JSON.stringify({
        type: "tool",
        tool: "Bash",
        callID: "call_1",
        state: { status: "completed", output: "ok" },
      }),
    );
    db.close();

    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const [head] = agent.scan({ from: 0 });
    const data = agent.getSessionData("sess_1");

    expect(agent.getUri("sess_1")).toBe("zcode://sess_1");
    expect(head).toMatchObject({
      reference: { agentName: "zcode", sessionId: "sess_1" },
      title: "Build the ZCode adapter",
      directory: "/tmp/project",
      stats: {
        message_count: 2,
        total_input_tokens: 30,
        total_output_tokens: 30,
        total_cost: 0.01,
        cost_source: "recorded",
      },
    });
    expect(data).toMatchObject({
      reference: { agentName: "zcode", sessionId: "sess_1" },
      title: "Build the ZCode adapter",
      version: "0.14.8",
      summary_files: 3,
    });
    expect(data.messages[0]).toMatchObject({
      role: "user",
      model: "GLM-5.2",
      provider: "zai",
    });
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "tool",
      tool: "Bash",
      callID: "call_1",
      state: { status: "completed", output: "ok" },
    });
  });

  it("falls back to null and reports drift under the zcode agent name when modelID isn't a string", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-test-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDb(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sess_drift", "", 1_000, 2_000, "/tmp/project", "/tmp/project", "0.14.8", 0);
    db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run("msg_user", "sess_drift", 1_000, 1_000, JSON.stringify({ role: "user", modelID: 12345 }));
    db.prepare(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "part_user",
      "msg_user",
      "sess_drift",
      1_000,
      1_000,
      JSON.stringify({ type: "text", text: "hello" }),
    );
    db.close();

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const data = agent.getSessionData("sess_drift");

    expect(data.messages[0]).toMatchObject({ role: "user", model: null });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "zcode", field: "message.modelID" },
    });
  });
});

describe("ZCodeAgent subagent folding", () => {
  it("returns child sessions and folds their tokens into the parent", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-subagent-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDbWithSubagent(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "parent",
      "",
      1_000,
      2_000,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      1,
      "interactive",
      null,
    );
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "child",
      "",
      1_100,
      1_500,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      0,
      "subagent_child",
      "parent",
    );

    insertMessage(
      db,
      "msg_parent",
      "parent",
      { role: "user", tokens: { input: 10, output: 0 } },
      1_000,
    );
    insertTextPart(db, "part_parent", "msg_parent", "parent", "hi", 1_000);
    insertMessage(
      db,
      "msg_child",
      "child",
      { role: "assistant", tokens: { input: 40, output: 60 } },
      1_200,
    );
    insertTextPart(db, "part_child", "msg_child", "child", "working", 1_200);
    const insertHistoricalChild = db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    db.transaction(() => {
      for (let index = 0; index < 1_000; index += 1) {
        insertHistoricalChild.run(
          `historical-child-${index}`,
          "Old child",
          index,
          index,
          "/tmp/project",
          "/tmp/project",
          "0.14.8",
          0,
          "subagent_child",
          "missing-historical-root",
        );
      }
    })();
    db.close();

    const diagnostics: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => diagnostics.push({ event, detail }),
      warn: () => {},
    });
    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const heads = agent.scan({ from: 0 });
    expect(heads.map((head: any) => head.reference.sessionId)).toEqual(["parent", "child"]);
    const head = heads[0]!;
    expect(head.stats).toMatchObject({
      message_count: 1,
      total_input_tokens: 10,
      total_output_tokens: 0,
    });
    expect(head.parent_reference).toBeUndefined();
    expect(heads[1]!.parent_reference).toEqual({ agentName: "zcode", sessionId: "parent" });
    expect(heads[1]!.stats).toMatchObject({ message_count: 1, total_input_tokens: 40 });
    expect(buildSessionTree(heads).roots[0]?.inclusiveStats).toMatchObject({
      inputTokens: 50,
      outputTokens: 60,
    });
    expect(diagnostics).toContainEqual({
      event: "agent.related_sessions.query",
      detail: expect.objectContaining({
        agent_name: "zcode",
        root_count: 1,
        candidate_rows: 1,
        related_rows: 1,
      }),
    });
  });

  it("folds child tokens into getSessionData detail stats without surfacing child messages", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-subagent-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDbWithSubagent(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "parent",
      "",
      1_000,
      2_000,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      1,
      "interactive",
      null,
    );
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "child",
      "",
      1_100,
      1_500,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      0,
      "subagent_child",
      "parent",
    );

    insertMessage(
      db,
      "msg_parent",
      "parent",
      { role: "user", tokens: { input: 10, output: 0 } },
      1_000,
    );
    insertTextPart(db, "part_parent", "msg_parent", "parent", "hi", 1_000);
    insertMessage(
      db,
      "msg_child",
      "child",
      { role: "assistant", tokens: { input: 40, output: 60 } },
      1_200,
    );
    insertTextPart(db, "part_child", "msg_child", "child", "working", 1_200);
    db.close();

    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const data = agent.getSessionData("parent");
    expect(data.stats).toMatchObject({
      message_count: 1,
      total_input_tokens: 50,
      total_output_tokens: 60,
    });
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]!.id).toBe("msg_parent");

    const child = agent.getSessionData("child");
    expect(child.parent_reference).toEqual({ agentName: "zcode", sessionId: "parent" });
    expect(child.messages).toHaveLength(1);
  });

  it("aggregates tokens across multiple children", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-subagent-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDbWithSubagent(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "parent",
      "",
      1_000,
      3_000,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      1,
      "interactive",
      null,
    );
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "child_a",
      "",
      1_100,
      1_500,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      0,
      "subagent_child",
      "parent",
    );
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files, task_type, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "child_b",
      "",
      2_000,
      2_500,
      "/tmp/project",
      "/tmp/project",
      "0.14.8",
      0,
      "subagent_child",
      "parent",
    );

    insertMessage(
      db,
      "msg_parent",
      "parent",
      { role: "user", tokens: { input: 5, output: 5 } },
      1_000,
    );
    insertTextPart(db, "part_parent", "msg_parent", "parent", "hi", 1_000);
    insertMessage(
      db,
      "msg_a",
      "child_a",
      { role: "assistant", tokens: { input: 30, output: 10 } },
      1_200,
    );
    insertTextPart(db, "part_a", "msg_a", "child_a", "a", 1_200);
    insertMessage(
      db,
      "msg_b",
      "child_b",
      { role: "assistant", tokens: { input: 20, output: 20 } },
      2_100,
    );
    insertTextPart(db, "part_b", "msg_b", "child_b", "b", 2_100);
    db.close();

    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const head = agent.scan({ from: 0 })[0]!;
    expect(head.stats).toMatchObject({
      message_count: 1,
      total_input_tokens: 5,
      total_output_tokens: 5,
    });

    const data = agent.getSessionData("parent");
    expect(data.stats.total_input_tokens).toBe(55);
    expect(data.stats.total_output_tokens).toBe(35);
    expect(data.messages).toHaveLength(1);
  });

  it("does not fold when task_type/parent_id columns are absent (OpenCode baseline)", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-zcode-subagent-"));
    tempDirs.push(tempDir);
    const dbPath = createZCodeDb(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory, path, version, summary_files) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("only", "", 1_000, 2_000, "/tmp/project", "/tmp/project", "0.14.8", 1);
    insertMessage(
      db,
      "msg_only",
      "only",
      { role: "user", tokens: { input: 10, output: 0 } },
      1_000,
    );
    insertTextPart(db, "part_only", "msg_only", "only", "hi", 1_000);
    db.close();

    const agent = new ZCodeAgent({ sourceRoot: tempDir });

    const head = agent.scan({ from: 0 })[0]!;
    expect(head.reference.sessionId).toBe("only");
    expect(head.stats).toMatchObject({ total_input_tokens: 10, total_output_tokens: 0 });
    expect(agent.getSessionData("only").stats.total_input_tokens).toBe(10);
  });
});
