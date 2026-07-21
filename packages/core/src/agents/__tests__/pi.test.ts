import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgent } from "../pi.js";
import type { MessagePart } from "../../types/index.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

// Spies on statSync while delegating to the real implementation, so the
// single-stat regression test can count per-file calls during a live scan.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

let tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setCoreDiagnostics(null);
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function captureDiagnostics(): Array<{ event: string; detail?: Record<string, unknown> }> {
  const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
  const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
  setCoreDiagnostics(sink);
  return calls;
}

describe("PiAgent", () => {
  it("parses only the current branch path", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(sessionsDir, `2026-04-20T10-00-00_${sessionId}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-20T10:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-04-20T10:00:01.000Z",
          message: { role: "user", content: "Inspect package metadata" },
        },
        {
          type: "message",
          id: "b1",
          parentId: "a1",
          timestamp: "2026-04-20T10:00:02.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: {
              input: 100,
              output: 20,
              cacheRead: 10,
              cacheWrite: 5,
              totalTokens: 135,
              cost: { total: 0.25 },
            },
            content: [
              { type: "thinking", thinking: "Need to read package.json" },
              { type: "text", text: "I will inspect it." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "package.json" } },
            ],
          },
        },
        {
          type: "message",
          id: "c1",
          parentId: "b1",
          timestamp: "2026-04-20T10:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "package output" }],
            isError: false,
          },
        },
        {
          type: "session_info",
          id: "d1",
          parentId: "c1",
          timestamp: "2026-04-20T10:00:04.000Z",
          name: "Package inspection",
        },
        {
          type: "message",
          id: "branch1",
          parentId: "a1",
          timestamp: "2026-04-20T10:00:05.000Z",
          message: { role: "user", content: "Alternate branch should not count" },
        },
        "",
      ]
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n"),
    );

    const agent = new PiAgent();
    expect(agent.isAvailable()).toBe(true);

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const tool = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(head).toMatchObject({
      id: sessionId,
      slug: `pi/${sessionId}`,
      title: "Inspect package metadata",
      directory: "/tmp/project",
      stats: {
        message_count: 2,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });
    expect(data.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(data.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Inspect package metadata",
    });
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      text: "Alternate branch should not count",
    });
    expect(tool).toBeUndefined();
  });

  it("bounds listSessionSources to the mtime window when options are passed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    const oldFile = join(sessionsDir, "2026-04-20T10-00-00_old-session.jsonl");
    const newFile = join(sessionsDir, "2026-04-20T10-05-00_new-session.jsonl");
    writeFileSync(oldFile, "");
    writeFileSync(newFile, "");

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newTime = new Date();
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const agent = new PiAgent();
    agent.isAvailable();

    expect(
      agent
        .listSessionSources()
        .map((ref) => ref.sourcePath)
        .sort(),
    ).toEqual([oldFile, newFile].sort());

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref) => ref.sourcePath)).toEqual([newFile]);
  });

  it("stats each session file at most once per listSessionSources call", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    const files = ["a", "b", "c"].map((name) =>
      join(sessionsDir, `2026-04-20T10-00-00_${name}.jsonl`),
    );
    for (const file of files) writeFileSync(file, "");

    const agent = new PiAgent();
    agent.isAvailable();

    const statSpy = vi.mocked(statSync);
    statSpy.mockClear();
    agent.listSessionSources();

    for (const file of files) {
      const callsForFile = statSpy.mock.calls.filter((call) => call[0] === file);
      expect(callsForFile.length).toBe(1);
    }
  });

  it("uses session names and parses assistant tools on the selected leaf", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    const sessionId = "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb";
    const sessionFile = join(sessionsDir, `2026-04-20T10-00-00_${sessionId}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-20T10:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-04-20T10:00:01.000Z",
          message: { role: "user", content: "Inspect package metadata" },
        },
        {
          type: "message",
          id: "b1",
          parentId: "a1",
          timestamp: "2026-04-20T10:00:02.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            usage: {
              input: 100,
              output: 20,
              cacheRead: 10,
              cacheWrite: 5,
              totalTokens: 135,
              cost: { total: 0.25 },
            },
            content: [
              { type: "thinking", thinking: "Need to read package.json" },
              { type: "text", text: "I will inspect it." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "package.json" } },
            ],
          },
        },
        {
          type: "message",
          id: "c1",
          parentId: "b1",
          timestamp: "2026-04-20T10:00:03.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "package output" }],
            isError: false,
          },
        },
        {
          type: "session_info",
          id: "d1",
          parentId: "c1",
          timestamp: "2026-04-20T10:00:04.000Z",
          name: "Package inspection",
        },
        "",
      ]
        .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
        .join("\n"),
    );

    const agent = new PiAgent();
    expect(agent.isAvailable()).toBe(true);

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const assistant = data.messages[1];
    const tool = assistant?.parts.find((part: MessagePart) => part.type === "tool");

    expect(head).toMatchObject({
      id: sessionId,
      slug: `pi/${sessionId}`,
      title: "Package inspection",
      directory: "/tmp/project",
      stats: {
        message_count: 2,
        total_input_tokens: 115,
        total_output_tokens: 20,
        total_cache_read_tokens: 10,
        total_cache_create_tokens: 5,
        total_cost: 0.25,
        cost_source: "recorded",
      },
      model_usage: { "claude-sonnet-4-5": 135 },
    });
    expect(data.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(assistant?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need to read package.json",
    });
    expect(assistant?.parts[1]).toMatchObject({
      type: "text",
      text: "I will inspect it.",
    });
    expect(tool).toMatchObject({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "package.json" },
        output: [{ type: "text", text: "package output" }],
      },
    });
  });

  it("drops a message with a non-string role and reports the drift", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    const sessionId = "019dcccc-cccc-7ccc-cccc-cccccccccccc";
    const sessionFile = join(sessionsDir, `2026-04-20T10-00-00_${sessionId}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-20T10:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-04-20T10:00:01.000Z",
          message: { role: "user", content: "Inspect package metadata" },
        },
        {
          type: "message",
          id: "b1",
          parentId: "a1",
          timestamp: "2026-04-20T10:00:02.000Z",
          message: { role: 42, content: "Malformed role should be dropped" },
        },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    );

    const calls = captureDiagnostics();
    const agent = new PiAgent();
    expect(agent.isAvailable()).toBe(true);

    agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0]?.parts[0]).toMatchObject({ text: "Inspect package metadata" });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "pi", field: "message.role" },
    });
  });

  it("falls back to zeroed usage fields and reports drift when usage.input isn't a number", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-pi-test-"));
    tempDirs.push(tempDir);
    const piHome = join(tempDir, ".pi");
    const sessionsDir = join(piHome, "agent", "sessions", "--tmp-project--");
    const sessionId = "019dcccc-cccc-7ccc-cccc-dddddddddddd";
    const sessionFile = join(sessionsDir, `2026-04-20T10-00-00_${sessionId}.jsonl`);
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("PI_HOME", piHome);

    writeFileSync(
      sessionFile,
      [
        {
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-04-20T10:00:00.000Z",
          cwd: "/tmp/project",
        },
        {
          type: "message",
          id: "a1",
          parentId: null,
          timestamp: "2026-04-20T10:00:01.000Z",
          message: { role: "user", content: "Summarize the repo" },
        },
        {
          type: "message",
          id: "b1",
          parentId: "a1",
          timestamp: "2026-04-20T10:00:02.000Z",
          message: {
            role: "assistant",
            model: "claude-sonnet-4-5",
            usage: { input: "many", output: 20 },
            content: [{ type: "text", text: "Here you go." }],
          },
        },
      ]
        .map((item) => JSON.stringify(item))
        .join("\n"),
    );

    const calls = captureDiagnostics();
    const agent = new PiAgent();
    expect(agent.isAvailable()).toBe(true);

    agent.scan();
    const data = agent.getSessionData(sessionId);

    expect(data.messages[1]?.tokens).toMatchObject({ input: 0, output: 20 });
    expect(data.stats.total_input_tokens).toBe(0);
    expect(data.stats.total_output_tokens).toBe(20);
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "pi", field: "message.usage.input" },
    });
  });
});
