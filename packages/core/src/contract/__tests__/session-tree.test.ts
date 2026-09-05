import { describe, expect, it } from "vitest";
import type { CostSource, SessionHead } from "../session.js";
import {
  applySessionWindowChanges,
  buildSessionTree,
  createSessionProjectionContext,
  filterSessionTreeByActivityWindow,
  groupSessionsByCalendarDay,
} from "../session-tree.js";
import { sortSessionsByActivity } from "../session-index.js";

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
    reference: { agentName: "codex", sessionId: id },
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
  return nodes.map((node) => node.session.reference.sessionId);
}

function referenced(session: SessionHead) {
  return {
    reference: { agentName: "codex", sessionId: session.reference.sessionId },
    session,
  };
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
      visible.push(node.session.reference.sessionId);
      pending.push(...node.children);
    }

    expect([...visible].sort()).toEqual(
      sessions.map((session) => session.reference.sessionId).sort(),
    );
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

  it("deduplicates repeated route keys before building the hierarchy", () => {
    const tree = buildSessionTree([
      makeSession("root", 1, { messages: 1, cost: 1 }),
      makeSession("root", 2, { messages: 10, cost: 10 }),
      makeSession("child", 3, { parent: "root", messages: 2, cost: 2 }),
    ]);

    expect(ids(tree.entries)).toEqual(["root"]);
    expect(tree.byRouteKey.size).toBe(2);
    expect(tree.entries[0]?.inclusiveStats).toMatchObject({ messageCount: 3, cost: 3 });
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
      filterSessionTreeByActivityWindow(sessions, 90, 110).map(
        (session) => session.reference.sessionId,
      ),
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
      filterSessionTreeByActivityWindow(sessions, 90, 110).map(
        (session) => session.reference.sessionId,
      ),
    ).toEqual(["parent", "child-old", "child-new"]);
  });

  it("keeps nested descendants and preserves the input order", () => {
    const sessions = [
      makeSession("grandchild", 1, { parent: "child" }),
      makeSession("child", 2, { parent: "parent" }),
      makeSession("parent", 100),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 100, 100).map(
        (session) => session.reference.sessionId,
      ),
    ).toEqual(["grandchild", "child", "parent"]);
  });

  it("keeps an orphan whose own activity is in the window", () => {
    const sessions = [
      makeSession("orphan", 100, { parent: "missing" }),
      makeSession("stale-orphan", 1, { parent: "missing" }),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map(
        (session) => session.reference.sessionId,
      ),
    ).toEqual(["orphan"]);
  });

  it("keeps mounted descendants below an in-window orphan", () => {
    const sessions = [
      makeSession("orphan", 100, { parent: "missing" }),
      makeSession("child", 1, { parent: "orphan" }),
      makeSession("grandchild", 1, { parent: "child" }),
    ];

    expect(
      filterSessionTreeByActivityWindow(sessions, 90, 110).map(
        (session) => session.reference.sessionId,
      ),
    ).toEqual(["orphan", "child", "grandchild"]);
  });

  it("collects unchanged hierarchy members around changes and removals", () => {
    const oldRoot = makeSession("root", 1);
    const recentRoot = makeSession("root", 100);
    const child = makeSession("child", 1, { parent: "root" });
    const grandchild = makeSession("grandchild", 1, { parent: "child" });
    const unrelated = makeSession("unrelated", 1);

    expect(
      createSessionProjectionContext(
        [oldRoot, child, grandchild, unrelated],
        [recentRoot, child, grandchild, unrelated],
        [referenced(recentRoot)],
        [],
      ).relatedSessionHeads.map(({ session }) => session.reference.sessionId),
    ).toEqual(["child", "grandchild"]);
    expect(
      createSessionProjectionContext(
        [oldRoot, child, grandchild],
        [child, grandchild],
        [],
        [{ agentName: "codex", sessionId: "root" }],
      ).relatedSessionHeads.map(({ session }) => session.reference.sessionId),
    ).toEqual(["child", "grandchild"]);
  });

  it.each([false, true])(
    "collects shared ancestors independently of descendant visits (reverse=%s)",
    (reverse) => {
      const sessions = [
        makeSession("root", 1),
        makeSession("trunk", 2, { parent: "root" }),
        makeSession("branch", 3, { parent: "trunk" }),
        makeSession("leaf", 4, { parent: "branch" }),
        makeSession("sibling", 5, { parent: "trunk" }),
        makeSession("unrelated", 6),
      ];
      const changed = [sessions[2]!, sessions[3]!];
      if (reverse) changed.reverse();
      const context = createSessionProjectionContext(
        sessions,
        sessions,
        changed.map(referenced),
        [],
      );
      expect(context.relatedSessionHeads.map(({ session }) => session.reference.sessionId)).toEqual(
        ["root", "trunk"],
      );
      expect(context.sessionOrder).toEqual(
        sessions.slice(0, 4).map((session) => session.reference),
      );
    },
  );

  it("collects shared cyclic ancestors without including unrelated sibling subtrees", () => {
    const sessions = [
      makeSession("a", 1, { parent: "b" }),
      makeSession("b", 2, { parent: "a" }),
      makeSession("leaf-a", 3, { parent: "a" }),
      makeSession("leaf-b", 4, { parent: "b" }),
      makeSession("sibling", 5, { parent: "a" }),
    ];
    const context = createSessionProjectionContext(
      sessions,
      sessions,
      sessions.slice(2, 4).map(referenced),
      [],
    );
    expect(context.relatedSessionHeads.map(({ session }) => session.reference.sessionId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("does not copy unaffected sibling subtrees into a projection event", () => {
    const root = makeSession("root", 100);
    const child = makeSession("child", 1, { parent: "root" });
    const changedChild = { ...child, title: "changed" };
    const grandchild = makeSession("grandchild", 1, { parent: "child" });
    const sibling = makeSession("sibling", 1, { parent: "root" });

    expect(
      createSessionProjectionContext(
        [root, child, grandchild, sibling],
        [root, changedChild, grandchild, sibling],
        [referenced(changedChild)],
        [],
      ).relatedSessionHeads.map(({ session }) => session.reference.sessionId),
    ).toEqual(["root", "grandchild"]);
  });

  it.each([
    {
      name: "window-external backfill",
      previous: [makeSession("recent", 100)],
      next: [makeSession("recent", 100), makeSession("historical", 1)],
      changedIds: ["historical"],
      removedIds: [],
    },
    {
      name: "root entering the window",
      previous: [makeSession("root", 1), makeSession("child", 1, { parent: "root" })],
      next: [makeSession("root", 100), makeSession("child", 1, { parent: "root" })],
      changedIds: ["root"],
      removedIds: [],
    },
    {
      name: "root leaving the window",
      previous: [makeSession("root", 100), makeSession("child", 1, { parent: "root" })],
      next: [makeSession("root", 1), makeSession("child", 1, { parent: "root" })],
      changedIds: ["root"],
      removedIds: [],
    },
    {
      name: "parent removal revealing a recent orphan",
      previous: [makeSession("root", 1), makeSession("child", 100, { parent: "root" })],
      next: [makeSession("child", 100, { parent: "root" })],
      changedIds: [],
      removedIds: ["root"],
    },
    {
      name: "root moving below a hidden parent",
      previous: [makeSession("root", 100), makeSession("hidden", 1)],
      next: [makeSession("root", 100, { parent: "hidden" }), makeSession("hidden", 1)],
      changedIds: ["root"],
      removedIds: [],
    },
    {
      name: "cycle member leaving the window",
      previous: [makeSession("a", 1, { parent: "b" }), makeSession("b", 100, { parent: "a" })],
      next: [makeSession("a", 1, { parent: "b" }), makeSession("b", 1, { parent: "a" })],
      changedIds: ["b"],
      removedIds: [],
    },
  ])("matches a full reload after $name", ({ previous, next, changedIds, removedIds }) => {
    const sortedPrevious = sortSessionsByActivity(previous);
    const sortedNext = sortSessionsByActivity(next);
    const previousProjection = filterSessionTreeByActivityWindow(sortedPrevious, 90, 110);
    const changedSessionHeads = changedIds.map((id) =>
      referenced(sortedNext.find((session) => session.reference.sessionId === id)!),
    );
    const removedSessionRefs = removedIds.map((sessionId) => ({
      agentName: "codex",
      sessionId,
    }));
    const projectionContext = createSessionProjectionContext(
      sortedPrevious,
      sortedNext,
      changedSessionHeads,
      removedSessionRefs,
    );

    const incremental = applySessionWindowChanges(previousProjection, {
      changedSessionHeads,
      projectionRelatedSessionHeads: projectionContext.relatedSessionHeads,
      projectionSessionOrder: projectionContext.sessionOrder,
      removedSessionRefs,
      from: 90,
      to: 110,
    });
    const reloaded = filterSessionTreeByActivityWindow(sortedNext, 90, 110);

    expect(incremental.sessions).toEqual(reloaded);
  });

  it("stays equivalent to a full reload across a backfill and hierarchy transition sequence", () => {
    const recentRoot = makeSession("recent-root", 100);
    const recentChild = makeSession("recent-child", 1, { parent: "recent-root" });
    const hiddenRoot = makeSession("hidden-root", 1);
    const hiddenChild = makeSession("hidden-child", 100, { parent: "hidden-root" });
    const historical = makeSession("historical", 1);
    const initial = sortSessionsByActivity([recentRoot, recentChild, hiddenRoot, hiddenChild]);
    const afterBackfill = sortSessionsByActivity([...initial, historical]);
    const afterRecentRootLeaves = sortSessionsByActivity([
      makeSession("recent-root", 1),
      recentChild,
      hiddenRoot,
      hiddenChild,
      historical,
    ]);
    const afterHiddenRootEnters = sortSessionsByActivity([
      makeSession("recent-root", 1),
      recentChild,
      makeSession("hidden-root", 100),
      hiddenChild,
      historical,
    ]);
    const afterHiddenRootRemoval = afterHiddenRootEnters.filter(
      (session) => session.reference.sessionId !== "hidden-root",
    );
    const transitions = [
      { next: afterBackfill, changedIds: ["historical"], removedIds: [] },
      { next: afterRecentRootLeaves, changedIds: ["recent-root"], removedIds: [] },
      { next: afterHiddenRootEnters, changedIds: ["hidden-root"], removedIds: [] },
      { next: afterHiddenRootRemoval, changedIds: [], removedIds: ["hidden-root"] },
    ];
    let globalSessions = initial;
    let projectedSessions = filterSessionTreeByActivityWindow(initial, 90, 110);

    for (const transition of transitions) {
      const changedSessionHeads = transition.changedIds.map((id) =>
        referenced(transition.next.find((session) => session.reference.sessionId === id)!),
      );
      const removedSessionRefs = transition.removedIds.map((sessionId) => ({
        agentName: "codex",
        sessionId,
      }));
      const projectionContext = createSessionProjectionContext(
        globalSessions,
        transition.next,
        changedSessionHeads,
        removedSessionRefs,
      );

      projectedSessions = applySessionWindowChanges(projectedSessions, {
        changedSessionHeads,
        projectionRelatedSessionHeads: projectionContext.relatedSessionHeads,
        projectionSessionOrder: projectionContext.sessionOrder,
        removedSessionRefs,
        from: 90,
        to: 110,
      }).sessions;
      globalSessions = transition.next;

      expect(projectedSessions).toEqual(filterSessionTreeByActivityWindow(globalSessions, 90, 110));
    }
  });

  it("preserves all-history behavior and treats a zero lower bound as present", () => {
    const initial = [makeSession("zero", 0)];
    const added = makeSession("added", 1);
    const changedSessionHeads = [referenced(added)];

    expect(
      applySessionWindowChanges(initial, {
        changedSessionHeads,
        removedSessionRefs: [],
      }).sessions,
    ).toEqual([added, initial[0]]);
    expect(
      applySessionWindowChanges(initial, {
        changedSessionHeads,
        removedSessionRefs: [],
        from: 0,
      }).sessions,
    ).toEqual([added, initial[0]]);
  });
});
