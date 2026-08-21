import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokAgent } from "../grok.js";
import type { MessagePart } from "../../types/index.js";

const SESSION_ID = "019fa1ad-9d13-73e3-8aad-33df72f7810f";
const PARENT_SESSION_ID = "019fa000-0000-7000-8000-000000000000";
const CREATED_AT = "2026-08-05T08:00:00.000Z";
const CREATED_AT_MS = Date.parse(CREATED_AT);

let tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

function acpUpdate(
  timestampMs: number,
  promptId: string,
  sessionUpdate: string,
  fields: Record<string, unknown>,
) {
  return {
    timestamp: timestampMs / 1000,
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: { sessionUpdate, ...fields },
      _meta: { agentTimestampMs: timestampMs, eventId: `event-${timestampMs}`, promptId },
    },
  };
}

function xaiUpdate(
  timestampMs: number,
  promptId: string,
  sessionUpdate: string,
  fields: Record<string, unknown>,
) {
  return {
    timestamp: timestampMs / 1000,
    method: "_x.ai/session/update",
    params: {
      sessionId: SESSION_ID,
      update: { sessionUpdate, ...fields },
      _meta: { agentTimestampMs: timestampMs, eventId: `event-${timestampMs}`, promptId },
    },
  };
}

interface SessionFixtureOptions {
  updates?: Record<string, unknown>[];
  chatHistory?: Record<string, unknown>[];
  summaryChatMessageCount?: number;
  title?: string;
  parentSessionId?: string;
}

