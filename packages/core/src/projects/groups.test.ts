import { describe, expect, it } from "vitest";
import type { SessionHead } from "../types/index.js";
import { buildProjectGroups } from "./groups.js";

function makeSession(id: string, agent: string, time: number): SessionHead {
  return {
    id,
    slug: `${agent}/${id}`,
    title: id,
    directory: "/repo",
    project_identity: {
      kind: "git_remote",
      key: "github.com/xingkaixin/codesesh",
      displayName: "codesesh",
    },
    time_created: time,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

describe("buildProjectGroups", () => {
  it("groups sessions by project identity across agents", () => {
    const groups = buildProjectGroups([
      makeSession("a", "claudecode", 100),
      makeSession("b", "codex", 200),
    ]);

    expect(groups).toEqual([
      {
        identityKind: "git_remote",
        identityKey: "github.com/xingkaixin/codesesh",
        displayName: "codesesh",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: 200,
      },
    ]);
  });

  it("counts root sessions only when children are present", () => {
    const groups = buildProjectGroups([
      makeSession("parent", "codex", 200),
      {
        ...makeSession("child", "codex", 300),
        parent_reference: { agentName: "codex", sessionId: "parent" },
      },
    ]);

    expect(groups[0]?.sessionCount).toBe(1);
    expect(groups[0]?.lastActivity).toBe(200);
  });
});
