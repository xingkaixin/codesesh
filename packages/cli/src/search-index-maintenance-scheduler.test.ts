import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core/runtime/discovery";
import type { SearchIndexMaintenanceStatus } from "@codesesh/core/contract";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

const core = vi.hoisted(() => ({
  readCachedSessions: vi.fn(),
  readPendingSearchIndexMaintenance: vi.fn(),
}));

vi.mock("@codesesh/core/runtime/discovery", () => core);
vi.mock("./logging.js", () => ({
  appLogger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { SearchIndexMaintenanceScheduler } from "./search-index-maintenance-scheduler.js";

function makeSession(id: string): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    title: id,
    directory: "/workspace",
    time_created: 1,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function makeRunner() {
  return {
    enqueueMaintenance: vi.fn<(_context: string, _jobs: SearchIndexWorkerJob[]) => Promise<void>>(
      async () => undefined,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const sessions = [makeSession("one"), makeSession("two"), makeSession("three")];
  core.readCachedSessions.mockReturnValue({
    status: "success",
    value: {
      sessions,
      meta: Object.fromEntries(
        sessions.map((session) => [
          session.reference.sessionId,
          { id: session.reference.sessionId },
        ]),
      ),
      timestamp: 1,
    },
  });
});

describe("SearchIndexMaintenanceScheduler", () => {
  it.each([1_000, 2_000])("indexes %i sessions with linear lookup work", async (size) => {
    let referenceReads = 0;
    const sessionIds = Array.from({ length: size }, (_, index) => `session-${index}`);
    const sessions = sessionIds.map((id) => {
      const session = makeSession(id);
      const reference = session.reference;
      Object.defineProperty(session, "reference", {
        get() {
          referenceReads += 1;
          return reference;
        },
      });
      return session;
    });
    core.readCachedSessions.mockReturnValue({
      status: "success",
      value: { sessions, meta: {}, timestamp: 1 },
    });
    let processed = 0;
    core.readPendingSearchIndexMaintenance.mockImplementation((_agent, limit: number) => ({
      sessionIds: sessionIds.slice(processed, processed + limit),
      total: size - processed,
    }));
    const runner = makeRunner();
    runner.enqueueMaintenance.mockImplementation(async (_context, jobs) => {
      const job = jobs[0];
      if (job?.kind === "maintenance") processed += job.changes.length;
    });
    const scheduler = new SearchIndexMaintenanceScheduler(runner as never, () => undefined);

    scheduler.enqueue("codex");
    await scheduler.waitForIdle();

    expect(processed).toBe(size);
    expect(referenceReads).toBeLessThanOrEqual(size * 3);
  });

  it("commits bounded resumable batches until no maintenance remains", async () => {
    core.readPendingSearchIndexMaintenance
      .mockReturnValueOnce({ sessionIds: ["one", "two"], total: 3 })
      .mockReturnValueOnce({ sessionIds: ["three"], total: 1 })
      .mockReturnValueOnce({ sessionIds: ["three"], total: 1 })
      .mockReturnValueOnce({ sessionIds: [], total: 0 });
    const runner = makeRunner();
    const statuses: SearchIndexMaintenanceStatus[] = [];
    const scheduler = new SearchIndexMaintenanceScheduler(runner as never, (status) =>
      statuses.push(status),
    );

    scheduler.enqueue("codex");
    await scheduler.waitForIdle();

    expect(runner.enqueueMaintenance).toHaveBeenCalledTimes(2);
    expect(core.readCachedSessions).toHaveBeenCalledOnce();
    const jobs = runner.enqueueMaintenance.mock.calls.map(
      ([, batch]) => (batch as SearchIndexWorkerJob[])[0],
    );
    expect(jobs).toEqual([
      expect.objectContaining({ kind: "maintenance", changes: expect.any(Array) }),
      expect.objectContaining({ kind: "maintenance", changes: expect.any(Array) }),
    ]);
    expect(jobs.map((job) => (job?.kind === "maintenance" ? job.changes.length : 0))).toEqual([
      2, 1,
    ]);
    expect(
      jobs.flatMap((job) =>
        job?.kind === "maintenance"
          ? job.changes.map(({ session, sortIndex }) => [session.reference.sessionId, sortIndex])
          : [],
      ),
    ).toEqual([
      ["one", 0],
      ["two", 1],
      ["three", 2],
    ]);
    expect(statuses.at(-1)).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
    });
  });

  it("rebuilds the lookup when a new cache snapshot is enqueued during a batch", async () => {
    core.readPendingSearchIndexMaintenance
      .mockReturnValueOnce({ sessionIds: ["one", "two"], total: 3 })
      .mockReturnValueOnce({ sessionIds: ["three"], total: 1 })
      .mockReturnValueOnce({ sessionIds: ["three"], total: 1 })
      .mockReturnValueOnce({ sessionIds: [], total: 0 });
    let finishBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      finishBatch = resolve;
    });
    const runner = makeRunner();
    runner.enqueueMaintenance.mockReturnValueOnce(firstBatch);
    const scheduler = new SearchIndexMaintenanceScheduler(runner as never, () => undefined);

    scheduler.enqueue("codex");
    const updated = { ...makeSession("three"), title: "Updated session" };
    core.readCachedSessions.mockReturnValue({
      status: "success",
      value: { sessions: [updated], meta: { three: { id: "three" } }, timestamp: 2 },
    });
    scheduler.enqueue("codex");
    finishBatch();
    await scheduler.waitForIdle();

    expect(core.readCachedSessions).toHaveBeenCalledTimes(2);
    expect(runner.enqueueMaintenance.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        changes: [{ session: updated, sortIndex: 0 }],
        meta: { three: { id: "three" } },
      }),
    ]);
  });

  it("stops retrying a batch that cannot clear any durable marker", async () => {
    core.readPendingSearchIndexMaintenance.mockReturnValue({
      sessionIds: ["one"],
      total: 1,
    });
    const runner = makeRunner();
    const statuses: SearchIndexMaintenanceStatus[] = [];
    const scheduler = new SearchIndexMaintenanceScheduler(runner as never, (status) =>
      statuses.push(status),
    );

    scheduler.enqueue("codex");
    await scheduler.waitForIdle();

    expect(runner.enqueueMaintenance).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: ["codex"],
    });
  });

  it("marks maintenance failed when the session cache cannot be read", async () => {
    core.readPendingSearchIndexMaintenance.mockReturnValue({
      sessionIds: ["one"],
      total: 1,
    });
    core.readCachedSessions.mockReturnValue({ status: "failed" });
    const runner = makeRunner();
    const statuses: SearchIndexMaintenanceStatus[] = [];
    const scheduler = new SearchIndexMaintenanceScheduler(runner as never, (status) =>
      statuses.push(status),
    );

    scheduler.enqueue("codex");
    await scheduler.waitForIdle();

    expect(runner.enqueueMaintenance).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: [],
      failedAgents: ["codex"],
    });
  });
});
