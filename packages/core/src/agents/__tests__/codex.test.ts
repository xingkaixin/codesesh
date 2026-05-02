import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAgent } from "../codex.js";
import type { SessionHead } from "../../types/index.js";

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
    agent.listRolloutFiles = () => [oldA, newC];

    const result = agent.checkForChanges(Date.now(), [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
      makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb");
  });

  it("revalidates recent sessions even without file changes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "codesesh-codex-test-"));
    const recentFile = join(
      tempDir,
      "rollout-2026-04-20T10-00-00-019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa.jsonl",
    );

    writeFileSync(
      recentFile,
      '{"type":"session_meta","payload":{"timestamp":"2026-04-20T10:00:00Z"}}\n',
    );

    const agent = new CodexAgent() as any;
    agent.basePath = tempDir;
    agent.sessionIndexCache = new Map([["stale", "stale"]]);
    agent.sessionMetaMap = new Map([
      [
        "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa",
        { id: "019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", sourcePath: recentFile },
      ],
    ]);
    agent.listRolloutFiles = () => [recentFile];

    const now = Date.now();
    const result = agent.checkForChanges(now, [
      makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa", { time_created: now - 60_000 }),
    ]);

    expect(result.hasChanges).toBe(true);
    expect(result.changedIds).toContain("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
    expect(agent.sessionIndexCache.size).toBe(0);
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
    agent.listRolloutFiles = () => [oldA, newC];
    agent.parseSessionHead = (file: string) => {
      if (file === oldA) return makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa");
      if (file === newC) return makeSession("019dcccc-cccc-7ccc-cccc-cccccccccccc");
      return null;
    };

    const sessions = agent.incrementalScan(
      [
        makeSession("019daaaa-aaaa-7aaa-aaaa-aaaaaaaaaaaa"),
        makeSession("019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"),
      ],
      ["019dbbbb-bbbb-7bbb-bbbb-bbbbbbbbbbbb"],
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
    const assistantWithTools = data.messages.find((message) =>
      message.parts.some((part) => part.type === "tool" && part.tool === "bash"),
    );
    const bashPart = assistantWithTools?.parts.find(
      (part) => part.type === "tool" && part.tool === "bash",
    );
    const patchPart = assistantWithTools?.parts.find(
      (part) => part.type === "tool" && part.tool === "patch",
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
    expect(data.messages.map((message) => message.role)).toEqual([
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
