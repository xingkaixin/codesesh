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

  it("moves agents from scanning to publishing before completion", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex", "claude"], "scanning", {});
    model.beginAgent("codex", 2);

    const codexQueued = model.queueAgentPublication("codex");
    expect(codexQueued?.agentStatuses.codex?.status).toBe("publish-queued");
    const codexPublishing = model.publishAgent("codex");

    expect(codexPublishing).toEqual(
      expect.objectContaining({
        phase: "scanning",
        pendingAgents: ["claude"],
      }),
    );
    expect(codexPublishing?.agentStatuses.codex?.status).toBe("publishing");

    model.beginAgent("claude", 3);
    model.queueAgentPublication("claude");
    const allPublishing = model.publishAgent("claude");
    expect(allPublishing?.phase).toBe("publishing");

    const oneRemaining = model.finishAgent("codex");
    expect(oneRemaining.phase).toBe("publishing");
    expect(model.updateAgent("claude", { processed: 1 })).toBeNull();
  });

  it("reports session finalization separately from source scanning", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex"], "scanning", {});
    model.beginAgent("codex", 2);

    const status = model.updateAgent("codex", {
      phase: "finalizing",
      total: 4,
      processed: 2,
      sessions: 2,
    });

    expect(status).toEqual(
      expect.objectContaining({
        phase: "publishing",
        scanningAgents: ["codex"],
      }),
    );
    expect(status?.agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "finalizing",
        total: 4,
        processed: 2,
        sessions: 2,
      }),
    );
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
        completedAgents: ["codex", "claude"],
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

  it("retains an actionable failure until the next scan starts", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex"], "scanning", { codex: 2 });
    model.beginAgent("codex", 2);

    const failed = model.failAgent("codex", "cache is read-only");

    expect(failed).toEqual(
      expect.objectContaining({ active: false, phase: "idle", completedAgents: [] }),
    );
    expect(failed.agentStatuses.codex).toEqual(
      expect.objectContaining({ status: "failed", error: "cache is read-only" }),
    );
    expect(model.finishBatch().agentStatuses.codex?.status).toBe("failed");

    const retry = model.beginAgent("codex", 2);
    expect(retry.agentStatuses.codex).toEqual(expect.objectContaining({ status: "scanning" }));
    expect(retry.agentStatuses.codex).not.toHaveProperty("error");
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

  it("keeps partial snapshot completion separate from a completed lifecycle", () => {
    const model = new ScanStatusModel();
    model.startBatch(["codex"], "scanning", { codex: 1 });
    model.beginAgent("codex", 1);

    const complete = model.finishAgent("codex", 1, {
      completeness: "partial",
      sourceFailureCount: 1,
      sourceFailureSummary: "SyntaxError: truncated JSON",
    });

    expect(complete.agentStatuses.codex).toEqual(
      expect.objectContaining({
        status: "complete",
        completeness: "partial",
        sourceFailureCount: 1,
        sourceFailureSummary: "SyntaxError: truncated JSON",
      }),
    );
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
      completedAgents: [],
      failedAgents: [],
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

  it("keeps backfill progress separate from the main agent statuses", () => {
    const model = new ScanStatusModel();

    const status = model.updateBackfill({
      active: true,
      currentAgent: "codex",
      pendingAgents: [],
      progress: { phase: "finalizing", total: 2107, processed: 68, sessions: 2108 },
      completedAgents: [],
      failedAgents: [],
    });

    expect(status.backfill.progress).toEqual({
      phase: "finalizing",
      total: 2107,
      processed: 68,
      sessions: 2108,
    });
    expect(status.agentStatuses).toEqual({});
  });

  it("replaces the complete backfill snapshot and clears stale progress", () => {
    const model = new ScanStatusModel();
    model.updateBackfill({
      active: true,
      currentAgent: "codex",
      pendingAgents: [],
      progress: { phase: "publishing", sessions: 10 },
      completedAgents: [],
      failedAgents: [],
    });

    const status = model.updateBackfill({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
    });

    expect(status.backfill).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
    });
  });

  it("copies partial backfill completion into the status snapshot", () => {
    const model = new ScanStatusModel();
    const status = model.updateBackfill({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
      partialAgents: {
        codex: {
          completeness: "partial",
          sourceFailureCount: 1,
          sourceFailureSummary: "SyntaxError: truncated JSON",
        },
      },
    });

    status.backfill.partialAgents!.codex!.sourceFailureCount = 2;

    expect(model.snapshot().backfill.partialAgents?.codex?.sourceFailureCount).toBe(1);
  });

  it("tracks search-index maintenance independently from session scanning", () => {
    const model = new ScanStatusModel();
    const status = model.updateSearchIndexMaintenance({
      active: true,
      currentAgent: "codex",
      pendingAgents: ["zcode"],
      remaining: 2215,
      completedAgents: [],
      failedAgents: [],
    });

    expect(status).toEqual(
      expect.objectContaining({
        active: false,
        phase: "idle",
        searchIndexMaintenance: {
          active: true,
          currentAgent: "codex",
          pendingAgents: ["zcode"],
          remaining: 2215,
          completedAgents: [],
          failedAgents: [],
        },
      }),
    );
  });
});
