import { describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../../types/session.js";

const treeMocks = vi.hoisted(() => ({ buildSessionTree: vi.fn() }));

vi.mock("../../contract/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../contract/index.js")>();
  treeMocks.buildSessionTree.mockImplementation(actual.buildSessionTree);
  return { ...actual, buildSessionTree: treeMocks.buildSessionTree };
});

import { buildDashboard } from "../dashboard.js";

function makeSession(id: string, activity: number): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    title: id,
    directory: "/project",
    time_created: activity,
    time_updated: activity,
    stats: {
      message_count: 1,
      total_input_tokens: 1,
      total_output_tokens: 1,
      total_cost: 0,
    },
  };
}

describe("dashboard session tree reuse", () => {
  it("builds one tree for the current and comparison windows", () => {
    treeMocks.buildSessionTree.mockClear();

    buildDashboard([makeSession("current", 200), makeSession("previous", 100)], {
      byAgentNames: ["codex"],
      scope: {},
      from: 150,
      to: 250,
      compare: { from: 50, to: 149 },
    });

    expect(treeMocks.buildSessionTree).toHaveBeenCalledOnce();
  });
});
