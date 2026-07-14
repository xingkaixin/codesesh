import { describe, expect, it } from "vitest";
import { BackfillCoordinator } from "./backfill-coordinator.js";

describe("BackfillCoordinator", () => {
  it("serializes unique agents and records completion", () => {
    const coordinator = new BackfillCoordinator();

    expect(coordinator.enqueue("codex")).toEqual(
      expect.objectContaining({ active: true, pendingAgents: ["codex"] }),
    );
    expect(coordinator.enqueue("codex")).toBeNull();
    coordinator.enqueue("claude");

    const first = coordinator.take()!;
    expect(first.agentName).toBe("codex");
    expect(first.status).toEqual(
      expect.objectContaining({ currentAgent: "codex", pendingAgents: ["claude"] }),
    );
    expect(coordinator.take()).toBeNull();

    expect(coordinator.complete("codex")).toEqual(
      expect.objectContaining({ completedAgents: ["codex"], pendingAgents: ["claude"] }),
    );
    expect(coordinator.take()?.agentName).toBe("claude");
  });

  it("clears queued and active work during shutdown", () => {
    const coordinator = new BackfillCoordinator();
    coordinator.enqueue("codex");
    coordinator.take();
    coordinator.enqueue("claude");

    coordinator.clear();

    expect(coordinator.isRunning).toBe(false);
    expect(coordinator.snapshot()).toEqual({
      active: false,
      pendingAgents: [],
      currentAgent: undefined,
      completedAgents: [],
      failedAgents: [],
    });
  });

  it("reports failed work separately from completed coverage", () => {
    const coordinator = new BackfillCoordinator();
    coordinator.enqueue("cursor");
    coordinator.take();

    expect(coordinator.complete("cursor", false)).toEqual(
      expect.objectContaining({ completedAgents: [], failedAgents: ["cursor"] }),
    );
  });
});
