import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CursorAgent } from "../cursor.js";
import type { MessagePart } from "../../types/index.js";

let tempDirs: string[] = [];

function createCursorDb(tempDir: string): string {
  const dbPath = join(tempDir, "state.vscdb");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.close();
  return dbPath;
}

function insertKv(dbPath: string, key: string, value: unknown): void {
  const db = new Database(dbPath);
  db.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  db.close();
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("CursorAgent parsing", () => {
  it("cleans internal tags and keeps normalized tool names", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:user", {
      type: 1,
      text: "Visible request\n<command-name>clear</command-name>",
      createdAt: 1_000,
    });
    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Visible answer <system-reminder>hidden</system-reminder>",
      createdAt: 2_000,
      toolFormerData: {
        name: "run_terminal_command_v2",
        toolCallId: "call-1",
        status: "completed",
        result: "Visible output\n<local-command-stdout>noise</local-command-stdout>",
      },
    });

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", {
      id: "composer-1",
      text: "Fallback title",
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const data = agent.getSessionData("composer-1");
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(data.title).toBe("Visible request");
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Visible answer",
    });
    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        output: "Visible output",
      },
    });
  });

  it("falls back to untitled when no title text is available", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-cursor-test-"));
    tempDirs.push(tempDir);
    const dbPath = createCursorDb(tempDir);

    insertKv(dbPath, "bubbleId:composer-1:assistant", {
      type: 2,
      text: "Assistant only",
      createdAt: 1_000,
    });

    const agent = new CursorAgent() as any;
    agent.dbPath = dbPath;
    agent.composerCache.set("composer-1", {
      id: "composer-1",
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const data = agent.getSessionData("composer-1");

    expect(data.title).toBe("Untitled Session");
  });
});
