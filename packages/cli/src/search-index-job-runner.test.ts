import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexWorkerJob } from "./search-index-worker.js";

const workerMocks = vi.hoisted(() => {
  type Handler = (arg: never) => void;
  class FakeWorker {
    private handlers = new Map<string, Handler>();
    readonly workerData: Record<string, unknown>;

    constructor(_url: URL, options?: { workerData?: Record<string, unknown> }) {
      this.workerData = options?.workerData ?? {};
      workers.push(this);
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler);
      return this;
    }

    unref(): void {}

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
vi.mock("@codesesh/core", () => ({ getPricingGeneration: () => ({ id: 17 }) }));
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
    worker.post({ type: "done", context: "scan.refresh", durationMs: 1, sessions: 1 });

    expect(workerMocks.consumeWorkerMessage).toHaveBeenNthCalledWith(1, logMessage);
    await expect(completion).resolves.toBeUndefined();
  });

  it("pins each worker batch to the current pricing generation", async () => {
    const runner = new SearchIndexJobRunner();
    const completion = runner.enqueue("scan.refresh", [makeJob()]);
    const worker = startedWorker();

    expect(worker.workerData.pricingGenerationId).toBe(17);
    worker.post({ type: "done", context: "scan.refresh", durationMs: 1, sessions: 1 });
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
    });

    await expect(completion).resolves.toBeUndefined();
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
    });

    await expect(completion).rejects.toThrow(/failed to persist cache for codex/);
  });

  it("rejects the batch when the search-index worker is unavailable", async () => {
    workerMocks.workerExists = false;
    const runner = new SearchIndexJobRunner();

    const completion = runner.enqueue("scan.refresh", [makeJob()]);

    await expect(completion).rejects.toThrow("Search index worker is unavailable");
    expect(workerMocks.workers).toHaveLength(0);
  });
});
