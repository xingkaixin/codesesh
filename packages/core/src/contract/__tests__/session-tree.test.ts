import { describe, expect, it } from "vitest";
import type { CostSource, SessionHead } from "../session.js";
import {
  buildSessionTree,
  filterSessionTreeByActivityWindow,
  groupSessionsByCalendarDay,
} from "../session-tree.js";

interface SessionOverrides {
  parent?: string;
  cost?: number;
  costSource?: CostSource;
  messages?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
}

function makeSession(id: string, time: number, overrides: SessionOverrides = {}): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/repo",
    time_created: time,
    stats: {
      message_count: overrides.messages ?? 1,
      total_input_tokens: overrides.input ?? 0,
      total_output_tokens: overrides.output ?? 0,
      total_cache_read_tokens: overrides.cacheRead,
      total_cache_create_tokens: overrides.cacheCreate,
      total_cost: overrides.cost ?? 0,
      cost_source: overrides.costSource,
    },
    parent_reference: overrides.parent
      ? { agentName: "codex", sessionId: overrides.parent }
      : undefined,
  };
}

function ids(nodes: { session: SessionHead }[]): string[] {
  return nodes.map((node) => node.session.id);
}

describe("buildSessionTree", () => {
  it.each([
    {
      name: "root tree",
      sessions: [makeSession("root", 1), makeSession("child", 2, { parent: "root" })],
    },
    {
      name: "missing parent",
      sessions: [
        makeSession("orphan", 1, { parent: "missing" }),
        makeSession("below", 2, { parent: "orphan" }),
      ],
    },
    {
      name: "self-cycle",
      sessions: [makeSession("self", 1, { parent: "self" })],
    },
    {
      name: "two-node cycle",
      sessions: [makeSession("a", 1, { parent: "b" }), makeSession("b", 2, { parent: "a" })],
    },
    {
      name: "cycle with an outgoing child",
      sessions: [
        makeSession("a", 1, { parent: "b" }),
        makeSession("b", 2, { parent: "a" }),
        makeSession("below", 3, { parent: "a" }),
      ],
    },
  ])("keeps every session exactly once for a $name", ({ sessions }) => {
    const tree = buildSessionTree(sessions);
    const pending = [...tree.entries];
    const visible: string[] = [];

    while (pending.length > 0) {
      const node = pending.pop()!;
      visible.push(node.session.id);
      pending.push(...node.children);
    }

    expect([...visible].sort()).toEqual(sessions.map((session) => session.id).sort());
    expect(new Set(visible).size).toBe(sessions.length);
  });

  it("splits a mixed array into roots, children and orphans", () => {
    const sessions = [
      makeSession("child", 2, { parent: "root" }),
      makeSession("orphan", 3, { parent: "missing" }),
      makeSession("root", 1),
    ];

    const tree = buildSessionTree(sessions);

    expect(ids(tree.roots)).toEqual(["root"]);
    expect(ids(tree.orphans)).toEqual(["orphan"]);
    expect(ids(tree.entries)).toEqual(["orphan", "root"]);
    expect(ids(tree.byRouteKey.get("codex/root")!.children)).toEqual(["child"]);
  });

  it("counts descendants at every depth", () => {
    const tree = buildSessionTree([
      makeSession("root", 1),
      makeSession("child", 2, { parent: "root" }),
      makeSession("grandchild", 3, { parent: "child" }),
    ]);

    expect(tree.roots[0]!.descendantCount).toBe(2);
    expect(tree.roots[0]!.children[0]!.descendantCount).toBe(1);
  });

  it("rolls stats up a three-level tree and degrades the cost source", () => {
    const tree = buildSessionTree([
      makeSession("root", 1, {
        messages: 2,
        input: 10,
        output: 5,
        cost: 1,
        costSource: "recorded",
      }),
      makeSession("child", 2, {
        parent: "root",
        messages: 3,
        input: 20,
        output: 7,
        cacheRead: 4,
        cost: 2,
        costSource: "recorded",
      }),
      makeSession("grandchild", 3, {
        parent: "child",
        messages: 4,
        input: 30,
        output: 9,
        cacheCreate: 6,
        cost: 3,
        costSource: "estimated",
      }),
    ]);

    expect(tree.roots[0]!.inclusiveStats).toEqual({
      messageCount: 9,
      inputTokens: 60,
      outputTokens: 21,
      cacheReadTokens: 4,
      cacheCreateTokens: 6,
      totalTokens: 81,
      cost: 6,
      costSource: "estimated",
    });
    expect(tree.roots[0]!.children[0]!.inclusiveStats.costSource).toBe("estimated");
  });

  it("leaves the cost source undefined while the subtree costs nothing", () => {
    const tree = buildSessionTree([
      makeSession("root", 1),
      makeSession("child", 2, { parent: "root", costSource: "estimated" }),
    ]);

    expect(tree.roots[0]!.inclusiveStats.cost).toBe(0);
    expect(tree.roots[0]!.inclusiveStats.costSource).toBeUndefined();
  });

  it("reports the mount state of every session", () => {
    const root = makeSession("root", 1);
    const child = makeSession("child", 2, { parent: "root" });
    const orphan = makeSession("orphan", 3, { parent: "missing" });
    const tree = buildSessionTree([root, child, orphan]);

    expect(tree.mountStateOf(root)).toBe("root");
    expect(tree.mountStateOf(child)).toBe("mounted-child");
    expect(tree.mountStateOf(orphan)).toBe("orphan");
  });

  it("treats a parent/child cycle as orphans instead of recursing", () => {
    const tree = buildSessionTree([
      makeSession("a", 1, { parent: "b" }),
      makeSession("b", 2, { parent: "a" }),
      makeSession("below", 3, { parent: "a" }),
    ]);

    expect(ids(tree.roots)).toEqual([]);
    expect(ids(tree.orphans)).toEqual(["a", "b", "below"]);
    expect(tree.orphans.every((node) => node.children.length === 0)).toBe(true);
  });
});

