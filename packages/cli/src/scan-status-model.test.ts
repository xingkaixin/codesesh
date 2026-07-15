import { describe, expect, it } from "vitest";
import { ScanStatusModel } from "./scan-status-model.js";

describe("ScanStatusModel", () => {
  it("keeps empty batches idle and ignores phase changes while inactive", () => {
    const model = new ScanStatusModel();

    const status = model.startBatch([], "scanning", {});

    expect(status).toEqual(
      expect.objectContaining({
        active: false,
        phase: "idle",
        totalAgents: 0,
        startedAt: undefined,
        completedAt: expect.any(Number),
      }),
    );
    expect(model.setPhase("initializing")).toBeNull();
  });

  it("starts an implicit batch when an agent begins while idle", () => {
    const model = new ScanStatusModel();

    const status = model.beginAgent("codex", 3);

    expect(status).toEqual(
      expect.objectContaining({
        active: true,
        phase: "scanning",
        pendingAgents: [],
        scanningAgents: ["codex"],
        totalAgents: 1,
      }),
    );
    expect(status.agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "scanning",
        processed: 0,
        sessions: 3,
        startedAt: expect.any(Number),
      }),
    );
  });

  it("preserves initialization and existing progress when an agent restarts", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex"], "initializing", {});
    const firstStart = model.beginAgent("codex", 2);
    model.updateAgent("codex", { total: 5, processed: 2 });

    const restarted = model.beginAgent("codex", 9);

    expect(firstStart.phase).toBe("initializing");
    expect(restarted.phase).toBe("initializing");
    expect(restarted.agentStatuses.codex).toEqual(
      expect.objectContaining({
        total: 5,
        processed: 2,
        sessions: 0,
        startedAt: firstStart.agentStatuses.codex?.startedAt,
      }),
    );
    expect(restarted.scanningAgents).toEqual(["codex"]);
  });

  it("ignores invalid progress and retains fields omitted from updates", () => {
    const model = new ScanStatusModel();

    expect(model.updateAgent("missing", { processed: 1 })).toBeNull();
    model.beginAgent("codex", 2);
    const unchanged = model.updateAgent("codex", {});
    const updated = model.updateAgent("codex", { processed: 1 });
    const complete = model.finishAgent("codex");

    expect(unchanged?.agentStatuses.codex).toEqual(
      expect.objectContaining({ total: undefined, processed: 0, sessions: 2 }),
    );
    expect(updated?.agentStatuses.codex).toEqual(
      expect.objectContaining({ total: undefined, processed: 1, sessions: 2 }),
    );
    expect(complete.agentStatuses.codex).toEqual(
      expect.objectContaining({ total: 1, processed: 1, sessions: 2 }),
    );
    expect(model.updateAgent("codex", { processed: 2 })).toBeNull();
  });

  it("completes unseen agents and normalizes unfinished statuses at batch end", () => {
    const model = new ScanStatusModel();
    const unseen = model.finishAgent("codex");

    expect(unseen.agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "complete",
        total: undefined,
        processed: undefined,
        sessions: 0,
        startedAt: undefined,
      }),
    );

    model.startBatch(["codex", "claude"], "scanning", {});
    const codexComplete = model.finishAgent("codex");
    const complete = model.finishBatch();

    expect(complete).toEqual(
      expect.objectContaining({
        active: false,
        phase: "idle",
        pendingAgents: [],
        scanningAgents: [],
        completedAt: expect.any(Number),
      }),
    );
    expect(complete.agentStatuses.codex?.completedAt).toBe(
      codexComplete.agentStatuses.codex?.completedAt,
    );
    expect(complete.agentStatuses.claude).toEqual(
      expect.objectContaining({ status: "complete", completedAt: expect.any(Number) }),
    );
  });

  it("models a complete multi-agent scan lifecycle", () => {
    const model = new ScanStatusModel();

    model.startBatch(["codex", "claude", "codex"], "scanning", {
      codex: 2,
      claude: 3,
    });
    expect(model.setPhase("initializing")?.phase).toBe("initializing");
    model.beginAgent("codex", 2);
    model.updateAgent("codex", { total: 4, processed: 2, sessions: 3 });
    const firstComplete = model.finishAgent("codex", 4);

    expect(firstComplete).toEqual(
      expect.objectContaining({
        active: true,
        pendingAgents: ["claude"],
        completedAgents: ["codex"],
      }),
    );
    expect(firstComplete.agentStatuses.codex).toEqual(
      expect.objectContaining({ status: "complete", total: 4, processed: 4, sessions: 4 }),
    );

    model.beginAgent("claude", 3);
    const complete = model.finishAgent("claude", 3);
    expect(complete.active).toBe(false);
    expect(complete.phase).toBe("idle");
    expect(complete.completedAgents).toEqual(["codex", "claude"]);
  });

  it("returns detached snapshots", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex"], "initializing", { codex: 1 });
    const snapshot = model.snapshot();
    snapshot.pendingAgents.length = 0;
    snapshot.agentStatuses.codex!.status = "complete";

    expect(model.snapshot().pendingAgents).toEqual(["codex"]);
    expect(model.snapshot().agentStatuses.codex!.status).toBe("pending");
  });

  it("tracks backfill independently from the scan phase", () => {
    const model = new ScanStatusModel();
    const status = model.updateBackfill({
      active: true,
      currentAgent: "codex",
      pendingAgents: ["claude"],
    });

    expect(status.phase).toBe("idle");
    expect(status.backfill).toEqual({
      active: true,
      currentAgent: "codex",
      pendingAgents: ["claude"],
      completedAgents: [],
      failedAgents: [],
    });
  });
});
