import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core/runtime";
import type { SearchIndexMaintenanceStatus } from "@codesesh/core/contract";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

const core = vi.hoisted(() => ({
  loadCachedSessions: vi.fn(),
  readPendingSearchIndexMaintenance: vi.fn(),
}));

vi.mock("@codesesh/core/runtime", () => core);
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
  core.loadCachedSessions.mockReturnValue({
    sessions,
    meta: Object.fromEntries(
      sessions.map((session) => [session.reference.sessionId, { id: session.reference.sessionId }]),
    ),
    timestamp: 1,
  });
});

describe("SearchIndexMaintenanceScheduler", () => {
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
    expect(core.loadCachedSessions).toHaveBeenCalledOnce();
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
    expect(statuses.at(-1)).toEqual({
      active: false,
      pendingAgents: [],
      completedAgents: ["codex"],
      failedAgents: [],
    });
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
});
