import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAgent } from "../claudecode.js";
import type { Message, MessagePart, SessionHead } from "../../types/index.js";

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
  it("detects sessions-index changes via fingerprint comparison", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-cache-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionFile = join(projectDir, "session-1.jsonl");
    const indexFile = join(projectDir, "sessions-index.json");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-20T10:00:00Z",
        cwd: "/tmp/project",
        message: { role: "user", content: "hello" },
      }),
    );
    writeFileSync(indexFile, JSON.stringify({ entries: [{ sessionId: "session-1" }] }));

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    // Seed baseline: a full scan populates metaMap with the source fingerprint.
    agent.scan();
    const baselineFingerprint = agent.listSessionSources()[0]?.fingerprint;
    expect(baselineFingerprint).toBeDefined();

    // No changes yet.
    const unchanged = agent.checkForChanges(Date.now(), [makeSession("session-1")]);
    expect(unchanged.hasChanges).toBe(false);

    // Rewrite the index file (bumps its mtime → fingerprint changes).
    const later = new Date(Date.now() + 2000);
    writeFileSync(indexFile, JSON.stringify({ entries: [{ sessionId: "session-1" }] }), {
      flag: "w",
    });
    utimesSync(indexFile, later, later);

    const changed = agent.checkForChanges(Date.now(), [makeSession("session-1")]);
    expect(changed.hasChanges).toBe(true);
    expect(changed.changedIds).toContain("session-1");
    // The fingerprint now reflects the new index mtime.
    expect(agent.listSessionSources()[0]?.fingerprint).not.toBe(baselineFingerprint);
  });

  it("bounds listSessionSources to the mtime window when options are passed", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-window-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    mkdirSync(projectDir, { recursive: true });

    const oldFile = join(projectDir, "old-session.jsonl");
    const newFile = join(projectDir, "new-session.jsonl");
    writeFileSync(oldFile, "");
    writeFileSync(newFile, "");

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newTime = new Date();
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    expect(
      agent
        .listSessionSources()
        .map((ref: { sessionId: string }) => ref.sessionId)
        .sort(),
    ).toEqual(["new-session", "old-session"]);

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref: { sessionId: string }) => ref.sessionId)).toEqual(["new-session"]);
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
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: [
                  { text: "package output" },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
                  },
                ],
              },
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
    const readTool = assistant?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "Read",
    );

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
    expect(data.messages.map((message: Message) => message.role)).toEqual([
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
        output: [
          { type: "text", text: "package output" },
          { type: "image", data: "iVBORw0KGgo=", mime_type: "image/png" },
        ],
        status: "success",
        meta: { commandName: "read" },
      },
    });
    expect(
      assistant?.parts.some(
        (part: MessagePart) => part.type === "tool" && part.tool === "TodoWrite",
      ),
    ).toBe(false);
    expect(data.messages[2]?.parts).toMatchObject([{ type: "text", text: "Continue" }]);
    expect(data.messages[3]).toMatchObject({
      role: "tool",
      parts: [{ type: "text", text: "detached output" }],
    });
  });

  it("counts repeated Claude request usage once across assistant fragments", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "session-fragments";
    const sessionFile = join(projectDir, `${sessionId}.jsonl`);
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      output_tokens: 20,
    };

    mkdirSync(projectDir, { recursive: true });
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
          uuid: "assistant-thinking",
          parentUuid: "user-1",
          requestId: "req-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage,
            content: [{ type: "thinking", thinking: "Need file list" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-tool",
          parentUuid: "assistant-thinking",
          requestId: "req-1",
          timestamp: "2026-04-20T10:00:02Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5-20250929",
            usage,
            content: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "Read",
                input: { file_path: "package.json" },
              },
            ],
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(head?.stats).toMatchObject({
      total_input_tokens: 115,
      total_output_tokens: 20,
      total_cache_read_tokens: 10,
      total_cache_create_tokens: 5,
      total_cost: 0.00062175,
    });
    expect(head?.model_usage).toEqual({ "claude-sonnet-4-5-20250929": 135 });
    expect(data.stats).toMatchObject({
      total_input_tokens: 115,
      total_output_tokens: 20,
      total_cache_read_tokens: 10,
      total_cache_create_tokens: 5,
      total_cost: 0.00062175,
    });
    expect(data.messages.filter((message: Message) => (message.cost ?? 0) > 0)).toHaveLength(1);
  });

  it("filters internal-only sessions", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "internal-only.jsonl"),
      [
        JSON.stringify({
          type: "progress",
          timestamp: "2026-04-20T10:00:00Z",
          message: { role: "", content: "" },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    expect(agent.scan()).toEqual([]);
  });

  it("cleans internal tag blocks from visible messages", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-claude-test-"));
    tempDirs.push(basePath);
    const projectDir = join(basePath, "project");
    const sessionId = "tagged-session";

    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-20T10:00:00Z",
          cwd: "/tmp/project",
          message: {
            role: "user",
            content:
              "Visible request\n<command-name>clear</command-name>\n<local-command-stdout>noise</local-command-stdout>",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-20T10:00:01Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Visible answer <system-reminder>hidden</system-reminder>",
              },
            ],
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new ClaudeCodeAgent() as any;
    agent.basePath = basePath;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(head?.title).toBe("Visible request");
    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible answer" }),
    ]);
  });
});