function writeGrokSession(options: SessionFixtureOptions) {
  const tempDir = mkdtempSync(join(tmpdir(), "codesesh-grok-test-"));
  tempDirs.push(tempDir);
  const grokHome = join(tempDir, ".grok");
  const sessionDir = join(grokHome, "sessions", "%2Ftmp%2Fgrok-project", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  vi.stubEnv("GROK_HOME", grokHome);

  writeFileSync(
    join(sessionDir, "summary.json"),
    JSON.stringify({
      info: { id: SESSION_ID, cwd: "/tmp/grok-project" },
      session_summary: "",
      generated_title: options.title ?? "",
      created_at: CREATED_AT,
      updated_at: "2026-08-05T08:30:00.000Z",
      last_active_at: "2026-08-05T08:29:00.000Z",
      num_messages: options.updates?.length ?? 0,
      num_chat_messages: options.summaryChatMessageCount ?? 40,
      current_model_id: "grok-4.5",
      parent_session_id: options.parentSessionId,
    }),
  );
  const updatesPath = join(sessionDir, "updates.jsonl");
  if (options.updates) {
    writeFileSync(updatesPath, options.updates.map((update) => JSON.stringify(update)).join("\n"));
  }
  if (options.chatHistory) {
    writeFileSync(
      join(sessionDir, "chat_history.jsonl"),
      options.chatHistory.map((message) => JSON.stringify(message)).join("\n"),
    );
  }

  const agent = new GrokAgent();
  expect(agent.isAvailable()).toBe(true);
  return { agent, updatesPath };
}

function turnUsage(
  inputTokens: number,
  outputTokens: number,
  costUsdTicks: number,
): Record<string, unknown> {
  return {
    stop_reason: "end_turn",
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cachedReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 4,
      modelCalls: 1,
      costUsdTicks,
      modelUsage: {
        "grok-4.5-build": {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
      },
    },
  };
}

describe("GrokAgent", () => {
  it.each([
    { label: "missing", updates: undefined },
    { label: "empty", updates: [] },
  ])("filters sessions with a $label authoritative update stream", ({ updates }) => {
    const { agent } = writeGrokSession({
      updates,
      summaryChatMessageCount: 2,
      title: "Internal context only",
      chatHistory: [
        { type: "system", content: "Internal system prompt" },
        {
          type: "user",
          synthetic_reason: "system_reminder",
          content: [{ type: "text", text: "<system-reminder>Internal reminder</system-reminder>" }],
        },
      ],
    });

    expect(agent.scan()).toEqual([]);
  });

  it("parses ACP messages, tools, plans, usage, and parent sessions", () => {
    const updates = [
      acpUpdate(CREATED_AT_MS + 1_000, "prompt-0", "user_message_chunk", {
        content: { type: "text", text: "Inspect Grok sessions" },
        _meta: { modelId: "grok-4.5", promptIndex: 0 },
      }),
      acpUpdate(CREATED_AT_MS + 2_000, "prompt-0", "agent_thought_chunk", {
        content: { type: "text", text: "Inspect" },
      }),
      acpUpdate(CREATED_AT_MS + 2_100, "prompt-0", "agent_thought_chunk", {
        content: { type: "text", text: "ing" },
      }),
      acpUpdate(CREATED_AT_MS + 3_000, "prompt-0", "agent_message_chunk", {
        content: { type: "text", text: "I will inspect it." },
      }),
      acpUpdate(CREATED_AT_MS + 4_000, "prompt-0", "tool_call", {
        toolCallId: "tool-1",
        title: "read_file",
        rawInput: { target_file: "README.md" },
        _meta: {
          "x.ai/tool": { name: "read_file", kind: "read", namespace: "grok_build" },
        },
      }),
      acpUpdate(CREATED_AT_MS + 4_100, "prompt-0", "tool_call_update", {
        toolCallId: "tool-1",
        status: "in_progress",
        rawInput: { target_file: "README.md", variant: "full" },
      }),
      acpUpdate(CREATED_AT_MS + 5_000, "prompt-0", "tool_call_update", {
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { type: "ReadFile", FileContent: { content: "README contents" } },
      }),
      acpUpdate(CREATED_AT_MS + 6_000, "prompt-0", "plan", {
        entries: [{ content: "Read the session", status: "pending", priority: "high" }],
      }),
      acpUpdate(CREATED_AT_MS + 6_100, "prompt-0", "plan", {
        entries: [{ content: "Read the session", status: "completed", priority: "high" }],
      }),
      xaiUpdate(
        CREATED_AT_MS + 7_000,
        "prompt-0",
        "turn_completed",
        turnUsage(100, 20, 500_000_000),
      ),
      acpUpdate(CREATED_AT_MS + 8_000, "prompt-1", "user_message_chunk", {
        content: { type: "text", text: "Summarize the result" },
        _meta: { modelId: "grok-4.5", promptIndex: 1 },
      }),
      acpUpdate(CREATED_AT_MS + 9_000, "prompt-1", "agent_message_chunk", {
        content: { type: "text", text: "The session is valid." },
      }),
      xaiUpdate(
        CREATED_AT_MS + 10_000,
        "prompt-1",
        "turn_completed",
        turnUsage(50, 10, 100_000_000),
      ),
    ];
    const { agent } = writeGrokSession({
      updates,
      title: "Grok session support",
      parentSessionId: PARENT_SESSION_ID,
    });

    const [head] = agent.scan();
    expect(head).toMatchObject({
      reference: { agentName: "grok", sessionId: SESSION_ID },
      title: "Grok session support",
      directory: "/tmp/grok-project",
      parent_reference: { agentName: "grok", sessionId: PARENT_SESSION_ID },
      time_created: CREATED_AT_MS,
      time_updated: Date.parse("2026-08-05T08:29:00.000Z"),
      stats: {
        message_count: 4,
        total_input_tokens: 150,
        total_output_tokens: 30,
        total_cache_read_tokens: 20,
        total_cache_create_tokens: 10,
        total_tokens: 180,
        cost_source: "recorded",
      },
      model_usage: { "grok-4.5-build": 180 },
    });
    expect(head?.stats.total_cost).toBeCloseTo(0.06);

    const detail = agent.getSessionData(SESSION_ID);
    expect(detail.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(detail.messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "Inspect Grok sessions",
    });

    const firstAssistant = detail.messages[1]!;
    expect(firstAssistant.parts[0]).toMatchObject({ type: "reasoning", text: "Inspecting" });
    expect(firstAssistant.parts[1]).toMatchObject({ type: "text", text: "I will inspect it." });
    const tool = firstAssistant.parts.find((part: MessagePart) => part.type === "tool") as Extract<
      MessagePart,
      { type: "tool" }
    >;
    expect(tool).toMatchObject({
      tool: "read_file",
      title: "read",
      callID: "tool-1",
      state: {
        status: "completed",
        input: { target_file: "README.md", variant: "full" },
        output: { type: "ReadFile", FileContent: { content: "README contents" } },
      },
    });
    expect(firstAssistant.parts.filter((part) => part.type === "plan")).toEqual([
      expect.objectContaining({
        text: "- [x] Read the session",
        approval_status: "success",
      }),
    ]);
    expect(firstAssistant.tokens).toMatchObject({
      input: 100,
      output: 20,
      reasoning: 4,
      cache_read: 10,
      cache_create: 5,
    });
    expect(firstAssistant.cost).toBeCloseTo(0.05);
    expect(detail.stats).toMatchObject(head!.stats);
  });

  it("uses the first visible prompt as title and removes rewound branches", () => {
    const updates = [
      acpUpdate(CREATED_AT_MS + 500, "host", "user_message_chunk", {
        content: { type: "text", text: "Internal host turn" },
        _meta: { hostTurn: true },
      }),
      acpUpdate(CREATED_AT_MS + 750, "host", "agent_thought_chunk", {
        content: { type: "text", text: "   " },
      }),
      acpUpdate(CREATED_AT_MS + 1_000, "prompt-0", "user_message_chunk", {
        content: { type: "text", text: "Keep this prompt" },
        _meta: { promptIndex: 0 },
      }),
      acpUpdate(CREATED_AT_MS + 2_000, "prompt-0", "agent_message_chunk", {
        content: { type: "text", text: "Kept answer" },
      }),
      xaiUpdate(CREATED_AT_MS + 3_000, "prompt-0", "turn_completed", turnUsage(10, 2, 10_000_000)),
      acpUpdate(CREATED_AT_MS + 4_000, "prompt-1", "user_message_chunk", {
        content: { type: "text", text: "Discard this prompt" },
        _meta: { promptIndex: 1 },
      }),
      acpUpdate(CREATED_AT_MS + 5_000, "prompt-1", "agent_message_chunk", {
        content: { type: "text", text: "Discarded answer" },
      }),
      xaiUpdate(CREATED_AT_MS + 6_000, "prompt-1", "turn_completed", turnUsage(20, 4, 20_000_000)),
      xaiUpdate(CREATED_AT_MS + 7_000, "prompt-1", "rewind_marker", {
        target_prompt_index: 1,
        created_at: "2026-08-05T08:00:07.000Z",
      }),
      acpUpdate(CREATED_AT_MS + 8_000, "prompt-1b", "user_message_chunk", {
        content: { type: "text", text: "Replacement prompt" },
        _meta: { promptIndex: 1 },
      }),
      acpUpdate(CREATED_AT_MS + 9_000, "prompt-1b", "agent_message_chunk", {
        content: { type: "text", text: "Replacement answer" },
      }),
      xaiUpdate(
        CREATED_AT_MS + 10_000,
        "prompt-1b",
        "turn_completed",
        turnUsage(30, 6, 30_000_000),
      ),
    ];
    const { agent } = writeGrokSession({ updates, title: "" });

    const [head] = agent.scan();
    expect(head?.title).toBe("Keep this prompt");
    expect(head?.stats.message_count).toBe(4);

    const detail = agent.getSessionData(SESSION_ID);
    const texts = detail.messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "text" || part.type === "reasoning" ? [part.text] : [],
      ),
    );
    expect(texts).toEqual([
      "Keep this prompt",
      "Kept answer",
      "Replacement prompt",
      "Replacement answer",
    ]);
    expect(detail.stats.total_input_tokens).toBe(60);
    expect(detail.stats.total_output_tokens).toBe(12);
    expect(detail.stats.total_cost).toBeCloseTo(0.006);
  });

  it("changes the source fingerprint when the update stream grows", () => {
    const updates = [
      acpUpdate(CREATED_AT_MS + 1_000, "prompt-0", "user_message_chunk", {
        content: { type: "text", text: "Track changes" },
        _meta: { promptIndex: 0 },
      }),
    ];
    const { agent, updatesPath } = writeGrokSession({ updates, title: "Fingerprint" });

    const before = agent.listSessionSources()[0]!;
    appendFileSync(
      updatesPath,
      `\n${JSON.stringify(
        acpUpdate(CREATED_AT_MS + 2_000, "prompt-0", "agent_message_chunk", {
          content: { type: "text", text: "Changed" },
        }),
      )}`,
    );
    const after = agent.listSessionSources()[0]!;

    expect(after.sessionId).toBe(before.sessionId);
    expect(after.sourcePath).toBe(before.sourcePath);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});
