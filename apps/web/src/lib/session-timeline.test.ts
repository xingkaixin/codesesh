import { describe, expect, it } from "vitest";
import type { SessionHead } from "@codesesh/contract";
import {
  buildProjectTimeline,
  getProjectTimelinePage,
  getTimelineChildPage,
  TIMELINE_MAIN_PAGE_SIZE,
} from "./session-timeline";

const NOW = new Date(2026, 7, 6, 12, 0, 0).getTime();

function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 7, day, hour, minute).getTime();
}

function createSession(
  overrides: Partial<SessionHead> & { id: string; time_updated: number },
): SessionHead {
  const { id, ...sessionOverrides } = overrides;
  return {
    reference: { agentName: "codex", sessionId: id },
    title: id,
    directory: "/workspace/a",
    time_created: sessionOverrides.time_updated,
    stats: {
      message_count: 1,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
      total_cost: 0.5,
    },
    ...sessionOverrides,
  };
}

describe("buildProjectTimeline", () => {
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

    const rows = getProjectTimelinePage(timeline).days.flatMap((day) => day.rows);
    expect(rows.map((row) => row.routeKey)).toEqual(["codex/root"]);

    const root = rows[0]!;
    const children = getTimelineChildPage(root, 0, 10).rows;
    expect(root.childCount).toBe(3);
    expect(children.map((child) => child.routeKey)).toEqual([
      "codex/child-d",
      "codex/child-b",
      "codex/grandchild",
    ]);
    expect(root.messageCount).toBe(4);
    expect(root.tokens).toBe(60);
    expect(root.cost).toBeCloseTo(2);
    expect(children.every((child) => child.kind === undefined)).toBe(true);
    expect(children[0]).toMatchObject({
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

    const rows = getProjectTimelinePage(timeline).days[0]!.rows;
    expect(rows.map((row) => [row.routeKey, row.isOrphan])).toEqual([
      ["codex/orphan", true],
      ["codex/root", false],
    ]);
    expect(timeline.orphanCount).toBe(1);
  });

  it("keeps every cycle member once on the unmounted axis", () => {
    const timeline = buildProjectTimeline(
      [
        createSession({
          id: "a",
          time_updated: at(6, 9),
          parent_reference: { agentName: "codex", sessionId: "b" },
        }),
        createSession({
          id: "b",
          time_updated: at(6, 10),
          parent_reference: { agentName: "codex", sessionId: "a" },
        }),
        createSession({
          id: "below",
          time_updated: at(6, 11),
          parent_reference: { agentName: "codex", sessionId: "a" },
        }),
      ],
      { now: NOW },
    );

    const rows = getProjectTimelinePage(timeline).days.flatMap((day) => day.rows);
    expect(rows.map((row) => row.routeKey).toSorted()).toEqual([
      "codex/a",
      "codex/b",
      "codex/below",
    ]);
    expect(rows.every((row) => row.isOrphan)).toBe(true);
    expect(timeline.orphanCount).toBe(3);
  });
});

describe("timeline paging", () => {
  it("bounds main rows while preserving full day counts", () => {
    const today = Array.from({ length: 45 }, (_, index) =>
      createSession({ id: `today-${index}`, time_updated: at(6, 9, index) }),
    );
    const yesterday = Array.from({ length: 10 }, (_, index) =>
      createSession({ id: `yesterday-${index}`, time_updated: at(5, 9, index) }),
    );
    const timeline = buildProjectTimeline([...today, ...yesterday], { now: NOW });

    const firstPage = getProjectTimelinePage(timeline);
    const secondPage = getProjectTimelinePage(timeline, TIMELINE_MAIN_PAGE_SIZE);

    expect(firstPage.shown).toBe(TIMELINE_MAIN_PAGE_SIZE);
    expect(firstPage.days).toHaveLength(1);
    expect(firstPage.days[0]!.mainCount).toBe(45);
    expect(firstPage.hasNext).toBe(true);
    expect(secondPage.days.map((day) => [day.label, day.rows.length, day.mainCount])).toEqual([
      ["Today", 5, 45],
      ["Yesterday", 10, 10],
    ]);
    expect(secondPage.shown).toBe(15);
    expect(secondPage.hasPrevious).toBe(true);
    expect(secondPage.hasNext).toBe(false);
  });
});
