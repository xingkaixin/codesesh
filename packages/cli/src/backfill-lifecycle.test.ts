import { describe, expect, it } from "vitest";
import { BackfillLifecycle, type BackfillTerminalStatus } from "./backfill-lifecycle.js";

function expectValidStatus(lifecycle: BackfillLifecycle): void {
  const status = lifecycle.status();
  const terminal = new Set([...status.completedAgents, ...status.failedAgents]);
  expect(terminal.size).toBe(status.completedAgents.length + status.failedAgents.length);
  expect(status.progress == null || status.currentAgent != null).toBe(true);
  expect(status.currentAgent == null || !status.pendingAgents.includes(status.currentAgent)).toBe(
    true,
  );
  expect(status.active).toBe(status.currentAgent != null || status.pendingAgents.length > 0);
}

describe("BackfillLifecycle", () => {
  it.each<BackfillTerminalStatus>(["committed", "failed", "skipped"])(
    "transitions queued to running to %s",
    (terminal) => {
      const lifecycle = new BackfillLifecycle();
      lifecycle.enqueue("codex");
      expect(lifecycle.status()).toMatchObject({ active: true, pendingAgents: ["codex"] });

      const attempt = lifecycle.startNext()!;
      expect(lifecycle.status()).toMatchObject({ currentAgent: "codex", pendingAgents: [] });
      expect(lifecycle.updateProgress(attempt, { phase: "scanning", processed: 2 })).toBe(true);
      expect(lifecycle.updateProgress(attempt, { phase: "publishing", sessions: 3 })).toBe(true);
      expect(lifecycle.status().progress).toEqual({
        phase: "publishing",
        processed: 2,
        sessions: 3,
      });
      expect(lifecycle.complete(attempt, terminal)).toBe(true);

      expect(lifecycle.stateFor("codex")?.status).toBe(terminal);
      expectValidStatus(lifecycle);
    },
  );

  it("replaces a committed attempt with a later failed attempt", () => {
    const lifecycle = new BackfillLifecycle();
    lifecycle.enqueue("codex");
    lifecycle.complete(lifecycle.startNext()!, "committed");
    lifecycle.enqueue("codex");
    lifecycle.complete(lifecycle.startNext()!, "failed");

    expect(lifecycle.status()).toMatchObject({ completedAgents: [], failedAgents: ["codex"] });
    expectValidStatus(lifecycle);
  });

  it("replaces a failed attempt with a later committed attempt", () => {
    const lifecycle = new BackfillLifecycle();
    lifecycle.enqueue("codex");
    lifecycle.complete(lifecycle.startNext()!, "failed");
    lifecycle.enqueue("codex");
    lifecycle.complete(lifecycle.startNext()!, "committed");

    expect(lifecycle.status()).toMatchObject({ completedAgents: ["codex"], failedAgents: [] });
    expectValidStatus(lifecycle);
  });

  it("retains partial snapshot completion after a committed attempt", () => {
    const lifecycle = new BackfillLifecycle();
    lifecycle.enqueue("codex");
    const attempt = lifecycle.startNext()!;

    expect(
      lifecycle.recordCompletion(attempt, {
        completeness: "partial",
        sourceFailureCount: 1,
        sourceFailureSummary: "SyntaxError: truncated JSON",
      }),
    ).toBe(true);
    lifecycle.complete(attempt, "committed");

    expect(lifecycle.status().partialAgents).toEqual({
      codex: {
        completeness: "partial",
        sourceFailureCount: 1,
        sourceFailureSummary: "SyntaxError: truncated JSON",
      },
    });
  });

  it("ignores progress and results from an older attempt", () => {
    const lifecycle = new BackfillLifecycle();
    lifecycle.enqueue("codex");
    const first = lifecycle.startNext()!;
    lifecycle.complete(first, "failed");
    lifecycle.enqueue("codex");
    const retry = lifecycle.startNext()!;

    expect(lifecycle.updateProgress(first, { phase: "publishing" })).toBe(false);
    expect(lifecycle.complete(first, "committed")).toBe(false);
    expect(lifecycle.stateFor("codex")).toMatchObject({
      status: "running",
      attemptId: retry.attemptId,
    });
    expectValidStatus(lifecycle);
  });

  it("cancels queued and running attempts without accepting late results", () => {
    const lifecycle = new BackfillLifecycle();
    lifecycle.enqueue("codex");
    const running = lifecycle.startNext()!;
    lifecycle.enqueue("claude");

    lifecycle.cancelAll();

    expect(lifecycle.stateFor("codex")?.status).toBe("cancelled");
    expect(lifecycle.stateFor("claude")?.status).toBe("cancelled");
    expect(lifecycle.complete(running, "committed")).toBe(false);
    expect(lifecycle.status()).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: [],
    });
    expectValidStatus(lifecycle);
  });
});
