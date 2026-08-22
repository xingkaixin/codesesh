import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSystemSessionSource } from "@codesesh/core/runtime";
import type { ScanStatusEvent } from "@codesesh/core/contract";
import {
  BackfillLifecycle,
  type BackfillAttemptRef,
  type BackfillTerminalStatus,
} from "./backfill-lifecycle.js";
import { AgentBackfillScheduler } from "./agent-backfill-scheduler.js";
import { appLogger } from "./logging.js";
import { ScanStatusReporter } from "./scan-status-reporter.js";

type LastFullSyncReadResult = { status: "success"; value: number | null } | { status: "failed" };

const core = vi.hoisted(() => ({
  readAgentLastFullSyncAt: vi.fn<() => LastFullSyncReadResult>(() => ({
    status: "success",
    value: Date.now(),
  })),
}));

vi.mock("@codesesh/core/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@codesesh/core/runtime")>()),
  readAgentLastFullSyncAt: core.readAgentLastFullSyncAt,
}));

class FakeSyncAgent extends FileSystemSessionSource {
  readonly name = "codex";
  readonly displayName = "Codex";

  isAvailable(): boolean {
    return true;
  }

  listSessionSources() {
    return [];
  }

  scanSessionSource() {
    return null;
  }

  getSessionData() {
    return { messages: [] } as never;
  }

  getSessionWatchPlan() {
    return { status: "not-needed" as const, reason: "backfill scheduler test adapter" };
  }
}

function makeScheduler(
  runAttempt: (attempt: BackfillAttemptRef) => Promise<BackfillTerminalStatus> = async () =>
    "committed",
) {
  const lifecycle = new BackfillLifecycle();
  const reporter = new ScanStatusReporter({ sessionCount: () => 0, backfills: lifecycle });
  const scheduleRefresh = vi.fn();
  const scheduler = new AgentBackfillScheduler({
    lifecycle,
    statusReporter: reporter,
    startupScanOptions: { from: 1 },
    runAttempt,
    scheduleRefresh,
  });
  return { lifecycle, reporter, scheduleRefresh, scheduler };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  core.readAgentLastFullSyncAt.mockReturnValue({ status: "success", value: Date.now() });
});

describe("AgentBackfillScheduler", () => {
  it("caches a recent full-sync marker until its interval expires", () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-12T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    core.readAgentLastFullSyncAt.mockReturnValue({ status: "success", value: now });
    const agent = new FakeSyncAgent();
    const isAvailable = vi.spyOn(agent, "isAvailable");
    const { scheduler } = makeScheduler();

    expect(scheduler.needsBackfill(agent)).toBe(false);
    expect(scheduler.needsBackfill(agent)).toBe(false);
    expect(isAvailable).not.toHaveBeenCalled();
    expect(core.readAgentLastFullSyncAt).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);

    expect(scheduler.needsBackfill(agent)).toBe(true);
    expect(isAvailable).toHaveBeenCalledOnce();
    expect(core.readAgentLastFullSyncAt).toHaveBeenCalledTimes(2);
  });

  it("does not enumerate raw sources after a recent full sync", () => {
    const agent = new FakeSyncAgent();
    const listSessionSources = vi.spyOn(agent, "listSessionSources");
    const { scheduler } = makeScheduler();

    expect(scheduler.needsBackfill(agent)).toBe(false);
    expect(listSessionSources).not.toHaveBeenCalled();
  });

  it("skips backfill when the full-sync timestamp cannot be read", () => {
    core.readAgentLastFullSyncAt.mockReturnValueOnce({ status: "failed" });
    const warn = vi.spyOn(appLogger, "warn");
    const { scheduler } = makeScheduler();

    expect(scheduler.needsBackfill(new FakeSyncAgent())).toBe(false);
    expect(warn).toHaveBeenCalledWith("scan.backfill.cache_state_unavailable", {
      agent: "codex",
      state: "last_full_sync",
    });
  });

  it("publishes only the latest attempt terminal", async () => {
    const runAttempt = vi
      .fn<(attempt: BackfillAttemptRef) => Promise<BackfillTerminalStatus>>()
      .mockResolvedValueOnce("committed")
      .mockResolvedValueOnce("failed");
    const { reporter, scheduler } = makeScheduler(runAttempt);

    scheduler.enqueue("codex");
    await vi.waitFor(() => expect(reporter.status().backfill.completedAgents).toEqual(["codex"]));
    scheduler.enqueue("codex");
    await vi.waitFor(() => expect(reporter.status().backfill.failedAgents).toEqual(["codex"]));

    expect(reporter.status().backfill).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: ["codex"],
    });
  });

  it("marks a rejected attempt failed and continues the queue", async () => {
    const runAttempt = vi
      .fn<(attempt: BackfillAttemptRef) => Promise<BackfillTerminalStatus>>()
      .mockRejectedValueOnce(new Error("backfill callback rejected"))
      .mockResolvedValueOnce("committed");
    const logError = vi.spyOn(appLogger, "error").mockImplementation(() => undefined);
    const { lifecycle, reporter, scheduler } = makeScheduler(runAttempt);
    reporter.subscribe(() => {
      throw new Error("status listener rejected");
    });

    scheduler.enqueue("codex");
    scheduler.enqueue("kimi");
    await vi.waitFor(() => expect(lifecycle.stateFor("kimi")?.status).toBe("committed"));

    expect(lifecycle.stateFor("codex")?.status).toBe("failed");
    expect(runAttempt).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      "scan.backfill.queue_error",
      expect.objectContaining({ agent: "codex", error: expect.any(Error) }),
    );
    expect(logError).toHaveBeenCalledWith(
      "scan.status_listener.error",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("schedules a refresh after a partial backfill", async () => {
    let lifecycle!: BackfillLifecycle;
    const runAttempt = vi.fn(async (attempt: BackfillAttemptRef) => {
      lifecycle.recordCompletion(attempt, {
        completeness: "partial",
        sourceFailureCount: 1,
        sourceFailureSummary: "SyntaxError: truncated JSON",
      });
      return "committed" as const;
    });
    const setup = makeScheduler(runAttempt);
    lifecycle = setup.lifecycle;

    setup.scheduler.enqueue("codex");
    await vi.waitFor(() => expect(lifecycle.stateFor("codex")?.status).toBe("committed"));

    expect(setup.scheduleRefresh).toHaveBeenCalledWith("codex", 5 * 60 * 1000);
  });

  it("cancels pending work and ignores late results after shutdown", async () => {
    let resolveAttempt!: (result: BackfillTerminalStatus) => void;
    const runAttempt = vi.fn(
      () =>
        new Promise<BackfillTerminalStatus>((resolve) => {
          resolveAttempt = resolve;
        }),
    );
    const { lifecycle, reporter, scheduler } = makeScheduler(runAttempt);
    const statuses: ScanStatusEvent[] = [];
    reporter.subscribe((status) => statuses.push(status));
    scheduler.enqueue("codex");
    await vi.waitFor(() => expect(lifecycle.stateFor("codex")?.status).toBe("running"));

    scheduler.shutdown();
    const statusCountAtShutdown = statuses.length;
    resolveAttempt("committed");
    await Promise.resolve();

    expect(lifecycle.stateFor("codex")?.status).toBe("cancelled");
    expect(runAttempt).toHaveBeenCalledOnce();
    expect(statuses).toHaveLength(statusCountAtShutdown);
  });
});
