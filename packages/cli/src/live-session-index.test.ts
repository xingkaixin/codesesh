import { describe, expect, it } from "vitest";
import type { BaseAgent, IdentifiedSessionHead, LiveSnapshot } from "@codesesh/core";
import { LiveSessionIndex } from "./live-session-index.js";

function makeAgent(name: string): BaseAgent {
  return {
    name,
    displayName: name,
  } as BaseAgent;
}

function makeSession(
  id: string,
  updatedAt: number,
  title = id,
  agentName = "codex",
): IdentifiedSessionHead {
  return {
    reference: { agentName, sessionId: id },
    id,
    slug: `${agentName}/${id}`,
    title,
    directory: "/workspace",
    project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
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

function snapshot(
  agents: BaseAgent[],
  byAgent: Record<string, IdentifiedSessionHead[]>,
): LiveSnapshot {
  return { agents, byAgent, sessions: Object.values(byAgent).flat() };
}

describe("LiveSessionIndex", () => {
  it("rejects unresolved project identities at snapshot boundaries", () => {
    const codex = makeAgent("codex");
    const unresolved = {
      ...makeSession("unresolved", 1),
      project_identity: undefined,
    } as unknown as IdentifiedSessionHead;
    const index = new LiveSessionIndex();

    expect(() => index.initialize(snapshot([codex], { codex: [unresolved] }))).toThrow(
      "Session codex/unresolved is missing project_identity",
    );

    index.initialize(snapshot([codex], { codex: [] }));
    expect(() => index.commitAgentSessions("codex", [unresolved])).toThrow(
      "Session codex/unresolved is missing project_identity",
    );
  });

  it("rejects conflicting session identities at snapshot boundaries", () => {
    const codex = makeAgent("codex");
    const conflicting = { ...makeSession("session", 1), id: "other" };
    const index = new LiveSessionIndex();

    expect(() => index.initialize(snapshot([codex], { codex: [conflicting] }))).toThrow(
      "Session identity fields disagree",
    );

    index.initialize(snapshot([codex], { codex: [] }));
    expect(() => index.commitAgentSessions("codex", [conflicting])).toThrow(
      "Session identity fields disagree",
    );
  });

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

  it("retains a cache persistence failure until a durable publication succeeds", () => {
    const codex = makeAgent("codex");
    const cached = makeSession("cached", 1);
    const refreshed = makeSession("refreshed", 2);
    const index = new LiveSessionIndex();
    index.initialize({
      agents: [codex],
      byAgent: { codex: [cached] },
      sessions: [cached],
      cacheFailures: { codex: { agentName: "codex" } },
    });

    expect(index.snapshot().cacheFailures).toEqual({ codex: { agentName: "codex" } });
    expect(index.snapshot().byAgent.codex).toEqual([cached]);

    index.commitAgentSessions("codex", [refreshed]);

    expect(index.snapshot().cacheFailures).toBeUndefined();
    expect(index.snapshot().byAgent.codex).toEqual([refreshed]);
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
    const other = makeSession("other", 3, "other", "kimi");
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex, kimi], { codex: [previous], kimi: [other] }));

    const event = index.commitAgentSessions("codex", [added, updated], [updated.id]);

    expect(index.snapshot().byAgent.codex).toEqual([updated, added]);
    expect(index.snapshot().sessions).toEqual([updated, other, added]);
    expect(event).toEqual({
      type: "sessions-updated",
      changedAgents: ["codex"],
      newSessions: 1,
      newSessionRefs: [{ agentName: "codex", sessionId: "added" }],
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
      projectionRelatedSessionHeads: [],
      projectionSessionOrder: [
        { agentName: "codex", sessionId: "previous" },
        { agentName: "codex", sessionId: "added" },
      ],
      removedSessionRefs: [],
    });
  });

  it("publishes unchanged hierarchy members needed to project a changed root", () => {
    const codex = makeAgent("codex");
    const root = makeSession("root", 1, "before");
    const changedRoot = makeSession("root", 100, "after");
    const child = {
      ...makeSession("child", 1),
      parent_reference: { agentName: "codex", sessionId: "root" },
    };
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex], { codex: [root, child] }));

    const event = index.commitAgentSessions("codex", [changedRoot, child], [changedRoot.id]);

    expect(event?.projectionRelatedSessionHeads).toEqual([
      {
        reference: { agentName: "codex", sessionId: "child" },
        session: child,
      },
    ]);
  });

  it("publishes surviving hierarchy members when their parent is removed", () => {
    const codex = makeAgent("codex");
    const root = makeSession("root", 1);
    const child = {
      ...makeSession("child", 100),
      parent_reference: { agentName: "codex", sessionId: "root" },
    };
    const index = new LiveSessionIndex();
    index.initialize(snapshot([codex], { codex: [root, child] }));

    const event = index.commitAgentSessions("codex", [child]);

    expect(event?.projectionRelatedSessionHeads).toEqual([
      {
        reference: { agentName: "codex", sessionId: "child" },
        session: child,
      },
    ]);
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
