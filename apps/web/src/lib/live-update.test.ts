import { describe, expect, it } from "vitest";
import { applyLiveSessionUpdate, compareSessionActivityDesc } from "./live-update";
import type { SessionHead, SessionsUpdatedEvent } from "./api";

function makeSession(id: string, time: number): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/tmp",
    time_created: time,
    time_updated: time,
    stats: { message_count: 0, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
  };
}

describe("compareSessionActivityDesc", () => {
  it("sorts newest first", () => {
    const sessions = [makeSession("a", 100), makeSession("b", 500)];
    sessions.sort(compareSessionActivityDesc);
    expect(sessions[0]!.id).toBe("b");
  });
});

describe("applyLiveSessionUpdate", () => {
  it("returns null for incomplete event", () => {
    expect(
      applyLiveSessionUpdate([], {
        changedSessionHeads: null,
        removedSessionRefs: null,
      } as unknown as never),
    ).toBeNull();
  });

  it("applies changes and removals", () => {
    const sessions = [makeSession("a", 100), makeSession("b", 200)];
    const event = {
      changedSessionHeads: [{ agentName: "codex", session: makeSession("c", 300) }],
      removedSessionRefs: [{ agentName: "codex", sessionId: "a" }],
    } as unknown as SessionsUpdatedEvent;

    const result = applyLiveSessionUpdate(sessions, event);
    expect(result).not.toBeNull();
    expect(result!.map((s) => s.id).sort()).toEqual(["b", "c"]);
  });

  it("sorts result by activity desc", () => {
    const event = {
      changedSessionHeads: [{ agentName: "codex", session: makeSession("new", 999) }],
      removedSessionRefs: [],
    } as unknown as SessionsUpdatedEvent;
    const result = applyLiveSessionUpdate([makeSession("old", 100)], event);
    expect(result![0]!.id).toBe("new");
  });
});
