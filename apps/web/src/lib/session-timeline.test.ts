import { describe, expect, it } from "vitest";
import type { SessionHead } from "@codesesh/core/contract";
import { buildProjectTimeline, isRowExpanded, type TimelineRow } from "./session-timeline";

const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 7, day, hour, minute).getTime();
}

function createSession(
  overrides: Partial<SessionHead> & { id: string; time_updated: number },
): SessionHead {
  return {
    slug: `codex/${overrides.id}`,
    title: overrides.id,
    directory: "/workspace/a",
    time_created: overrides.time_updated,
    stats: {
      message_count: 1,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
      total_cost: 0.5,
    },
    ...overrides,
  };
}

describe("buildProjectTimeline", () => {
  it("labels days relative to now", () => {
    const timeline = buildProjectTimeline(
      [
        createSession({ id: "today", time_updated: at(6, 9) }),
        createSession({ id: "yesterday", time_updated: at(5, 9) }),
        createSession({ id: "older", time_updated: at(4, 9) }),
      ],
      { now: NOW },
    );

    expect(timeline.days.map((day) => day.label)).toEqual(["今天", "昨天", "8月4日"]);
    expect(timeline.days.map((day) => day.dayKey)).toEqual([
      "2026-08-06",
      "2026-08-05",
      "2026-08-04",
    ]);
  });

  it("keeps mounted children out of the main axis and rolls their stats into the parent", () => {
    const timeline = buildProjectTimeline(
      [
        createSession({ id: "root", time_updated: at(6, 9) }),
        createSession({
          id: "child-b",
          time_updated: at(6, 10),
          parent_reference: { agentName: "codex", sessionId: "root" },
        }),
        createSession({
          id: "grandchild",
          time_updated: at(6, 11),
          parent_reference: { agentName: "codex", sessionId: "child-b" },
        }),
        createSession({
          id: "child-d",
          time_updated: at(6, 9, 30),
          parent_reference: { agentName: "codex", sessionId: "root" },
        }),
      ],
      { now: NOW },
    );

    const rows = timeline.days.flatMap((day) => day.rows);
    expect(rows.map((row) => row.routeKey)).toEqual(["codex/root"]);

    const root = rows[0]!;
    expect(root.childCount).toBe(3);
    expect(root.children.map((child) => child.routeKey)).toEqual([
      "codex/child-d",
      "codex/child-b",
      "codex/grandchild",
    ]);
    expect(root.messageCount).toBe(4);
    expect(root.tokens).toBe(60);
    expect(root.cost).toBeCloseTo(2);
    expect(root.children.every((child) => child.kind === undefined)).toBe(true);
    expect(root.children[0]).toMatchObject({
      reference: { agentName: "codex", sessionId: "child-d" },
      messageCount: 1,
      cost: 0.5,
    });
  });

  it("puts orphans on the axis and counts them", () => {
    const timeline = buildProjectTimeline(
      [
        createSession({ id: "root", time_updated: at(6, 9) }),
        createSession({
          id: "orphan",
          time_updated: at(6, 10),
          parent_reference: { agentName: "codex", sessionId: "gone" },
        }),
      ],
      { now: NOW },
    );

    const rows = timeline.days[0]!.rows;
    expect(rows.map((row) => [row.routeKey, row.isOrphan])).toEqual([
      ["codex/orphan", true],
      ["codex/root", false],
    ]);
    expect(timeline.orphanCount).toBe(1);
  });

  it("reports main and sub counts per day and across the timeline", () => {
    const timeline = buildProjectTimeline(
      [
        createSession({ id: "a", time_updated: at(6, 9) }),
        createSession({ id: "b", time_updated: at(6, 10) }),
        createSession({
          id: "a-child",
          time_updated: at(6, 11),
          parent_reference: { agentName: "codex", sessionId: "a" },
        }),
        createSession({ id: "c", time_updated: at(5, 9) }),
      ],
      { now: NOW },
    );

    expect(timeline.days.map((day) => [day.mainCount, day.subCount])).toEqual([
      [2, 1],
      [1, 0],
    ]);
    expect(timeline.mainCount).toBe(3);
    expect(timeline.subCount).toBe(1);
    expect(timeline.totalTokens).toBe(60);
  });

  it("is empty for an empty snapshot", () => {
    expect(buildProjectTimeline([], { now: NOW })).toEqual({
      days: [],
      orphanCount: 0,
      mainCount: 0,
      subCount: 0,
      totalTokens: 0,
    });
  });
});

describe("isRowExpanded", () => {
  const parent = { routeKey: "codex/root", childCount: 2 } as TimelineRow;
  const leaf = { routeKey: "codex/leaf", childCount: 0 } as TimelineRow;
  const open = new Set(["codex/root", "codex/leaf"]);
  const closed = new Set<string>();

  it.each([
    ["collapsed" as const, open, true],
    ["collapsed" as const, closed, false],
    ["expanded" as const, open, true],
    ["expanded" as const, closed, true],
    ["hidden" as const, open, false],
    ["hidden" as const, closed, false],
  ])("resolves %s mode against the open set", (mode, openIds, expected) => {
    expect(isRowExpanded(parent, mode, openIds)).toBe(expected);
  });

  it("never expands a row without children", () => {
    expect(isRowExpanded(leaf, "collapsed", open)).toBe(false);
    expect(isRowExpanded(leaf, "expanded", open)).toBe(false);
    expect(isRowExpanded(leaf, "hidden", open)).toBe(false);
  });
});
