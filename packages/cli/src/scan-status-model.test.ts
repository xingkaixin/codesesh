import { describe, expect, it } from "vitest";
import { ScanStatusModel } from "./scan-status-model.js";

describe("ScanStatusModel", () => {
  it("models a complete multi-agent scan lifecycle", () => {
    const model = new ScanStatusModel();

    model.startBatch(["codex", "claude", "codex"], "scanning", {
      codex: 2,
      claude: 3,
    });
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
    });
  });
});
