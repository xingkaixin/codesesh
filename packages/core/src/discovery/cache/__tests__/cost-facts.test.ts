import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-cost-facts-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => testHomeDir) };
});

import { listDashboardCostFacts } from "../cost-facts.js";
import { setSchemaEnsuredPath } from "../db.js";
import { syncSessionSearchIndex } from "../search.js";
import { saveCachedSessions } from "../sessions.js";
import { makeSessionHead, TEST_NOW } from "./fixtures.js";
import type { Message } from "../../../types/index.js";
import { buildDashboard } from "../../../analytics/dashboard.js";

function cacheDir(): string {
  return join(testHomeDir, ".cache", "codesesh");
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(cacheDir(), { recursive: true, force: true });
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(cacheDir(), { recursive: true, force: true });
});

describe("listDashboardCostFacts", () => {
  it("reconciles seven-day Claude model costs from final parent and child request usage", async () => {
    const { ClaudeCodeAgent } = await import("../../../agents/claudecode.js");
    const sourceRoot = join(cacheDir(), "claude");
    const projectDir = join(sourceRoot, "project");
    const childDir = join(projectDir, "parent", "subagents");
    mkdirSync(childDir, { recursive: true });
    const record = (
      requestId: string,
      model: string,
      timestamp: string,
      output: number,
      content: unknown[],
    ) => ({
      type: "assistant",
      uuid: `${requestId}-${output}`,
      requestId,
      timestamp,
      message: {
        role: "assistant",
        model,
        usage: { input_tokens: 100, output_tokens: output },
        content,
      },
    });
    const sonnet = "claude-sonnet-4-5";
    const opus = "claude-opus-4-6";
    writeFileSync(
      join(projectDir, "parent.jsonl"),
      [
        record("outside", sonnet, "2026-04-18T12:00:00Z", 20, [
          { type: "text", text: "Earlier request" },
        ]),
        record("streamed", opus, "2026-04-19T23:59:59Z", 3, [{ type: "thinking", thinking: "" }]),
        record("streamed", opus, "2026-04-20T00:00:01Z", 40, [
          { type: "text", text: "Final response" },
        ]),
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );
    writeFileSync(
      join(childDir, "agent-child.jsonl"),
      JSON.stringify(
        record("child", sonnet, "2026-04-21T12:00:00Z", 20, [{ type: "thinking", thinking: "" }]),
      ),
    );
    const agent = new ClaudeCodeAgent({ sourceRoot });
    const sessions = agent.scan().map((head) => makeSessionHead(head.reference.sessionId, head));
    expect(sessions).toHaveLength(2);
    saveCachedSessions("claudecode", sessions);
    syncSessionSearchIndex("claudecode", sessions, (id) => agent.getSessionData(id));
    const from = Date.parse("2026-04-20T00:00:00Z");
    const to = Date.parse("2026-04-26T23:59:59Z");
    const facts = listDashboardCostFacts({ from, to });
    const dashboard = buildDashboard(sessions, {
      byAgentNames: ["claudecode"],
      scope: {},
      from,
      to,
      costFacts: facts,
    });

    for (const head of sessions) {
      expect(
        facts?.sessions.find((summary) => summary.reference.sessionId === head.reference.sessionId)
          ?.messageCost,
      ).toBeCloseTo(head.stats.total_cost, 10);
    }
    expect(dashboard.totals.cost).toBeCloseTo(0.0021, 10);
    expect(dashboard.perAgent[0]?.cost).toBeCloseTo(dashboard.totals.cost, 10);
    expect(dashboard.modelCost).toEqual([
      { model: opus, cost: 0.0015, costRecorded: 0, costEstimated: 0.0015 },
      { model: sonnet, cost: 0.0006, costRecorded: 0, costEstimated: 0.0006 },
    ]);
    expect(dashboard.modelCost!.reduce((sum, model) => sum + model.cost, 0)).toBeCloseTo(
      dashboard.totals.cost,
      10,
    );
  });

  it("returns timed messages while retaining all-session reconciliation totals", () => {
    const session = makeSessionHead("costed", {
      stats: {
        message_count: 3,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 6,
        cost_source: "estimated",
      },
    });
    const messages: Message[] = [
      {
        id: "before",
        role: "assistant",
        time_created: TEST_NOW - 1_000,
        model: "sonnet",
        tokens: { input: 10, output: 2 },
        cost: 1,
        cost_source: "recorded",
        parts: [],
      },
      {
        id: "inside",
        role: "assistant",
        time_created: TEST_NOW,
        time_completed: TEST_NOW + 100,
        model: "sonnet",
        tokens: { input: 100, output: 20, reasoning: 5, cache_read: 10 },
        cost: 2,
        cost_source: "estimated",
        parts: [],
      },
      {
        id: "untimed",
        role: "assistant",
        time_created: 0,
        model: "haiku",
        tokens: { input: 30, output: 4 },
        cost: 3,
        cost_source: "estimated",
        parts: [],
      },
    ];

    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => ({
      ...session,
      reference: { agentName: "codex", sessionId: session.reference.sessionId },
      messages,
    }));

    const facts = listDashboardCostFacts({ from: TEST_NOW, to: TEST_NOW + 500 });

    expect(facts?.messages).toEqual([
      {
        reference: { agentName: "codex", sessionId: "costed" },
        time: TEST_NOW + 100,
        model: "sonnet",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 10,
        cacheCreateTokens: 0,
        cost: 2,
        costSource: "estimated",
      },
    ]);
    expect(facts?.sessions).toEqual([
      {
        reference: { agentName: "codex", sessionId: "costed" },
        messageCount: 3,
        untimedMessageCount: 1,
        inputTokens: 140,
        outputTokens: 26,
        reasoningTokens: 5,
        cacheReadTokens: 10,
        cacheCreateTokens: 0,
        untimedInputTokens: 30,
        untimedOutputTokens: 4,
        untimedReasoningTokens: 0,
        untimedCacheReadTokens: 0,
        untimedCacheCreateTokens: 0,
        messageCost: 6,
        untimedMessageCost: 3,
        modelCosts: [
          { model: "haiku", cost: 3, costRecorded: 0 },
          { model: "sonnet", cost: 3, costRecorded: 1 },
        ],
      },
    ]);

    expect(
      listDashboardCostFacts({
        from: TEST_NOW,
        to: TEST_NOW + 500,
        includeModelCosts: false,
      })?.sessions[0]?.modelCosts,
    ).toEqual([]);
  });

  it("returns null when the cache is unavailable", () => {
    expect(listDashboardCostFacts()).toBeNull();
  });
});
