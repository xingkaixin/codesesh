import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = mkdtempSync(join(tmpdir(), "codesesh-model-cost-test-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => testHomeDir),
  };
});

import { listModelCostDistribution } from "../model-cost.js";
import { saveCachedSessions } from "../sessions.js";
import { syncSessionSearchIndex } from "../search.js";
import { setSchemaEnsuredPath } from "../db.js";
import { makeSessionHead, TEST_NOW } from "./fixtures.js";
import type { CostSource, Message, SessionHead } from "../../../types/index.js";

interface SeedMessage {
  model?: string;
  cost: number;
  costSource?: CostSource;
}

const OTHER_PROJECT = {
  kind: "path" as const,
  key: "/workspace/other",
  displayName: "other",
};

function seedAgent(agent: string, seeds: Array<[SessionHead, SeedMessage[]]>): void {
  const sessions = seeds.map(([session]) => session);
  const messagesById = new Map(seeds.map(([session, messages]) => [session.id, messages]));

  saveCachedSessions(agent, sessions);
  syncSessionSearchIndex(agent, sessions, (sessionId) => {
    const session = sessions.find((candidate) => candidate.id === sessionId)!;
    const messages: Message[] = (messagesById.get(sessionId) ?? []).map((seed, index) => ({
      id: `${sessionId}-m${index}`,
      role: "assistant",
      time_created: TEST_NOW + index,
      model: seed.model ?? null,
      cost: seed.cost,
      cost_source: seed.costSource,
      parts: [{ type: "text", text: `message ${index}` }],
    }));
    return { ...session, reference: { agentName: agent, sessionId }, messages };
  });
}

function seedFixture(): void {
  seedAgent("codex", [
    [
      makeSessionHead("alpha", { time_updated: TEST_NOW }),
      [
        { model: "sonnet", cost: 1, costSource: "recorded" },
        { model: "sonnet", cost: 0.5, costSource: "estimated" },
        { model: "haiku", cost: 0.25, costSource: "estimated" },
        { cost: 9 },
      ],
    ],
  ]);
  seedAgent("cursor", [
    [
      makeSessionHead("beta", {
        slug: "cursor/beta",
        time_updated: TEST_NOW + 10_000,
        project_identity: OTHER_PROJECT,
      }),
      [{ model: "gpt-5", cost: 3 }],
    ],
  ]);
}

beforeEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache", "codesesh"), { recursive: true, force: true });
});

afterEach(() => {
  setSchemaEnsuredPath(null);
  rmSync(join(testHomeDir, ".cache", "codesesh"), { recursive: true, force: true });
});

describe("listModelCostDistribution", () => {
  it("groups message cost by model and splits recorded from estimated", () => {
    seedFixture();

    expect(listModelCostDistribution()).toEqual([
      { model: "gpt-5", cost: 3, costRecorded: 0, costEstimated: 3 },
      { model: "sonnet", cost: 1.5, costRecorded: 1, costEstimated: 0.5 },
      { model: "haiku", cost: 0.25, costRecorded: 0, costEstimated: 0.25 },
    ]);
  });

  it("scopes totals by agent, project and activity window", () => {
    seedFixture();

    expect(listModelCostDistribution({ agent: "codex" })?.map((entry) => entry.model)).toEqual([
      "sonnet",
      "haiku",
    ]);
    expect(
      listModelCostDistribution({
        projectKind: OTHER_PROJECT.kind,
        projectKey: OTHER_PROJECT.key,
      })?.map((entry) => entry.model),
    ).toEqual(["gpt-5"]);
    expect(listModelCostDistribution({ projectKey: OTHER_PROJECT.key })).toEqual([]);
    expect(
      listModelCostDistribution({ from: TEST_NOW + 5_000 })?.map((entry) => entry.model),
    ).toEqual(["gpt-5"]);
    expect(
      listModelCostDistribution({ to: TEST_NOW + 5_000 })?.map((entry) => entry.model),
    ).toEqual(["sonnet", "haiku"]);
    expect(listModelCostDistribution({ limit: 1 })?.map((entry) => entry.model)).toEqual(["gpt-5"]);
  });

  it("returns null when no cache database exists", () => {
    expect(listModelCostDistribution()).toBeNull();
  });
});
