import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KimiAgent } from "../kimi.js";
import { diffSessionSources } from "../base.js";
import type { SessionHead } from "../../types/index.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

const PROJECT_HASH = "project-hash";
const PROJECT_DIR = "/tmp/kimi-project";

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `kimi/${id}`,
    title: id,
    directory: PROJECT_DIR,
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

function createAgent(basePath: string): KimiAgent {
  const agent = new KimiAgent() as any;
  agent.basePath = basePath;
  agent.projectMap = new Map([[PROJECT_HASH, PROJECT_DIR]]);
  return agent as KimiAgent;
}

function createSessionDir(
  basePath: string,
  id: string,
  title: string,
  mtimeMs: number,
  createdAtMs = mtimeMs,
): string {
  const sessionDir = join(basePath, PROJECT_HASH, id);
  mkdirSync(sessionDir, { recursive: true });

  const statePath = join(sessionDir, "state.json");
  const contextPath = join(sessionDir, "context.jsonl");
  writeFileSync(
    statePath,
    JSON.stringify({
      custom_title: title,
      created_at: createdAtMs,
      wire_mtime: Math.floor(mtimeMs / 1000),
    }),
  );
  writeFileSync(contextPath, JSON.stringify({ role: "user", content: title }) + "\n");

  const mtime = new Date(mtimeMs);
  utimesSync(statePath, mtime, mtime);
  utimesSync(contextPath, mtime, mtime);

  return sessionDir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
  setCoreDiagnostics(null);
});

