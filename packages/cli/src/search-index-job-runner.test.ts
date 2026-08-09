import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchIndexWorkerJob, SearchIndexWorkerMessage } from "./search-index-worker.js";

const workerMocks = vi.hoisted(() => {
  type Handler = (arg: never) => void;
  class FakeWorker {
    private handlers = new Map<string, Handler>();

    constructor() {
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

    post(message: SearchIndexWorkerMessage): void {
      (this.handlers.get("message") as ((arg: SearchIndexWorkerMessage) => void) | undefined)?.(
        message,
      );
    }
  }
  const workers: FakeWorker[] = [];
  return { workers, FakeWorker, workerExists: true };
});

vi.mock("node:worker_threads", () => ({ Worker: workerMocks.FakeWorker }));
vi.mock("node:fs", () => ({ existsSync: () => workerMocks.workerExists }));
vi.mock("./logging.js", () => ({
  appLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
});

describe("SearchIndexJobRunner", () => {
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
