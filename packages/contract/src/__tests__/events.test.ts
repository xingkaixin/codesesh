import { describe, expect, it } from "vitest";
import { mergeSessionsUpdatedEvents, type SessionsUpdatedEvent } from "../events.js";
import type { ReferencedSessionHead } from "../session.js";

function event(
  changedSessionHeads: ReferencedSessionHead[],
  removedSessionRefs: SessionsUpdatedEvent["removedSessionRefs"] = [],
  projectionRelatedSessionHeads: ReferencedSessionHead[] = [],
  newSessionRefs: SessionsUpdatedEvent["newSessionRefs"] = [],
): SessionsUpdatedEvent {
  return {
    type: "sessions-updated",
    changedAgents: ["claudecode"],
    newSessionRefs,
    totalSessions: 2,
    timestamp: 1,
    changedSessionHeads,
    projectionRelatedSessionHeads,
    removedSessionRefs,
  };
}

describe("mergeSessionsUpdatedEvents", () => {
  it("keeps the latest change for each session", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const first = {
      reference,
      session: { display_title: "Before" },
    } as ReferencedSessionHead;
    const latest = {
      reference,
      session: { display_title: "After" },
    } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(event([first]), event([latest]));

    expect(merged.changedSessionHeads).toEqual([latest]);
  });

  it("lets the latest removal replace an earlier change", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const changed = { reference, session: {} } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(event([changed]), event([], [reference]));

    expect(merged.changedSessionHeads).toEqual([]);
    expect(merged.removedSessionRefs).toEqual([reference]);
  });

  it("keeps projection-related heads separate from actual changes", () => {
    const changedReference = { agentName: "claudecode", sessionId: "changed" };
    const relatedReference = { agentName: "claudecode", sessionId: "related" };
    const changed = {
      reference: changedReference,
      session: {},
    } as ReferencedSessionHead;
    const related = {
      reference: relatedReference,
      session: {},
    } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(event([], [], [related]), event([changed]));

    expect(merged.changedSessionHeads).toEqual([changed]);
    expect(merged.projectionRelatedSessionHeads).toEqual([related]);
  });

  it("lets a later change or removal replace a projection-related head", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const related = { reference, session: {} } as ReferencedSessionHead;
    const changed = {
      reference,
      session: { display_title: "changed" },
    } as ReferencedSessionHead;

    const changedMerge = mergeSessionsUpdatedEvents(event([], [], [related]), event([changed]));
    const removedMerge = mergeSessionsUpdatedEvents(
      event([], [], [related]),
      event([], [reference]),
    );

    expect(changedMerge.changedSessionHeads).toEqual([changed]);
    expect(changedMerge.projectionRelatedSessionHeads).toEqual([]);
    expect(removedMerge.projectionRelatedSessionHeads).toEqual([]);
    expect(removedMerge.removedSessionRefs).toEqual([reference]);
  });

  it("removes a coalesced new-session reference when that session is removed", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const added = {
      ...event([], [], [], [reference]),
      projectionSessionOrder: [reference],
    };

    const merged = mergeSessionsUpdatedEvents(added, event([], [reference]));

    expect(merged.newSessionRefs).toEqual([]);
    expect(merged.projectionSessionOrder).toEqual([]);
  });

  it("keeps a coalesced addition classified as new after a later update", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const added = { reference, session: { display_title: "Added" } } as ReferencedSessionHead;
    const updated = {
      reference,
      session: { display_title: "Updated" },
    } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(
      event([added], [], [], [reference]),
      event([updated]),
    );

    expect(merged.newSessionRefs).toEqual([reference]);
    expect(merged.changedSessionHeads).toEqual([updated]);
    expect(merged.removedSessionRefs).toEqual([]);
  });

  it("treats a re-created removed session as the latest change", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const recreated = {
      reference,
      session: { display_title: "Re-created" },
    } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(
      event([], [reference]),
      event([recreated], [], [], [reference]),
    );

    expect(merged.newSessionRefs).toEqual([reference]);
    expect(merged.changedSessionHeads).toEqual([recreated]);
    expect(merged.removedSessionRefs).toEqual([]);
  });

  it("uses the latest canonical order for an affected activity tie", () => {
    const first = { agentName: "claudecode", sessionId: "first" };
    const second = { agentName: "claudecode", sessionId: "second" };
    const previous = { ...event([]), projectionSessionOrder: [first, second] };
    const next = { ...event([]), projectionSessionOrder: [second, first] };

    const merged = mergeSessionsUpdatedEvents(previous, next);

    expect(merged.projectionSessionOrder).toEqual([second, first]);
  });
});