describe("KimiAgent cache refresh", () => {
  it("detects added session directories during cache validation", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "old-session", "Old", 1_000);

    const agent = createAgent(basePath);
    // Seed baseline meta so old-session is recognized as known.
    agent.scan();

    // A new session appears on disk after the baseline scan.
    createSessionDir(basePath, "new-session", "New", 1_000);

    const result = agent.checkForChanges(Date.now(), [makeSession("old-session")]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toEqual(["new-session"]);
  });

  it("adds changed session directories during incremental scan", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "old-session", "Old", 1_000);
    createSessionDir(basePath, "new-session", "New", 1_000);

    const agent = createAgent(basePath);
    const sessions = agent.incrementalScan([makeSession("old-session")], ["new-session"]);

    expect(sessions.map((session) => session.id).sort()).toEqual(["new-session", "old-session"]);
    expect(sessions.find((session) => session.id === "new-session")).toMatchObject({
      slug: "kimi/new-session",
      title: "New",
      directory: PROJECT_DIR,
    });
  });

  it("removes deleted sessions during incremental scan", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "old-session", "Old", 1_000);

    const agent = createAgent(basePath);
    const sessions = agent.incrementalScan(
      [makeSession("old-session"), makeSession("deleted-session")],
      ["deleted-session"],
    );

    expect(sessions.map((session) => session.id)).toEqual(["old-session"]);
    expect(agent.getSessionMetaMap().has("deleted-session")).toBe(false);
  });

  it("bounds listSessionSources to the activityAt window when options are passed", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const newTime = Date.now();
    createSessionDir(basePath, "old-session", "Old", oldTime);
    createSessionDir(basePath, "new-session", "New", newTime);

    const agent = createAgent(basePath);

    expect(
      agent
        .listSessionSources()
        .map((ref) => ref.sessionId)
        .sort(),
    ).toEqual(["new-session", "old-session"]);

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref) => ref.sessionId)).toEqual(["new-session"]);
  });

  it("records sourceMtimeMs as the value listSessionSources filters on", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "windowed", "Windowed", 5_000);

    const agent = createAgent(basePath);
    const [head] = agent.scan();
    const meta = agent.getSessionMetaMap().get("windowed");

    expect(meta?.sourceMtimeMs).toBe(head?.time_updated);
  });

  it("keeps creation time separate from transcript activity", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    createSessionDir(basePath, "separate-times", "Separate times", 5_000, 1_000);

    const agent = createAgent(basePath);
    const [head] = agent.scan();

    expect(head).toMatchObject({
      time_created: 1_000,
      time_updated: 5_000,
    });
  });

  it("keeps out-of-window sessions out of the change set during a windowed refresh", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const recent = Date.now();
    const old = recent - 30 * 24 * 60 * 60 * 1000;
    createSessionDir(basePath, "recent-session", "Recent", recent);
    createSessionDir(basePath, "old-session", "Old", old);

    const agent = createAgent(basePath);
    const cached = agent.scan();
    expect(cached.map((session) => session.id).sort()).toEqual(["old-session", "recent-session"]);

    const window = { from: recent - 7 * 24 * 60 * 60 * 1000 };
    const refs = agent.listSessionSources(window);
    expect(refs.map((ref) => ref.sessionId)).toEqual(["recent-session"]);

    const diff = diffSessionSources(refs, cached, agent.getSessionMetaMap(), window);

    // old-session was simply never enumerated; removing it would delete the
    // session and its messages from the cache.
    expect(diff.removedIds).toEqual([]);
  });

  it("parses context messages with tool calls and backfilled output", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "context-session", "Context", 1_000);
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      [
        JSON.stringify({ role: "user", content: "Read package.json" }),
        JSON.stringify({
          role: "assistant",
          content: [
            { type: "think", think: "Need to inspect the file" },
            { type: "text", text: "Reading it now" },
          ],
          tool_calls: [
            {
              id: "call-1",
              function: { name: "ReadFile", arguments: '{"path":"package.json"}' },
            },
          ],
        }),
        JSON.stringify({
          role: "tool",
          tool_call_id: "call-1",
          content: [{ text: '{ "name": "codesesh-monorepo" }' }],
        }),
        "",
      ].join("\n"),
    );

    const agent = createAgent(basePath);
    agent.scan();

    const data = agent.getSessionData("context-session");
    const toolPart = data.messages[1]?.parts[2];

    expect(data.messages).toHaveLength(2);
    expect(data.messages[0]?.role).toBe("user");
    expect(data.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Read package.json",
    });
    expect(data.messages[1]?.role).toBe("assistant");
    expect(data.messages[1]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need to inspect the file",
    });
    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "ReadFile",
      title: "read",
      state: {
        input: { path: "package.json" },
        output: [{ type: "text", text: '{ "name": "codesesh-monorepo" }' }],
      },
    });
  });

  it("preserves wire timestamps on assistant messages", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "wire-times", "Wire times", 6_000, 1_000);
    rmSync(join(sessionDir, "context.jsonl"));
    writeFileSync(
      join(sessionDir, "wire.jsonl"),
      [
        JSON.stringify({
          timestamp: 1,
          message: { type: "TurnBegin", payload: { user_input: ["First"] } },
        }),
        JSON.stringify({
          timestamp: 2,
          message: { type: "ContentPart", payload: { type: "think", think: "Reason" } },
        }),
        JSON.stringify({
          timestamp: 3,
          message: { type: "TurnBegin", payload: { user_input: ["Second"] } },
        }),
        JSON.stringify({
          timestamp: 4,
          message: { type: "ContentPart", payload: { type: "text", text: "Answer" } },
        }),
        JSON.stringify({
          timestamp: 5,
          message: { type: "TurnBegin", payload: { user_input: ["Third"] } },
        }),
        JSON.stringify({
          timestamp: 6,
          message: {
            type: "ToolCall",
            payload: {
              id: "call-1",
              function: { name: "ReadFile", arguments: '{"path":"package.json"}' },
            },
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = createAgent(basePath);
    agent.scan();

    const assistantMessages = agent
      .getSessionData("wire-times")
      .messages.filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.time_created)).toEqual([2_000, 4_000, 6_000]);
  });

  it("uses the first user message as fallback title", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "fallback-title", "", 1_000);
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      JSON.stringify({ role: "user", content: "Fallback title" }) + "\n",
    );

    const agent = createAgent(basePath);
    const [head] = agent.scan();

    expect(head?.title).toBe("Fallback title");
  });

  it("falls back to untitled when no title text is available", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "untitled", "", 1_000);
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "Assistant only" }],
      }) + "\n",
    );

    const agent = createAgent(basePath);
    const [head] = agent.scan();

    expect(head?.title).toBe("Untitled Session");
  });

  it("cleans internal tag blocks from parsed messages", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "tagged-context", "Context", 1_000);
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      [
        JSON.stringify({
          role: "user",
          content:
            "Visible request\n<command-name>clear</command-name>\n<local-command-stdout>noise</local-command-stdout>",
        }),
        JSON.stringify({
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Visible answer <system-reminder>hidden</system-reminder>",
            },
          ],
        }),
        "",
      ].join("\n"),
    );

    const agent = createAgent(basePath);
    agent.scan();

    const data = agent.getSessionData("tagged-context");

    expect(data.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible request" }),
    ]);
    expect(data.messages[1]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Visible answer" }),
    ]);
  });

  it("falls back to zero tokens and reports drift when wire usage fields are non-numeric", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = createSessionDir(basePath, "usage-drift", "Usage drift", 1_000);
    writeFileSync(
      join(sessionDir, "wire.jsonl"),
      JSON.stringify({
        timestamp: 1,
        message: {
          type: "ContentPart",
          payload: { type: "text", text: "hi" },
          usage: { input_tokens: "5", output_tokens: "3" },
        },
      }) + "\n",
    );

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = createAgent(basePath);
    const [head] = agent.scan();

    expect(head?.stats.total_input_tokens).toBe(0);
    expect(head?.stats.total_output_tokens).toBe(0);
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "kimi", field: "usage.input_tokens" },
    });
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "kimi", field: "usage.output_tokens" },
    });
  });

  it("falls back to filesystem times and reports drift when wire_mtime is not a number", () => {
    const basePath = mkdtempSync(join(tmpdir(), "codesesh-kimi-test-"));
    tempDirs.push(basePath);
    const sessionDir = join(basePath, PROJECT_HASH, "mtime-drift");
    mkdirSync(sessionDir, { recursive: true });
    const statePath = join(sessionDir, "state.json");
    writeFileSync(
      statePath,
      JSON.stringify({ custom_title: "Mtime drift", wire_mtime: "not-a-number" }),
    );
    writeFileSync(
      join(sessionDir, "context.jsonl"),
      JSON.stringify({ role: "user", content: "Mtime drift" }) + "\n",
    );

    const calls: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sink: CoreDiagnostics = { warn: (event, detail) => calls.push({ event, detail }) };
    setCoreDiagnostics(sink);

    const agent = createAgent(basePath);
    const [head] = agent.scan();

    expect(head?.time_created).toBe(statSync(sessionDir).birthtimeMs);
    expect(calls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "kimi", field: "session.wire_mtime" },
    });
  });
});
