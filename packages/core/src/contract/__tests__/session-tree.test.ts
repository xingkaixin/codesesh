import { describe, expect, it } from "vitest";
import type { SessionHead } from "../session.js";
import { filterSessionTreeByActivityWindow } from "../session-tree.js";

function makeSession(
  id: string,
  time: number,
  parent_reference?: SessionHead["parent_reference"],
): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/repo",
    time_created: time,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    parent_reference,
  };
}

describe("session tree window filtering", () => {
  it("filters roots by activity and includes descendants regardless of their activity", () => {
    const sessions = [
      makeSession("parent", 100),
      makeSession("child-old", 1, { agentName: "codex", sessionId: "parent" }),
      makeSession("child-new", 999, { agentName: "codex", sessionId: "parent" }),
      makeSession("other", 1),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map((session) => session.id),
    ).toEqual(["parent", "child-old", "child-new"]);
  });

  it("keeps nested descendants and preserves the input order", () => {
    const sessions = [
      makeSession("grandchild", 1, { agentName: "codex", sessionId: "child" }),
      makeSession("child", 2, { agentName: "codex", sessionId: "parent" }),
      makeSession("parent", 100),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 100, 100).map((session) => session.id),
    ).toEqual(["grandchild", "child", "parent"]);
  });

  it("does not promote an orphaned child to a root", () => {
    const sessions = [makeSession("orphan", 100, { agentName: "codex", sessionId: "missing" })];

    expect(filterSessionTreeByActivityWindow(sessions, 90, 110)).toEqual([]);
  });
});
