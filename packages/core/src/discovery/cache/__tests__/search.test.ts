import { describe, expect, it } from "vitest";
import {
  buildSessionSearchFilters,
  mergeSearchLists,
  mergeSearchQueryOptions,
  sessionHeadFromSearchRow,
  sessionMatchesSearchCost,
} from "../search.js";
import { makeSessionHead } from "./fixtures.js";

describe("cache search", () => {
  it("normalizes Windows scope paths before SQL matching", () => {
    const result = buildSessionSearchFilters({
      projectScope: {
        identity: { kind: "path", key: "C:/workspace/app" },
        path: "C:\\workspace\\app",
      },
    });

    expect(result.params).toEqual([
      "path",
      "C:/workspace/app",
      "C:/workspace/app",
      "C:/workspace/app",
      "C:/workspace/app",
    ]);
  });

  it("merges query qualifiers without overriding explicit options", () => {
    const merged = mergeSearchQueryOptions("agent:codex tag:bugfix needle", {
      agent: "claudecode",
      tags: ["testing"],
    });

    expect(merged.text).toBe("needle");
    expect(merged.options.agent).toBe("claudecode");
    expect(merged.options.tags).toEqual(["testing", "bugfix"]);
    expect(mergeSearchLists(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("merges cost values with the comparison mode from the same source", () => {
    const explicit = mergeSearchQueryOptions("cost:>0.1 cost:<10", {
      costMin: 3.5,
      costMax: 8,
    }).options;
    expect(explicit.costMin).toBe(3.5);
    expect(explicit.costMax).toBe(8);
    expect(explicit.costMinExclusive).toBeUndefined();
    expect(explicit.costMaxExclusive).toBeUndefined();

    const qualifier = mergeSearchQueryOptions("cost:>0.1 cost:<10", {}).options;
    expect(qualifier.costMin).toBe(0.1);
    expect(qualifier.costMax).toBe(10);
    expect(qualifier.costMinExclusive).toBe(true);
    expect(qualifier.costMaxExclusive).toBe(true);

    const strictExplicit = mergeSearchQueryOptions("cost:>=0.1", {
      costMin: 3.5,
      costMinExclusive: true,
    }).options;
    expect(strictExplicit.costMin).toBe(3.5);
    expect(strictExplicit.costMinExclusive).toBe(true);

    const orphanComparisonMode = mergeSearchQueryOptions("cost:>=1", {
      costMinExclusive: true,
    }).options;
    expect(orphanComparisonMode.costMin).toBe(1);
    expect(orphanComparisonMode.costMinExclusive).toBeUndefined();
  });

  it("keeps inclusive and exclusive cost bounds distinct", () => {
    const session = makeSessionHead("s1", {
      stats: { ...makeSessionHead("base").stats, total_cost: 1 },
    });

    expect(sessionMatchesSearchCost(session, { costMin: 1, costMax: 1 })).toBe(true);
    expect(sessionMatchesSearchCost(session, { costMin: 1, costMinExclusive: true })).toBe(false);
    expect(sessionMatchesSearchCost(session, { costMax: 1, costMaxExclusive: true })).toBe(false);
  });

  it("maps database rows through the canonical session decoder", () => {
    expect(
      sessionHeadFromSearchRow({
        agent_name: "codex",
        session_id: "s1",
        title: "One",
        directory: "/tmp/project",
        project_identity_kind: "path",
        project_identity_key: "/tmp/project",
        project_display_name: "project",
        time_created: 1,
        message_count: 2,
        total_input_tokens: 3,
        total_output_tokens: 4,
        total_cost: 0.5,
      }),
    ).toMatchObject({
      reference: { agentName: "codex", sessionId: "s1" },
      stats: { message_count: 2, total_cost: 0.5 },
    });
  });
});
