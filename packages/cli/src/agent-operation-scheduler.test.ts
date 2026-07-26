import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentOperationScheduler, type AgentOperationResult } from "./agent-operation-scheduler.js";
import { appLogger } from "./logging.js";

function deferredResult() {
  let resolve!: (result: AgentOperationResult) => void;
  const promise = new Promise<AgentOperationResult>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AgentOperationScheduler", () => {
  it("keeps the earliest refresh deadline for repeated signals", async () => {
    vi.useFakeTimers();
    const runRefresh = vi.fn(async () => "unchanged" as const);
    const scheduler = new AgentOperationScheduler(runRefresh);

    scheduler.notify("codex", 200);
    await vi.advanceTimersByTimeAsync(50);
    scheduler.notify("codex", 200);
    await vi.advanceTimersByTimeAsync(149);
    expect(runRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runRefresh).toHaveBeenCalledOnce();
    expect(scheduler.takePendingSignalCount("codex")).toBe(2);
  });

  it("coalesces signals received while a refresh is running", async () => {
    vi.useFakeTimers();
    const first = deferredResult();
    const runRefresh = vi
      .fn<(agentName: string) => Promise<AgentOperationResult>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue("unchanged");
    const scheduler = new AgentOperationScheduler(runRefresh);

    const active = scheduler.refresh("codex");
    await vi.waitFor(() => expect(runRefresh).toHaveBeenCalledOnce());
    await scheduler.refresh("codex");
    await scheduler.refresh("codex");

    first.resolve("unchanged");
    await active;
    await vi.advanceTimersByTimeAsync(99);
    expect(runRefresh).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(runRefresh).toHaveBeenCalledTimes(2);
  });

  it("applies adaptive delay after an expensive refresh", async () => {
    vi.useFakeTimers();
    const runRefresh = vi.fn(async () => "unchanged" as const);
    const scheduler = new AgentOperationScheduler(runRefresh);
    scheduler.recordRefreshDuration("codex", 5_000);

    scheduler.notify("codex", 200);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(runRefresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(runRefresh).toHaveBeenCalledOnce();
  });

  it("serializes operations for one agent and advances their generations", async () => {
    const first = deferredResult();
    const log = vi.spyOn(appLogger, "info").mockImplementation(() => undefined);
    const scheduler = new AgentOperationScheduler(async () => "unchanged");
    const backfill = scheduler.run("codex", "backfill", () => first.promise);
    const refresh = scheduler.run("codex", "refresh", async () => "committed");

    await Promise.resolve();
    expect(log).toHaveBeenCalledTimes(1);
    first.resolve("committed");
    await Promise.all([backfill, refresh]);

    expect(
      log.mock.calls
        .filter(([event]) => String(event).startsWith("scan.agent_operation."))
        .map(([event, fields]) => [event, fields?.operation, fields?.generation, fields?.result]),
    ).toEqual([
      ["scan.agent_operation.started", "backfill", 1, undefined],
      ["scan.agent_operation.completed", "backfill", 1, "committed"],
      ["scan.agent_operation.started", "refresh", 2, undefined],
      ["scan.agent_operation.completed", "refresh", 2, "committed"],
    ]);
  });

  it("allows different agents to run concurrently", async () => {
    const codex = deferredResult();
    const kimi = deferredResult();
    const scheduler = new AgentOperationScheduler(async () => "unchanged");

    const codexRun = scheduler.run("codex", "backfill", () => codex.promise);
    const kimiRun = scheduler.run("kimi", "refresh", () => kimi.promise);
    await Promise.resolve();

    expect(scheduler.snapshot()).toEqual({ activeOperations: 2, activeRefreshes: 0 });
    kimi.resolve("committed");
    await kimiRun;
    await vi.waitFor(() => expect(scheduler.snapshot().activeOperations).toBe(1));

    codex.resolve("committed");
    await codexRun;
  });

  it("continues a serialized queue after an operation fails", async () => {
    vi.spyOn(appLogger, "info").mockImplementation(() => undefined);
    const scheduler = new AgentOperationScheduler(async () => "unchanged");
    const failed = scheduler.run("codex", "backfill", async () => {
      throw new Error("failed");
    });
    const next = scheduler.run("codex", "refresh", async () => "committed");

    await expect(failed).rejects.toThrow("failed");
    await expect(next).resolves.toBe("committed");
  });

  it("cancels timers and skips queued operations after stop", async () => {
    vi.useFakeTimers();
    const first = deferredResult();
    const runRefresh = vi.fn(async () => "unchanged" as const);
    const scheduler = new AgentOperationScheduler(runRefresh);
    scheduler.notify("codex", 200);
    const active = scheduler.run("kimi", "backfill", () => first.promise);
    const queued = scheduler.run("kimi", "refresh", async () => "committed");
    await Promise.resolve();

    scheduler.stop();
    first.resolve("committed");
    await active;
    await expect(queued).resolves.toBe("skipped");
    await scheduler.waitForIdle();
    await vi.advanceTimersByTimeAsync(200);
    scheduler.notify("codex", 0);

    expect(runRefresh).not.toHaveBeenCalled();
    expect(scheduler.takePendingSignalCount("codex")).toBe(0);
    expect(scheduler.snapshot()).toEqual({ activeOperations: 0, activeRefreshes: 0 });
  });
});
