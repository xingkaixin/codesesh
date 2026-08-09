import { describe, expect, it } from "vitest";
import type { BaseAgent, LiveSnapshot, SessionHead } from "@codesesh/core";
import { LiveSessionIndex } from "./live-session-index.js";

function makeAgent(name: string): BaseAgent {
  return {
    name,
    displayName: name,
  } as BaseAgent;
}

function makeSession(id: string, updatedAt: number, title = id): SessionHead {
  return {
    id,
    slug: `codex/${id}`,
    title,
    directory: "/workspace",
    time_created: updatedAt,
    time_updated: updatedAt,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function snapshot(agents: BaseAgent[], byAgent: Record<string, SessionHead[]>): LiveSnapshot {
  return { agents, byAgent, sessions: Object.values(byAgent).flat() };
}

describe("LiveSessionIndex", () => {
  it("keeps a failed agent out of the empty-success projection until recovery", () => {
    const codex = makeAgent("codex");
    const recovered = makeSession("recovered", 1);
    const index = new LiveSessionIndex();
    index.initialize({
      agents: [codex],
      byAgent: {},
      sessions: [],
      scanFailures: {
        codex: {
          agentName: "codex",
          stage: "opening the database",
          errorClass: "SessionScanError",
          message: "database unavailable",
        },
      },
    });

    expect(index.snapshot().byAgent.codex).toBeUndefined();
    expect(index.snapshot().scanFailures?.codex).toBeDefined();

    index.commitAgentSessions("codex", [recovered]);

    expect(index.snapshot().byAgent.codex).toEqual([recovered]);
    expect(index.snapshot().scanFailures).toBeUndefined();
  });

  it("initializes sorted views for the allowed agent catalog", () => {
    const codex = makeAgent("codex");
    const kimi = makeAgent("kimi");
    const cursor = makeAgent("cursor");
    const older = makeSession("older", 1);
    const newer = makeSession("newer", 3);
    const index = new LiveSessionIndex();

    index.initialize(snapshot([codex], { codex: [older, newer] }), {
      registeredAgents: [codex, kimi, cursor],
      allowedAgents: new Set(["codex", "kimi"]),
    });

    expect(index.snapshot()).toEqual({
      agents: [codex, kimi],
      byAgent: { codex: [newer, older], kimi: [] },
      sessions: [newer, older],
    });
    expect(index.findAgent("kimi")).toBe(kimi);
    expect(index.findAgent("cursor")).toBeUndefined();
  });

  it("commits one agent shard and publishes counts against the global view", () => {
    const codex = makeAgent("codex");
    const kimi = makeAgent("kimi");
    const previous = makeSession("previous", 2, "before");
    const updated = makeSession("previous", 4, "after");
    const added = makeSession("added", 1);
    const other = makeSession("other", 3);
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex, kimi], { codex: [previous], kimi: [other] }));

    const event = index.commitAgentSessions("codex", [added, updated], [updated.id]);

    expect(index.snapshot().byAgent.codex).toEqual([updated, added]);
    expect(index.snapshot().sessions).toEqual([updated, other, added]);
    expect(event).toEqual({
      type: "sessions-updated",
      changedAgents: ["codex"],
      newSessions: 1,
      updatedSessions: 1,
      removedSessions: 0,
      totalSessions: 3,
      timestamp: expect.any(Number),
      changedSessionHeads: [
        {
          reference: { agentName: "codex", sessionId: "added" },
          session: added,
        },
        {
          reference: { agentName: "codex", sessionId: "previous" },
          session: updated,
        },
      ],
      removedSessionRefs: [],
    });
  });

  it("updates the snapshot even when no event is needed", () => {
    const codex = makeAgent("codex");
    const original = makeSession("session", 1);
    const equivalent = { ...original };
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex], { codex: [original] }));

    expect(index.commitAgentSessions("codex", [equivalent])).toBeNull();
    expect(index.snapshot().sessions[0]).toBe(equivalent);
  });

  it("resets signature lineage when a new snapshot is initialized", () => {
    const codex = makeAgent("codex");
    const original = makeSession("session", 1, "original");
    const firstCommit = makeSession("session", 2, "first commit");
    const reloaded = makeSession("session", 3, "reloaded");
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex], { codex: [original] }));
    index.commitAgentSessions("codex", [firstCommit]);

    index.initialize(snapshot([codex], { codex: [reloaded] }));

    expect(index.commitAgentSessions("codex", [reloaded])).toBeNull();
  });

  it("removes sessions from both agent and global views", () => {
    const codex = makeAgent("codex");
    const removed = makeSession("removed", 1);
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex], { codex: [removed] }));

    const event = index.commitAgentSessions("codex", []);

    expect(index.snapshot().byAgent.codex).toEqual([]);
    expect(index.snapshot().sessions).toEqual([]);
    expect(event).toEqual(
      expect.objectContaining({
        newSessions: 0,
        updatedSessions: 0,
        removedSessions: 1,
        totalSessions: 0,
        changedSessionHeads: [],
        removedSessionRefs: [{ agentName: "codex", sessionId: "removed" }],
      }),
    );
  });
});
