import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("ClaudeCodeAgent session alias (cc-native custom-title upsert)", () => {
  let baseDir: string;
  let projectDir: string;
  let sessionFile: string;
  const sessionId = "abcd-1234";

  function readJsonl(): Array<Record<string, unknown>> {
    return readFileSync(sessionFile, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  function buildAgent(): { agent: ClaudeCodeAgent; raw: any } {
    const agent = new ClaudeCodeAgent();
    const raw = agent as any;
    raw.basePath = baseDir;
    raw.sessionsIndexCache = {};
    raw.sessionMetaMap = new Map([
      [
        sessionId,
        {
          id: sessionId,
          title: "Old",
          sourcePath: sessionFile,
          directory: "/tmp/project",
          model: null,
          messageCount: 1,
          createdAt: 1000,
          updatedAt: 1000,
        },
      ],
    ]);
    return { agent, raw };
  }

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "codesesh-claudecode-"));
    projectDir = join(baseDir, "project");
    mkdirSync(projectDir, { recursive: true });
    sessionFile = join(projectDir, `${sessionId}.jsonl`);
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("prepends a custom-title record when none exists", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          parentUuid: null,
          type: "user",
          message: { role: "user", content: "hello world" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "  My Custom Title  ");

    expect(head?.title).toBe("My Custom Title");
    const records = readJsonl();
    // The prepended row carries a timestamp copied from the file's first
    // existing record so parseSessionHead's time_created derivation doesn't
    // fall back to file mtime (which would re-anchor on every rename).
    expect(records[0]).toEqual({
      type: "custom-title",
      customTitle: "My Custom Title",
      sessionId,
      timestamp: "2026-04-25T00:00:00.000Z",
    });
    expect(records).toHaveLength(2);
  });

  it("preserves time_created across renames (no mtime drift)", () => {
    // Regression for the case where a freshly-prepended custom-title row had
    // no timestamp, causing parseSessionHead() to fall back to file mtime and
    // silently drift the session's creation time forward on every rename.
    const originalTs = "2026-03-01T00:00:00.000Z";
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          parentUuid: null,
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: originalTs,
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    // Force-set mtime far in the future so any mtime-fallback would be
    // immediately visible as drift.
    const futureMs = Date.parse("2099-01-01T00:00:00.000Z");
    utimesSync(sessionFile, futureMs / 1000, futureMs / 1000);

    const expectedMs = Date.parse(originalTs);

    const firstHead = agent.setSessionAlias(sessionId, "First name");
    expect(firstHead?.time_created).toBe(expectedMs);

    // Re-rename: the first row is now our custom-title; the replace path must
    // also preserve a timestamp so time_created still comes from the original
    // user record, not from the (refreshed) file mtime.
    utimesSync(sessionFile, futureMs / 1000 + 100, futureMs / 1000 + 100);
    const secondHead = agent.setSessionAlias(sessionId, "Second name");
    expect(secondHead?.time_created).toBe(expectedMs);

    // Clearing falls back through the precedence chain — the first user row
    // re-becomes lines[0], so its own timestamp drives time_created. Either
    // way, no mtime drift.
    const clearedHead = agent.setSessionAlias(sessionId, null);
    expect(clearedHead?.time_created).toBe(expectedMs);
  });

  it("preserves time_created when row 0 is the sole timestamp source on re-rename", () => {
    // Edge case (codex P1 follow-up): after a previous codesesh-written
    // custom-title sits at row 0 with the only valid timestamp in the file,
    // and cc has since append-on-resume'd another custom-title without a
    // timestamp at the tail. The next setSessionAlias() would otherwise call
    // findFallbackTimestamp(0), find no other row with a timestamp, and write
    // a new row 0 without one — re-triggering the original mtime drift.
    const originalTs = "2026-02-15T10:00:00.000Z";
    writeFileSync(
      sessionFile,
      [
        // Row 0: codesesh-written custom-title carrying the preserved timestamp.
        JSON.stringify({
          type: "custom-title",
          customTitle: "First name",
          sessionId,
          timestamp: originalTs,
        }),
        // Row 1: cc-appended custom-title with NO timestamp (the realistic
        // shape after a `claude --resume` against a renamed session).
        JSON.stringify({ type: "custom-title", customTitle: "cc-appended", sessionId }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const futureMs = Date.parse("2099-06-01T00:00:00.000Z");
    utimesSync(sessionFile, futureMs / 1000, futureMs / 1000);

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "Second name");

    expect(head?.time_created).toBe(Date.parse(originalTs));
    const records = readJsonl();
    // Cc's duplicate was collapsed; the surviving custom-title carries the
    // preserved timestamp from the previous row 0.
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      type: "custom-title",
      customTitle: "Second name",
      sessionId,
      timestamp: originalTs,
    });
  });

  it("collapses cc's append-on-resume duplicates into a single fresh row", () => {
    // cc itself writes a new custom-title row on every resume, so a long-lived
    // session may accumulate several of them. setSessionAlias should leave at
    // most one row behind regardless of how many were there before.
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "custom-title", customTitle: "Old name 1", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
        JSON.stringify({ type: "custom-title", customTitle: "Old name 2", sessionId }),
        JSON.stringify({ type: "custom-title", customTitle: "Old name 3", sessionId }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "Fresh name");

    expect(head?.title).toBe("Fresh name");
    const records = readJsonl();
    const titleRows = records.filter((r) => r["type"] === "custom-title");
    expect(titleRows).toHaveLength(1);
    expect(titleRows[0]?.["customTitle"]).toBe("Fresh name");
    // user message preserved
    expect(records.filter((r) => r["type"] === "user")).toHaveLength(1);
  });

  it("reads the LAST custom-title row when several exist (matches cc's /resume)", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "custom-title", customTitle: "First", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
        JSON.stringify({ type: "custom-title", customTitle: "Latest cc --name", sessionId }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent, raw } = buildAgent();
    // No write, just observe parseSessionHead reading existing rows.
    const head = raw.parseSessionHead(sessionFile, projectDir);
    expect(head?.title).toBe("Latest cc --name");
    // setSessionAlias (no-op clear when nothing) leaves both rows since we
    // didn't ask to rewrite anything.
    void agent;
  });

  it("prefers custom-title over hook-emitted summary on read", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "summary", summary: "Hook says X", source: "session-end-hook" }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "User override");
    expect(head?.title).toBe("User override");

    const records = readJsonl();
    // The hook summary stays untouched — codesesh only owns custom-title rows.
    expect(records.filter((r) => r["source"] === "session-end-hook")).toHaveLength(1);
    expect(records.filter((r) => r["type"] === "custom-title")).toHaveLength(1);
  });

  it("removes custom-title rows when cleared and falls back to hook summary", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "summary", summary: "Hook says X", source: "session-end-hook" }),
        JSON.stringify({ type: "custom-title", customTitle: "Old alias", sessionId }),
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "first prompt" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, "");
    expect(head?.title).toBe("Hook says X");

    const records = readJsonl();
    expect(records.some((r) => r["type"] === "custom-title")).toBe(false);
    // hook record + user message
    expect(records).toHaveLength(2);
  });

  it("falls back to first user message when no metadata records remain", () => {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "actual first prompt text" },
          timestamp: "2026-04-25T00:00:00.000Z",
          sessionId,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const { agent } = buildAgent();
    const head = agent.setSessionAlias(sessionId, null);
    // No alias was set, file should be untouched and parseSessionHead
    // should derive the title from the first user message.
    expect(head?.title).toBe("actual first prompt text");
    const records = readJsonl();
    expect(records).toHaveLength(1);
  });

  it("returns null for unknown sessions without touching the filesystem", () => {
    writeFileSync(sessionFile, "", "utf-8");
    const { agent } = buildAgent();
    expect(agent.setSessionAlias("does-not-exist", "Whatever")).toBeNull();
    expect(readFileSync(sessionFile, "utf-8")).toBe("");
  });
});
