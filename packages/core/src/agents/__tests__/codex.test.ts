import { mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAgent } from "../codex.js";
import type { Message, MessagePart, SessionHead } from "../../types/index.js";
import { setCoreDiagnostics, type CoreDiagnostics } from "../../utils/diagnostics.js";

// Spies on statSync while delegating to the real implementation, so the
// single-stat regression test can count per-file calls during a live scan.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

let tempDirs: string[] = [];

function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
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

describe("CodexAgent cache refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  it("detects file set changes even when file count stays the same", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newC = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl",
    );

    writeFileSync(oldA, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n');
    writeFileSync(newC, '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:05:00Z"}}\n');

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        { id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", sourcePath: oldA },
      ],
      [
        "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
        {
          id: "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
          sourcePath: join(tempDir, "missing.jsonl"),
        },
      ],
    ]);
    agent.listRolloutFiles = () => [
      { file: oldA, stat: statSync(oldA) },
      { file: newC, stat: statSync(newC) },
    ];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
      makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb");
  });

  it("ignores unrelated session index changes during cache validation", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const recentFile = join(sessionsDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const indexFile = join(codexHome, "session_index.jsonl");

    writeFileSync(
      recentFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"Old title"}\n`);

    const agent = new CodexAgent() as any;
    agent.basePath = sessionsDir;
    // Seed baseline meta with the live fingerprint.
    agent.scan();
    const baselineFingerprint = agent.listSessionSources()[0]?.fingerprint;

    // Append an unrelated index entry (mtime changes, but this session's
    // title is unchanged → its fingerprint must stay stable).
    const later = new Date(Date.now() + 2000);
    writeFileSync(
      indexFile,
      [
        `{"id":"${sessionId}","thread_name":"Old title"}`,
        '{"id":"019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb","thread_name":"Other title"}',
        "",
      ].join("\n"),
    );
    utimesSync(indexFile, later, later);

    const result = agent.checkForChanges(Date.now(), [
      makeSession(sessionId, { title: "Old title" }),
    ]);

    expect(result.hasChanges).toBe(false);
    expect(result.changedIds).toEqual([]);
    expect(agent.listSessionSources()[0]?.fingerprint).toBe(baselineFingerprint);
  });

  it("bounds listSessionSources to the mtime window when options are passed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const oldFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newFile = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb.jsonl",
    );
    writeFileSync(
      oldFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(
      newFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:05:00Z"}}\n',
    );

    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const newTime = new Date();
    utimesSync(oldFile, oldTime, oldTime);
    utimesSync(newFile, newTime, newTime);

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    expect(
      agent
        .listSessionSources()
        .map((ref: { sourcePath: string }) => ref.sourcePath)
        .sort(),
    ).toEqual([oldFile, newFile].sort());

    const windowed = agent.listSessionSources({ from: Date.now() - 24 * 60 * 60 * 1000 });
    expect(windowed.map((ref: { sourcePath: string }) => ref.sourcePath)).toEqual([newFile]);
  });

  it("stats each rollout file at most once per listSessionSources call", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);

    const sessionIds = [
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ];
    const files = sessionIds.map((id) => join(tempDir, `rollout-2026-04-20T10-00-00-${id}.jsonl`));
    for (const file of files) {
      writeFileSync(
        file,
        '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
      );
    }

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    const statSpy = vi.mocked(statSync);
    statSpy.mockClear();
    agent.listSessionSources();

    for (const file of files) {
      const callsForFile = statSpy.mock.calls.filter((call) => call[0] === file);
      expect(callsForFile.length).toBe(1);
    }
  });

  it("uses per-session Codex titles in source fingerprints", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const codexHome = join(tempDir, ".codex");
    const sessionsDir = join(codexHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    vi.stubEnv("CODEX_HOME", codexHome);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(sessionsDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const indexFile = join(codexHome, "session_index.jsonl");

    writeFileSync(
      sessionFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );
    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"Old title"}\n`);

    const firstAgent = new CodexAgent() as any;
    firstAgent.basePath = sessionsDir;
    const firstFingerprint = firstAgent.listSessionSources()[0]?.fingerprint;

    writeFileSync(
      indexFile,
      [
        `{"id":"${sessionId}","thread_name":"Old title"}`,
        '{"id":"019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb","thread_name":"Other title"}',
        "",
      ].join("\n"),
    );
    const unrelatedAgent = new CodexAgent() as any;
    unrelatedAgent.basePath = sessionsDir;
    const unrelatedFingerprint = unrelatedAgent.listSessionSources()[0]?.fingerprint;

    writeFileSync(indexFile, `{"id":"${sessionId}","thread_name":"New title"}\n`);
    const renamedAgent = new CodexAgent() as any;
    renamedAgent.basePath = sessionsDir;
    const renamedFingerprint = renamedAgent.listSessionSources()[0]?.fingerprint;

    expect(unrelatedFingerprint).toBe(firstFingerprint);
    expect(renamedFingerprint).not.toBe(firstFingerprint);
  });

  it("invalidates cached sessions when the parser version changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        {
          id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
          sourcePath: sessionFile,
          sourceMtimeMs: statSync(sessionFile).mtimeMs,
          indexPath: null,
          indexMtimeMs: null,
          headIndexVersion: "codex-head-v1",
          parserVersion: "codex-parser-v2",
        },
      ],
    ]);
    agent.listRolloutFiles = () => [{ file: sessionFile, stat: statSync(sessionFile) }];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
  });

  it("removes deleted sessions and adds new sessions during incremental scan", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const oldA = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );
    const newC = join(
      tempDir,
      "rollout-2026-04-20T10-05-00-019dcccc-cccc-7ccc-cccc-cccccccccccc.jsonl",
    );

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(oldA, "");
    writeFileSync(newC, "");

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    // Drive the new primitives directly: listSessionSources enumerates the
    // on-disk files, scanSessionSource parses each head.
    agent.scanSessionSource = (file: string) => {
      if (file === oldA) return makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
      if (file === newC) return makeSession("019dcccc-cccc-7ccc-cccc-cccccccccccc");
      return null;
    };

    const sessions = agent.incrementalScan(
      [
        makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
        makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
      ],
      ["019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb", "019dcccc-cccc-7ccc-cccc-cccccccccccc"],
    );

    expect(sessions.map((session: SessionHead) => session.id).sort()).toEqual([
      "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
      "019dcccc-cccc-7ccc-cccc-cccccccccccc",
    ]);
    expect(agent.sessionMetaMap.has("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb")).toBe(false);
  });

  it("uses the latest record timestamp as time_updated", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:02:30Z","type":"event_msg","payload":{"type":"task_complete"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.time_created).toBe(new Date("2026-04-20T10:00:00Z").getTime());
    expect(head?.time_updated).toBe(new Date("2026-04-20T10:02:30Z").getTime());
  });

  it("aggregates model usage from token count events", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20,"reasoning_output_tokens":5},"total_token_usage":{"total_tokens":125}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(100);
    expect(head?.stats.total_output_tokens).toBe(25);
    expect(head?.stats.total_cost).toBe(0.00125);
    expect(head?.stats.cost_source).toBe("estimated");
    expect(head?.model_usage).toEqual({ "gpt-5.5": 125 });
  });

  it("prices Codex cached input with cache read rates", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":800,"output_tokens":20},"total_token_usage":{"total_tokens":1020}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(1000);
    expect(head?.stats.total_cache_read_tokens).toBe(800);
    expect(head?.stats.total_output_tokens).toBe(20);
    expect(head?.stats.total_cost).toBe(0.002);
    expect(head?.model_usage).toEqual({ "gpt-5.5": 1020 });
  });

  it("updates model usage when the active Codex model changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":100,"output_tokens":20},"total_token_usage":{"total_tokens":120}}}}',
        '{"timestamp":"2026-04-20T10:02:00Z","type":"response_item","payload":{"type":"message","role":"assistant","model":"gpt-5.4","content":[{"type":"output_text","text":"hello"}]}}',
        '{"timestamp":"2026-04-20T10:03:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":40,"output_tokens":10},"total_token_usage":{"total_tokens":170}}}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.model_usage).toEqual({ "gpt-5.5": 120, "gpt-5.4": 50 });
  });

  it("falls back to untitled when no title source is available", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{}}',
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.title).toBe("Untitled Session");
  });

  it("filters internal-only sessions", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"progress","payload":{"type":"progress"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    expect(agent.scan()).toEqual([]);
  });

  it("cleans internal tag blocks from messages and tool output", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>noise</environment_context>" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content:
              "Visible request\n<command-name>clear</command-name>\n<local-command-stdout>noise</local-command-stdout>",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Visible answer <system-reminder>hidden</system-reminder>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:04Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:05Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Visible output\n<local-command-stdout>/tmp/project</local-command-stdout>",
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(head?.title).toBe("Visible request");
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
        output: [expect.objectContaining({ type: "text", text: "Visible output" })],
      },
    });
  });

  it("normalizes namespaced MCP function calls for display", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019da000-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "List labels" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Checking Linear" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-linear",
            name: "_list_issue_labels",
            namespace: "mcp__codex_apps__linear",
            arguments: '{"team":"research&develop"}',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[1]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "linear.list_issue_labels",
      title: "Tool: linear.list_issue_labels",
      state: {
        arguments: { team: "research&develop" },
        metadata: {
          name: "_list_issue_labels",
          namespace: "mcp__codex_apps__linear",
        },
      },
    });
  });

  it("uses the tool name when the MCP namespace has no display segment", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019da001-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-node",
            name: "js",
            namespace: "mcp__node_repl__",
            arguments: '{"code":"1 + 1"}',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    agent.scan();
    const data = agent.getSessionData(sessionId);
    const toolPart = data.messages[0]?.parts.find((part: MessagePart) => part.type === "tool");

    expect(toolPart).toMatchObject({
      type: "tool",
      tool: "js",
      title: "Tool: js",
      state: {
        arguments: { code: "1 + 1" },
        metadata: {
          name: "js",
          namespace: "mcp__node_repl__",
        },
      },
    });
  });

  it("parses messages, plans, tools, outputs, and token usage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);
    const patchInput = [
      "*** Begin Patch",
      "*** Add File: package.json",
      '+{ "name": "codesesh" }',
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "-old",
      "+new",
      "*** Delete File: old.ts",
      "*** End Patch",
    ].join("\n");

    writeFileSync(
      sessionFile,
      [
        JSON.stringify({
          timestamp: "2026-04-20T10:00:00Z",
          type: "session_meta",
          payload: { cwd: "/tmp/project", model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:01Z",
          type: "turn_context",
          payload: { model: "gpt-5.5" },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>noise</environment_context>" },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:03Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Implement parser coverage" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:04Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Plan ready\n<proposed_plan>\n1. Add tests\n</proposed_plan>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:05Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: "PLEASE IMPLEMENT THIS PLAN",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:06Z",
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need file context" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:07Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Reading files" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:08Z",
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: '{"cmd":"ls"}',
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:09Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "package.json",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:10Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call-2",
            name: "apply_patch",
            input: patchInput,
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:11Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call-2",
            output: "Success",
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:12Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                cached_input_tokens: 10,
              },
              total_token_usage: { total_tokens: 125 },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-04-20T10:00:13Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content:
              '<subagent_notification>{"agent_id":"agent-1","nickname":"worker","completed":"done"}</subagent_notification>',
          },
        }),
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;

    const [head] = agent.scan();
    const data = agent.getSessionData(sessionId);
    const assistantWithTools = data.messages.find((message: Message) =>
      message.parts.some((part: MessagePart) => part.type === "tool" && part.tool === "bash"),
    );
    const bashPart = assistantWithTools?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "bash",
    );
    const patchPart = assistantWithTools?.parts.find(
      (part: MessagePart) => part.type === "tool" && part.tool === "patch",
    );

    expect(head).toMatchObject({
      id: sessionId,
      title: "Implement parser coverage",
      directory: "/tmp/project",
      stats: {
        message_count: 8,
        total_input_tokens: 100,
        total_output_tokens: 25,
        total_cache_read_tokens: 10,
      },
      model_usage: { "gpt-5.5": 125 },
    });
    expect(data.messages.map((message: Message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);
    expect(data.messages[1]?.parts).toContainEqual(
      expect.objectContaining({ type: "plan", text: "1. Add tests" }),
    );
    expect(data.messages[3]?.parts[0]).toMatchObject({
      type: "reasoning",
      text: "Need file context",
    });
    expect(bashPart).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        arguments: { cmd: "ls" },
        output: [{ type: "text", text: "package.json" }],
        status: "completed",
      },
    });
    expect(patchPart).toMatchObject({
      type: "tool",
      tool: "patch",
      state: {
        arguments: [
          { type: "write_file", path: "package.json" },
          { type: "move_file", path: "src/a.ts", targetPath: "src/b.ts" },
          { type: "delete_file", path: "old.ts" },
        ],
        output: [{ type: "text", text: "Success" }],
        status: "completed",
      },
    });
    expect(assistantWithTools).toMatchObject({
      tokens: { input: 100, output: 20, reasoning: 5, cache_read: 10 },
      cost_source: "estimated",
    });
    expect(data.messages[4]).toMatchObject({
      role: "assistant",
      subagent_id: "agent-1",
      nickname: "worker",
      parts: [{ type: "text", text: "done" }],
    });
  });
});

