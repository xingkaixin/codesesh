import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "../claudecode.js";
import type { SessionHead } from "../../types/index.js";

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `claudecode/${id}`,
    title: id,
    directory: "/tmp/project",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("ClaudeCodeAgent cache refresh", () => {
  it("revalidates recent sessions and invalidates sessions index cache", () => {
    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = "/tmp/claudecode";
    agent.sessionsIndexCache = { project: new Map([["stale", {}]]) };
    agent.sessionMetaMap = new Map([
      [
        "session-1",
        {
          id: "session-1",
          title: "Old",
          sourcePath: "/tmp/claudecode/project/session-1.jsonl",
          directory: "/tmp/project",
          model: null,
          messageCount: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    ]);

    const now = Date.now();
    const result = agent.checkForChanges(now, [
      makeSession("session-1", { time_created: now - 60_000 }),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("session-1");
    expect(agent.sessionsIndexCache.project).toBeUndefined();
  });

  it("parses indexed sessions with assistant tools and tool results", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "session-1";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sessions-index.json"),
      JSON.stringify({
        entries: [{ sessionId, summary: "Indexed summary" }],
      }),
    );
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: { role: "user", content: "Inspect the repository" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
              output_tokens: 20,
            },
            content: [
              { type: "thinking", thinking: "Need file list" },
              { type: "text", text: "Reading package metadata" },
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "package.json" },
              },
              { type: "tool_use", id: "todo-1", name: "TodoWrite", input: {} },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "user-2",
          timestamp: "2026-04-20T10:00:02Z",
          sourceToolAssistantUUID: "assistant-1",
          toolUseResult: { success: true, commandName: "read" },
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "tool-1", content: [{ text: "package output" }] },
              { type: "text", text: "Continue" },
            ],
          },
        }),
        JSON.stringify({
          type: "tool_result",
          uuid: "tool-fallback",
          timestamp: "2026-04-20T10:00:03Z",
          message: { content: [{ text: "detached output" }] },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const assistant = data.messages[1];
    const readTool = assistant?.parts.find((part) => part.type === "tool" && part.tool === "Read");

    expect(head).toMatchObject({
      id: sessionId,
      title: "Indexed summary",
      directory: "/tmp/project",
      stats: {
        message_count: 3,
        total_input_tokens: 115,
        total_output_tokens: 20,
        total_cache_read_tokens: 10,
        total_cache_create_tokens: 5,
      },
      model_usage: { "claude-sonnet-4-5-20250929": 135 },
    });
    expect(data.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "tool",
    ]);
    expect(assistant).toMatchObject({
      agent: "claude",
      model: "claude-sonnet-4-5-20250929",
      tokens: { input: 115, output: 20, cache_read: 10, cache_create: 5 },
      cost_source: "estimated",
    });
    expect(assistant?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need file list",
    });
    expect(assistant?.parts[1]).toMatchObject({
      type: "text",
      text: "Reading package metadata",
    });
    expect(readTool).toMatchObject({
      type: "tool",
      callID: "tool-1",
      state: {
        input: { file_path: "package.json" },
        output: [{ type: "text", text: "package output" }],
        status: "success",
        meta: { commandName: "read" },
      },
    });
    expect(assistant?.parts.some((part) => part.type === "tool" && part.tool === "TodoWrite")).toBe(
      false,
    );
    expect(data.messages[2]?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
    expect(data.messages[3]).toMatchObject({
      role: "tool",
      parts: [{ type: "text", text: "detached output" }],
    });
  });
});
