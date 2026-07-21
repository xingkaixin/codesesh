import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ZCodeAgent } from "../zcode.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

let tempDirs: string[] = [];

function createZCodeDb(tempDir: string): string {
  const dbPath = join(tempDir, "db.sqlite");
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

    const agent = new ZCodeAgent() as any;
    agent.dbPath = dbPath;

    const [head] = agent.scan({ from: 0 });
    const data = agent.getSessionData("sess_1");

    expect(agent.getUri("sess_1")).toBe("zcode://sess_1");
    expect(head).toMatchObject({
      id: "sess_1",
      slug: "zcode/sess_1",
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
      id: "sess_1",
      slug: "zcode/sess_1",
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

    const agent = new ZCodeAgent() as any;
    agent.dbPath = dbPath;

    const data = agent.getSessionData("sess_drift");

    expect(data.messages[0]).toMatchObject({ role: "user", model: null });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "zcode", field: "message.modelID" },
    });
  });
});