describe("CodexAgent code-mode exec decoding", () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function writeCodeModeSession(records: Record<string, unknown>[]): {
    agent: any;
    sessionId: string;
  } {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-codemode-"));
    tempDirs.push(tempDir);
    const sessionId = "019dcode-0000-7000-8000-000000000000";
    const sessionFile = join(tempDir, `rollout-2026-07-19T10-00-00-${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({
        timestamp: "2026-07-19T10:00:00Z",
        type: "session_meta",
        payload: { cwd: "/tmp/project", cli_version: "0.144.0-alpha.4" },
      }),
      ...records.map((record) => JSON.stringify({ timestamp: "2026-07-19T10:00:01Z", ...record })),
      "",
    ];
    writeFileSync(sessionFile, lines.join("\n"));

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.scan();
    return { agent, sessionId };
  }

  function firstToolPart(agent: any, sessionId: string): MessagePart | undefined {
    const data = agent.getSessionData(sessionId);
    for (const message of data.messages) {
      const part = message.parts.find((candidate: MessagePart) => candidate.type === "tool");
      if (part) return part;
    }
    return undefined;
  }

  it("decodes exec_command into a bash tool with stripped output", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-1",
          name: "exec",
          input:
            'const r = await tools.exec_command({cmd:"ls",workdir:"/tmp/project"}); text(r.output)',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-1",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "package.json" },
          ],
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "bash",
      state: {
        arguments: { cmd: "ls", workdir: "/tmp/project" },
        output: [{ type: "text", text: "package.json" }],
        status: "completed",
      },
    });
  });

  it("decodes apply_patch into a patch tool with parsed blocks", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-2",
          name: "exec",
          input:
            'const patch = "*** Begin Patch\\n*** Add File: a.txt\\n+hello\\n*** End Patch";\nconst r = await tools.apply_patch({patch}); text(r.output)',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-2",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
            { type: "input_text", text: "Success" },
          ],
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "patch",
      state: {
        arguments: [{ type: "write_file", path: "a.txt", content: "+hello" }],
        output: [{ type: "text", text: "Success" }],
        status: "completed",
      },
    });
  });

  it("decodes a namespaced node_repl js call", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-3",
          name: "exec",
          input:
            'const r = await tools.mcp__node_repl__js({title:"Check state",code:"1+1"}); text(r)',
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "js",
      title: "Tool: js",
      state: {
        arguments: { title: "Check state", code: "1+1" },
        metadata: { name: "js", namespace: "mcp__node_repl__" },
      },
    });
  });

  it("decodes write_stdin", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-4",
          name: "exec",
          input:
            'const r = await tools.write_stdin({session_id:68920,chars:"yes"}); text(r.output)',
        },
      },
    ]);

    expect(firstToolPart(agent, sessionId)).toMatchObject({
      type: "tool",
      tool: "write_stdin",
      state: { arguments: { session_id: 68920, chars: "yes" } },
    });
  });

  it("splits a multi-call program into ordered tool parts", () => {
    const { agent, sessionId } = writeCodeModeSession([
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          call_id: "call-5",
          name: "exec",
          input:
            'let r = await tools.exec_command({cmd:"ls"}); text(r.output); const patch = "*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"; await tools.apply_patch({patch})',
        },
      },
      {
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "call-5",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "a.txt" },
          ],
        },
      },
    ]);

    const data = agent.getSessionData(sessionId);
    const toolParts = data.messages
      .flatMap((message: Message) => message.parts)
      .filter((partValue: MessagePart) => partValue.type === "tool");

    expect(toolParts.map((partValue: MessagePart) => partValue.tool)).toEqual(["bash", "patch"]);
    // The combined output routes to the output-bearing bash part, not the patch.
    expect(toolParts[0]).toMatchObject({
      tool: "bash",
      state: { output: [{ type: "text", text: "a.txt" }], status: "completed" },
    });
    expect(toolParts[1]).toMatchObject({
      tool: "patch",
      state: { arguments: [{ type: "write_file", path: "a.txt", content: "+hi" }], output: null },
    });
  });
});

describe("CodexAgent field shape mismatches", () => {
  let diagnosticsCalls: Array<{ event: string; detail?: Record<string, unknown> }>;

  afterEach(() => {
    setCoreDiagnostics(null);
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  function captureDiagnostics(): void {
    diagnosticsCalls = [];
    const sink: CoreDiagnostics = {
      warn: (event, detail) => diagnosticsCalls.push({ event, detail }),
    };
    setCoreDiagnostics(sink);
  }

  it("falls back to zeroed tokens and reports a mismatch when token_count.info drifts", () => {
    captureDiagnostics();
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project","model":"gpt-5.5"}}',
        // "info" has drifted from an object to a string upstream.
        '{"timestamp":"2026-04-20T10:01:00Z","type":"event_msg","payload":{"type":"token_count","info":"unexpected-string"}}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.sessionIndexCache = new Map();

    const head = agent.parseSessionHead(sessionFile);

    expect(head?.stats.total_input_tokens).toBe(0);
    expect(head?.stats.total_output_tokens).toBe(0);
    expect(head?.model_usage).toBeUndefined();
    expect(diagnosticsCalls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "codex", field: "token_count.info" },
    });
  });

  it("skips a response_item and reports a mismatch when payload drifts to a non-object", () => {
    captureDiagnostics();
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    tempDirs.push(tempDir);
    const sessionId = "019daaaa-aaaa-7aaa-aaaa-bbbbbbbbbbbb";
    const sessionFile = join(tempDir, `rollout-2026-04-20T10-00-00-${sessionId}.jsonl`);

    writeFileSync(
      sessionFile,
      [
        '{"timestamp":"2026-04-20T10:00:00Z","type":"session_meta","payload":{"cwd":"/tmp/project"}}',
        // "payload" has drifted from an object to a bare string upstream.
        '{"timestamp":"2026-04-20T10:01:00Z","type":"response_item","payload":"unexpected-string"}',
        "",
      ].join("\n"),
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.scan();

    const data = agent.getSessionData(sessionId);

    expect(data.messages).toEqual([]);
    expect(diagnosticsCalls).toContainEqual({
      event: "agent.field_shape_mismatch",
      detail: { agentName: "codex", field: "payload" },
    });
  });
});
