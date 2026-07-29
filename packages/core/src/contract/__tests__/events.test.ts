import { describe, expect, it } from "vitest";
import { mergeSessionsUpdatedEvents, type SessionsUpdatedEvent } from "../events.js";
import type { ReferencedSessionHead } from "../session.js";

function event(
  changedSessionHeads: ReferencedSessionHead[],
  removedSessionRefs: SessionsUpdatedEvent["removedSessionRefs"] = [],
): SessionsUpdatedEvent {
  return {
    type: "sessions-updated",
    changedAgents: ["claudecode"],
    newSessions: 0,
    updatedSessions: changedSessionHeads.length,
    removedSessions: removedSessionRefs.length,
    totalSessions: 2,
    timestamp: 1,
    changedSessionHeads,
    removedSessionRefs,
  };
}

describe("mergeSessionsUpdatedEvents", () => {
  it("keeps the latest change for each session", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const first = {
      reference,
      session: { id: "session-1", display_title: "Before" },
    } as ReferencedSessionHead;
    const latest = {
      reference,
      session: { id: "session-1", display_title: "After" },
    } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(event([first]), event([latest]));

    expect(merged.changedSessionHeads).toEqual([latest]);
  });

  it("lets the latest removal replace an earlier change", () => {
    const reference = { agentName: "claudecode", sessionId: "session-1" };
    const changed = { reference, session: { id: "session-1" } } as ReferencedSessionHead;

    const merged = mergeSessionsUpdatedEvents(event([changed]), event([], [reference]));

    expect(merged.changedSessionHeads).toEqual([]);
    expect(merged.removedSessionRefs).toEqual([reference]);
  });
});
