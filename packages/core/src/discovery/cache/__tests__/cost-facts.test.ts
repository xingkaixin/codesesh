import { mkdtempSync, rmSync } from "node:fs";
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
        cost: 2,
        cost_source: "estimated",
        parts: [],
      },
      {
        id: "untimed",
        role: "assistant",
        time_created: 0,
        model: "haiku",
        cost: 3,
        cost_source: "estimated",
        parts: [],
      },
    ];

    saveCachedSessions("codex", [session]);
    syncSessionSearchIndex("codex", [session], () => ({
      ...session,
      reference: { agentName: "codex", sessionId: session.id },
      messages,
    }));

    const facts = listDashboardCostFacts({ from: TEST_NOW, to: TEST_NOW + 500 });

    expect(facts?.messages).toEqual([
      {
        reference: { agentName: "codex", sessionId: "costed" },
        time: TEST_NOW + 100,
        model: "sonnet",
        cost: 2,
        costSource: "estimated",
      },
    ]);
    expect(facts?.sessions).toEqual([
      {
        reference: { agentName: "codex", sessionId: "costed" },
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
