import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeSqliteAgent } from "../opencode-sqlite.js";

const tempDirs: string[] = [];

function createDatabase(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-sqlite-test-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "agent.db");
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
  db.prepare(
    "INSERT INTO session (id, title, time_created, time_updated, directory) VALUES (?, ?, ?, ?, ?)",
  ).run("s1", "", 1_000, 2_000, "/workspace/project");
  db.prepare("INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "m1",
    "s1",
    JSON.stringify({
      role: "user",
      modelID: "claude-sonnet-4-6",
      providerID: "anthropic",
      tokens: { input: 1_000, output: 500 },
    }),
    1_100,
  );
  db.prepare("INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)").run(
    "p1",
    "m1",
    JSON.stringify({ type: "text", text: "Implement cache tests" }),
    1_100,
  );
  db.close();
  return dbPath;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("OpenCodeSqliteAgent", () => {
  it("builds matching heads and details through the shared SQLite adapter", () => {
    const dbPath = createDatabase();
    const agent = new OpenCodeSqliteAgent({
      name: "test-agent",
      displayName: "Test Agent",
      findDbPath: () => dbPath,
    });

    expect(agent.isAvailable()).toBe(true);
    expect(agent.scan({ from: 0 })).toEqual([
      expect.objectContaining({
        id: "s1",
        slug: "test-agent/s1",
        title: "Implement cache tests",
        stats: expect.objectContaining({
          message_count: 1,
          total_input_tokens: 1_000,
          total_output_tokens: 500,
          cost_source: "estimated",
        }),
      }),
    ]);

    expect(agent.getSessionData("s1")).toMatchObject({
      title: "Implement cache tests",
      stats: { message_count: 1, cost_source: "estimated" },
      messages: [
        {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          cost_source: "estimated",
          parts: [{ type: "text", text: "Implement cache tests" }],
        },
      ],
    });
  });
});
