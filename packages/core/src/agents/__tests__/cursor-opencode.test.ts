import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAgent } from "../cursor.js";
import { OpenCodeAgent } from "../opencode.js";
import type { MessagePart } from "../../types/index.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("SQLite-backed agent parse contracts", () => {
  it("cleans Cursor messages and resolves title/tool names consistently", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "state.vscdb");
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
      db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(
        "composerData:composer-1",
        JSON.stringify({ composerId: "composer-1", createdAt: 1000, updatedAt: 2000 }),
      );
      db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(
        "bubbleId:composer-1:1",
        JSON.stringify({
          type: 1,
          text: "Visible request\n<command-name>clear</command-name>",
        }),
      );
      db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(
        "bubbleId:composer-1:2",
        JSON.stringify({
          type: 2,
          text: "Visible answer <system-reminder>hidden</system-reminder>",
          toolFormerData: {
            name: "read_file_v2",
            toolCallId: "call-1",
            status: "completed",
            result: '{"contents":"ok"}',
          },
        }),
      );
      db.prepare("INSERT INTO cursorDiskKV(key, value) VALUES (?, ?)").run(
        "bubbleId:composer-1:3",
        JSON.stringify({ type: 1, eventType: "progress", text: "noise" }),
      );
    } finally {
      db.close();
    }

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.buildWorkspacePathMap = () => new Map([["composer-1", "/tmp/project"]]);

    const [head] = agent.scan({ from: 0 });
    const data = agent.getSessionData("composer-1");
    const tool = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(head?.title).toBe("Visible request");
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Visible answer",
    });
    expect(tool).toMatchObject({ type: "tool", tool: "read", title: "Tool: read" });
  });

  it("cleans OpenCode messages and filters empty/internal parts", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-opencode-test-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "opencode.db");
    const db = new Database(dbPath);
    try {
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
          time_created INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          time_created INTEGER,
          data TEXT
        );
      `);
      db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "session-1",
        "",
        1000,
        2000,
        "",
        "/tmp/project",
        null,
        null,
      );
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
        "m1",
        "session-1",
        1000,
        JSON.stringify({ role: "user" }),
      );
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        "p1",
        "m1",
        1000,
        JSON.stringify({
          type: "text",
          text: "Visible request\n<local-command-stdout>noise</local-command-stdout>",
        }),
      );
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
        "m2",
        "session-1",
        1500,
        JSON.stringify({ role: "assistant", type: "progress" }),
      );
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        "p2",
        "m2",
        1500,
        JSON.stringify({ type: "progress", text: "noise" }),
      );
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
        "m3",
        "session-1",
        2000,
        JSON.stringify({ role: "assistant" }),
      );
      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        "p3",
        "m3",
        2000,
        JSON.stringify({
          type: "tool",
          tool: "bash",
          title: "Tool: bash",
          state: {
            output: [
              {
                type: "text",
                text: "Visible output\n<local-command-stdout>noise</local-command-stdout>",
              },
            ],
          },
        }),
      );
    } finally {
      db.close();
    }

    const agent = new OpenCodeAgent() as any;
    agent.dbPath = dbPath;

    const [head] = agent.scan({ from: 0 });
    const data = agent.getSessionData("session-1");
    const tool = data.messages[1]?.parts[0];

    expect(head?.title).toBe("Visible request");
    expect(head?.stats.message_count).toBe(2);
    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(tool).toMatchObject({
      type: "tool",
      state: {
        output: [expect.objectContaining({ type: "text", text: "Visible output" })],
      },
    });
  });
});
