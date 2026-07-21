import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAgent } from "../opencode.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

let tempDirs: string[] = [];

function createOpenCodeDb(tempDir: string): string {
  const dbPath = join(tempDir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      slug TEXT,
      directory TEXT,
      version TEXT,
      summary_files TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      data TEXT,
      time_created INTEGER
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

describe("OpenCodeAgent parsing", () => {
  it("keeps sessions when the message table is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "opencode.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        slug TEXT,
        directory TEXT,
        version TEXT,
        summary_files TEXT
      );
    `);
    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
    ).run("legacy-session", "Legacy session", 1_000, 2_000, "/tmp/project");
    db.close();

    const agent = new OpenCodeAgent() as any;
    agent.dbPath = dbPath;

    const [head] = agent.scan({ from: 0 });

    expect(head).toMatchObject({
      id: "legacy-session",
      title: "Legacy session",
      stats: { message_count: 0 },
    });
  });

  it("cleans internal tags and filters empty messages", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-test-"));
    tempDirs.push(tempDir);
    const dbPath = createOpenCodeDb(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
    ).run("session-1", "", 1_000, 2_000, "/tmp/project");
    db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "empty-message",
      "session-1",
      JSON.stringify({ role: "assistant" }),
      1_000,
    );
    db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "step-part",
      "empty-message",
      JSON.stringify({ type: "step-start" }),
      1_000,
    );
    db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "user-message",
      "session-1",
      JSON.stringify({ role: "user" }),
      1_100,
    );
    db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "user-part",
      "user-message",
      JSON.stringify({
        type: "text",
        text: "Visible request\n<command-name>clear</command-name>",
      }),
      1_100,
    );
    db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "assistant-message",
      "session-1",
      JSON.stringify({ role: "assistant" }),
      1_200,
    );
    db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "tool-part",
      "assistant-message",
      JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: "call-1",
        title: "Tool: bash",
        state: {
          output: "Visible output\n<local-command-stdout>noise</local-command-stdout>",
        },
      }),
      1_200,
    );
    db.close();

    const agent = new OpenCodeAgent() as any;
    agent.dbPath = dbPath;

    const data = agent.getSessionData("session-1");

    expect(data.title).toBe("Visible request");
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        output: "Visible output",
      },
    });
  });

  it("falls back on a malformed role/tokens shape and reports drift under the opencode agent name", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-test-"));
    tempDirs.push(tempDir);
    const dbPath = createOpenCodeDb(tempDir);
    const db = new Database(dbPath);

    db.prepare(
      "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
    ).run("session-drift", "", 1_000, 2_000, "/tmp/project");
    db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "m1",
      "session-drift",
      JSON.stringify({ role: "narrator", tokens: "not-an-object" }),
      1_000,
    );
    db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
      "p1",
      "m1",
      JSON.stringify({ type: "text", text: "hello" }),
      1_000,
    );
    db.close();

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = new OpenCodeAgent() as any;
    agent.dbPath = dbPath;

    const data = agent.getSessionData("session-drift");

    expect(data.messages[0]).toMatchObject({ role: "assistant", tokens: undefined });
    expect(calls).toEqual(
      expect.arrayContaining([
        {
          event: "agent.field_shape_mismatch",
          detail: { agentName: "opencode", field: "message.role" },
        },
        {
          event: "agent.field_shape_mismatch",
          detail: { agentName: "opencode", field: "message.tokens" },
        },
      ]),
    );
  });
});
