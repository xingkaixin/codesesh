import { describe, expect, it } from "vitest";
import {
  mergeSearchLists,
  mergeSearchQueryOptions,
  sessionHeadFromSearchRow,
  sessionMatchesSearchCost,
} from "../search.js";
import { makeSessionHead } from "./fixtures.js";

describe("cache search", () => {
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
        session_id: "s1",
        slug: "codex/s1",
        title: "One",
        directory: "/tmp/project",
        time_created: 1,
        message_count: 2,
        total_input_tokens: 3,
        total_output_tokens: 4,
        total_cost: 0.5,
      }),
    ).toMatchObject({ id: "s1", stats: { message_count: 2, total_cost: 0.5 } });
  });
});