describe("groupSessionsByCalendarDay", () => {
  const day = (hours: number) => new Date(2024, 4, 7, hours).getTime();
  const nextDay = (hours: number) => new Date(2024, 4, 8, hours).getTime();

  it("buckets same-day nodes newest first and reports the sub-session count", () => {
    const tree = buildSessionTree([
      makeSession("morning", day(9)),
      makeSession("evening", day(20)),
      makeSession("sub", day(21), { parent: "evening" }),
      makeSession("tomorrow", nextDay(8)),
    ]);

    const groups = groupSessionsByCalendarDay(tree.entries);

    expect(groups.map((group) => group.dayKey)).toEqual(["2024-05-08", "2024-05-07"]);
    expect(groups[1]).toMatchObject({
      dayStart: new Date(2024, 4, 7).getTime(),
      mainCount: 2,
      subCount: 1,
    });
    expect(ids(groups[1]!.nodes)).toEqual(["evening", "morning"]);
  });
});

describe("session tree window filtering", () => {
  it("keeps an in-window cycle member as an unmounted entry", () => {
    const sessions = [makeSession("a", 100, { parent: "b" }), makeSession("b", 1, { parent: "a" })];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map((session) => session.id),
    ).toEqual(["a"]);
  });

  it("filters roots by activity and includes descendants regardless of their activity", () => {
    const sessions = [
      makeSession("parent", 100),
      makeSession("child-old", 1, { parent: "parent" }),
      makeSession("child-new", 999, { parent: "parent" }),
      makeSession("other", 1),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map((session) => session.id),
    ).toEqual(["parent", "child-old", "child-new"]);
  });

  it("keeps nested descendants and preserves the input order", () => {
    const sessions = [
      makeSession("grandchild", 1, { parent: "child" }),
      makeSession("child", 2, { parent: "parent" }),
      makeSession("parent", 100),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 100, 100).map((session) => session.id),
    ).toEqual(["grandchild", "child", "parent"]);
  });

  it("keeps an orphan whose own activity is in the window", () => {
    const sessions = [
      makeSession("orphan", 100, { parent: "missing" }),
      makeSession("stale-orphan", 1, { parent: "missing" }),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map((session) => session.id),
    ).toEqual(["orphan"]);
  });

  it("keeps mounted descendants below an in-window orphan", () => {
    const sessions = [
      makeSession("orphan", 100, { parent: "missing" }),
      makeSession("child", 1, { parent: "orphan" }),
      makeSession("grandchild", 1, { parent: "child" }),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map((session) => session.id),
    ).toEqual(["orphan", "child", "grandchild"]);
  });
});
