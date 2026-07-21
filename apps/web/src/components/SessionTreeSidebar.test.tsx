import { describe, expect, it } from "vitest";
import type { SessionHead } from "../lib/api";
import { buildSessionTreeModel } from "./SessionTreeSidebar";

function makeSession(overrides: Partial<SessionHead> & { id: string }): SessionHead {
  return {
    slug: `codex/${overrides.id}`,
    title: overrides.id,
    directory: "/repo/unused",
    time_created: 0,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    ...overrides,
  };
}

function groupOrderOf(paths: string[]) {
  const seen: string[] = [];
  for (const path of paths) {
    const group = path.split("/")[0]!;
    if (!seen.includes(group)) seen.push(group);
  }
  return seen;
}

describe("buildSessionTreeModel group sorting", () => {
  it("orders groups by most recent session time, descending", () => {
    const sessions = [
      makeSession({
        id: "old-1",
        directory: "/repo/old",
        time_created: 100,
      }),
      makeSession({
        id: "new-1",
        directory: "/repo/new",
        time_created: 300,
      }),
      makeSession({
        id: "mid-1",
        directory: "/repo/mid",
        time_created: 200,
      }),
      // A second, older session in the "new" group should not pull its maxTime down.
      makeSession({
        id: "new-2",
        directory: "/repo/new",
        time_created: 10,
      }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["new", "mid", "old"]);
  });

  it("always places the unknown group last, regardless of session recency", () => {
    const sessions = [
      makeSession({ id: "known-1", directory: "/repo/known", time_created: 10 }),
      makeSession({ id: "unknown-1", directory: "", time_created: 9999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(groupOrderOf(paths)).toEqual(["known", "(unknown)"]);
  });

  it("sorts a huge group against another group without throwing (no Math.max spread)", () => {
    // 200k sessions in one group reliably overflows `Math.max(...arr)`'s call
    // stack, so this only passes if the comparator avoids spreading.
    const bigGroup: SessionHead[] = Array.from({ length: 200_000 }, (_, index) =>
      makeSession({
        id: `big-${index}`,
        directory: "/repo/big",
        time_created: index,
      }),
    );
    const sessions = [
      ...bigGroup,
      makeSession({ id: "small-1", directory: "/repo/small", time_created: 999_999 }),
    ];

    const { paths } = buildSessionTreeModel(sessions);

    expect(() => buildSessionTreeModel(sessions)).not.toThrow();
    expect(groupOrderOf(paths)).toEqual(["small", "big"]);
  });
});
