import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

const workerMocks = vi.hoisted(() => {
  type Handler = (arg: never) => void;
  class FakeWorker {
    private handlers = new Map<string, Handler>();
    readonly workerData: Record<string, unknown>;
    readonly postedMessages: unknown[] = [];

    constructor(_url: URL, options?: { workerData?: Record<string, unknown> }) {
      this.workerData = options?.workerData ?? {};
      workers.push(this);
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler);
      return this;
    }

    postMessage(message: unknown): void {
      this.postedMessages.push(message);
    }

    async terminate(): Promise<number> {
      return 0;
    }

    post(message: unknown): void {
      (this.handlers.get("message") as ((arg: unknown) => void) | undefined)?.(message);
    }
  }
  const workers: FakeWorker[] = [];
  return {
    workers,
    FakeWorker,
    workerExists: true,
    consumeWorkerMessage: vi.fn((_message: unknown) => false),
  };
});

vi.mock("node:worker_threads", () => ({ Worker: workerMocks.FakeWorker }));
vi.mock("node:fs", () => ({ existsSync: () => workerMocks.workerExists }));
vi.mock("@codesesh/core/runtime/pricing", () => ({
  getPricingGeneration: () => ({ id: 17 }),
}));
vi.mock("./logging.js", () => ({
  appLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    consumeWorkerMessage: workerMocks.consumeWorkerMessage,
  },
  logSearchIndexSync: vi.fn(),
}));

import { SearchIndexJobRunner } from "./search-index-job-runner.js";

function makeJob(): SearchIndexWorkerJob {
  return {
    kind: "changes",
    context: "scan.refresh",
    agentName: "codex",
    changes: [],
    removedSessionIds: ["gone"],
    meta: {},
  };
}

function makeMaintenanceJob(agentName = "codex"): SearchIndexWorkerJob {
  return {
    kind: "maintenance",
    context: "search.maintenance",
    agentName,
    changes: [],
    removedSessionIds: [],
    meta: {},
  };
}

function startedWorker() {
  const worker = workerMocks.workers.at(-1);
  if (!worker) throw new Error("no search index worker was started");
  return worker;
}

beforeEach(() => {
  workerMocks.workers.length = 0;
  workerMocks.workerExists = true;
  vi.clearAllMocks();
  workerMocks.consumeWorkerMessage.mockReturnValue(false);
});

describe("SearchIndexJobRunner", () => {
  it("consumes worker logs without settling the active batch", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.refresh", [makeJob()]);
    const worker = startedWorker();
    const logMessage = { type: "codesesh.worker-log" };
    workerMocks.consumeWorkerMessage.mockImplementation((message) => message === logMessage);

    worker.post(logMessage);
    worker.post({
      type: "done",
      context: "scan.refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });

    expect(workerMocks.consumeWorkerMessage).toHaveBeenNthCalledWith(1, logMessage);
    await expect(completion).resolves.toBeUndefined();
  });

  it("reports durable publication stages from the worker", async () => {
    const runner = new SearchIndexJobRunner();
    const progress = vi.fn();
    const completion = runner.enqueue("scan.backfill", [makeJob()], undefined, progress);
    const worker = startedWorker();
    worker.post({ type: "publication-progress", agentName: "codex", stage: "prepared" });

    expect(progress).toHaveBeenCalledWith({ agentName: "codex", stage: "prepared" });
    worker.post({
      type: "done",
      context: "scan.backfill",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await completion;
  });

  it("pins each worker batch to the current pricing generation", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.refresh", [makeJob()]);
    const worker = startedWorker();

    expect(worker.workerData.pricingGenerationId).toBe(17);
    worker.post({
      type: "done",
      context: "scan.refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await completion;
  });

  it("resolves the batch when the worker reports done", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.refresh", [makeJob()]);

    startedWorker().post({
      type: "done",
      context: "scan.refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });

    await expect(completion).resolves.toBeUndefined();
  });

  it("reuses one worker for consecutive batches", async () => {
    const runner = new SearchIndexJobRunner();
    const first = runner.enqueue("scan.refresh", [makeJob()]);
    const worker = startedWorker();
    worker.post({
      type: "done",
      context: "scan.refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await first;

    const second = runner.enqueue("scan.refresh", [makeJob()]);

    expect(workerMocks.workers).toEqual([worker]);
    expect(worker.postedMessages).toEqual([
      expect.objectContaining({ context: "scan.refresh", pricingGenerationId: 17 }),
    ]);
    worker.post({
      type: "done",
      context: "scan.refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await second;
  });

  it("dispatches a queued batch after the active batch completes", async () => {
    const runner = new SearchIndexJobRunner();
    const started: string[] = [];
    const first = runner.enqueue("first-refresh", [makeJob()], () => started.push("first"));
    const worker = startedWorker();
    const second = runner.enqueue("second-refresh", [makeJob()], () => started.push("second"));

    expect(started).toEqual(["first"]);

    worker.post({
      type: "done",
      context: "first-refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await first;

    expect(started).toEqual(["first", "second"]);
    expect(worker.postedMessages).toEqual([
      expect.objectContaining({ context: "second-refresh", pricingGenerationId: 17 }),
    ]);
    worker.post({
      type: "done",
      context: "second-refresh",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await second;
  });

  it("runs foreground publications before the next maintenance batch", async () => {
    const runner = new SearchIndexJobRunner();
    const firstMaintenance = runner.enqueueMaintenance("maintenance-one", [makeMaintenanceJob()]);
    const worker = startedWorker();
    const secondMaintenance = runner.enqueueMaintenance("maintenance-two", [
      makeMaintenanceJob("claudecode"),
    ]);
    const foreground = runner.enqueue("scan.backfill", [makeJob()]);

    worker.post({
      type: "done",
      context: "maintenance-one",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await firstMaintenance;
    expect(worker.postedMessages).toEqual([expect.objectContaining({ context: "scan.backfill" })]);

    worker.post({
      type: "done",
      context: "scan.backfill",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await foreground;
    expect(worker.postedMessages).toEqual([
      expect.objectContaining({ context: "scan.backfill" }),
      expect.objectContaining({ context: "maintenance-two" }),
    ]);

    worker.post({
      type: "done",
      context: "maintenance-two",
      durationMs: 1,
      sessions: 1,
      failedAgents: [],
    });
    await secondMaintenance;
  });

  it("CS-137: rejects the batch when the worker reports a persistence failure", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.refresh", [makeJob()]);

    startedWorker().post({
      type: "persist-failed",
      context: "scan.refresh",
      stage: "cache",
      publicationId: "scan.refresh:codex:1",
      agentName: "codex",
      sessions: 1,
      fatal: true,
    });

    await expect(completion).rejects.toThrow(/failed to persist cache for codex/);
  });

  it("resolves a batch whose non-fatal failures were reported per agent", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.initial", [makeJob()]);

    const worker = startedWorker();
    worker.post({
      type: "persist-failed",
      context: "scan.initial",
      stage: "search_index",
      publicationId: "generated",
      agentName: "codex",
      sessions: 1,
      fatal: false,
    });
    worker.post({
      type: "done",
      context: "scan.initial",
      durationMs: 1,
      sessions: 1,
      failedAgents: ["codex"],
    });

    await expect(completion).resolves.toBeUndefined();
  });

  it("rejects the batch when the search-index worker is unavailable", async () => {
    workerMocks.workerExists = false;
    const runner = new SearchIndexJobRunner();

    const completion = runner.enqueue("scan.refresh", [makeJob()]);

    await expect(completion).rejects.toThrow("Search index worker is unavailable");
    expect(workerMocks.workers).toHaveLength(0);
  });
});
