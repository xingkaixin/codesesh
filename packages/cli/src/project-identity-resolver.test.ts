import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerMocks = vi.hoisted(() => {
  type Handler = (message: unknown) => void;

  class FakeWorker {
    private readonly handlers = new Map<string, Handler>();
    readonly postedMessages: unknown[] = [];
    terminated = false;

    constructor(_url: URL) {
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
      this.terminated = true;
      return 0;
    }

    emit(event: string, message: unknown): void {
      this.handlers.get(event)?.(message);
    }
  }

  const workers: FakeWorker[] = [];
  return {
    FakeWorker,
    workers,
    consumeWorkerMessage: vi.fn(() => false),
    warn: vi.fn(),
  };
});

vi.mock("node:worker_threads", () => ({ Worker: workerMocks.FakeWorker }));
vi.mock("./logging.js", () => ({
  appLogger: {
    consumeWorkerMessage: workerMocks.consumeWorkerMessage,
    warn: workerMocks.warn,
  },
}));

import {
  ProjectIdentityQueueFullError,
  ProjectIdentityRequestAbortedError,
  ProjectIdentityTimeoutError,
  ThreadProjectIdentityResolver,
} from "./project-identity-resolver.js";

const workerUrl = new URL("./project-identity-worker.js", import.meta.url);

function resolved(requestId: number, cwd: string) {
  return {
    type: "resolved" as const,
    requestId,
    projection: {
      identity: { kind: "path" as const, key: cwd, displayName: "project" },
      resolverRevision: "project-identity-v2",
      inputSignature: "test",
    },
  };
}

beforeEach(() => {
  workerMocks.workers.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ThreadProjectIdentityResolver", () => {
  it("limits concurrent resolution and dispatches queued work when a slot frees", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, { maxWorkers: 2 });
    const first = resolver.resolve("/one");
    const second = resolver.resolve("/two");
    const third = resolver.resolve("/three");

    expect(workerMocks.workers).toHaveLength(2);
    expect(workerMocks.workers.map((worker) => worker.postedMessages)).toEqual([
      [{ type: "resolve", requestId: 1, cwd: "/one" }],
      [{ type: "resolve", requestId: 2, cwd: "/two" }],
    ]);

    workerMocks.workers[0]!.emit("message", resolved(1, "/one"));
    await expect(first).resolves.toMatchObject({ identity: { key: "/one" } });
    expect(workerMocks.workers[0]!.postedMessages).toEqual([
      { type: "resolve", requestId: 1, cwd: "/one" },
      { type: "resolve", requestId: 3, cwd: "/three" },
    ]);

    workerMocks.workers[1]!.emit("message", resolved(2, "/two"));
    workerMocks.workers[0]!.emit("message", resolved(3, "/three"));
    await expect(second).resolves.toMatchObject({ identity: { key: "/two" } });
    await expect(third).resolves.toMatchObject({ identity: { key: "/three" } });
    await resolver.shutdown();
  });

  it("coalesces normalized directories while preserving subscriber cancellation", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, { maxWorkers: 1 });
    const controller = new AbortController();
    const first = resolver.resolve("/project/../project", controller.signal);
    const second = resolver.resolve("/project/");

    expect(workerMocks.workers).toHaveLength(1);
    expect(workerMocks.workers[0]!.postedMessages).toEqual([
      { type: "resolve", requestId: 1, cwd: "/project" },
    ]);

    controller.abort();
    await expect(first).rejects.toBeInstanceOf(ProjectIdentityRequestAbortedError);
    expect(workerMocks.workers[0]!.terminated).toBe(false);

    workerMocks.workers[0]!.emit("message", resolved(1, "/project"));
    await expect(second).resolves.toMatchObject({ identity: { key: "/project" } });
    await resolver.shutdown();
  });

  it("rejects new unique work when the bounded queue is full", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, {
      maxWorkers: 1,
      maxQueuedRequests: 1,
    });
    const first = resolver.resolve("/one");
    const second = resolver.resolve("/two");
    const coalesced = resolver.resolve("/two");

    await expect(resolver.resolve("/three")).rejects.toBeInstanceOf(ProjectIdentityQueueFullError);
    expect(workerMocks.warn).toHaveBeenCalledWith("project_identity.queue.full", {
      active_workers: 1,
      queued_requests: 1,
      request_capacity: 2,
    });

    workerMocks.workers[0]!.emit("message", resolved(1, "/one"));
    workerMocks.workers[0]!.emit("message", resolved(2, "/two"));
    await expect(first).resolves.toMatchObject({ identity: { key: "/one" } });
    await expect(second).resolves.toMatchObject({ identity: { key: "/two" } });
    await expect(coalesced).resolves.toMatchObject({ identity: { key: "/two" } });
    await resolver.shutdown();
  });

  it("terminates a timed-out worker and replaces it for queued work", async () => {
    vi.useFakeTimers();
    const resolver = new ThreadProjectIdentityResolver(workerUrl, {
      maxWorkers: 1,
      timeoutMs: 100,
    });
    const first = resolver.resolve("/one");
    const second = resolver.resolve("/two");
    const firstRejected = expect(first).rejects.toBeInstanceOf(ProjectIdentityTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await firstRejected;

    expect(workerMocks.workers[0]!.terminated).toBe(true);
    expect(workerMocks.workers).toHaveLength(2);
    expect(workerMocks.workers[1]!.postedMessages).toEqual([
      { type: "resolve", requestId: 2, cwd: "/two" },
    ]);

    workerMocks.workers[1]!.emit("message", resolved(2, "/two"));
    await expect(second).resolves.toMatchObject({ identity: { key: "/two" } });
    await resolver.shutdown();
  });

  it("removes aborted queued work without consuming queue capacity", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, {
      maxWorkers: 1,
      maxQueuedRequests: 1,
    });
    const controller = new AbortController();
    const first = resolver.resolve("/one");
    const aborted = resolver.resolve("/two", controller.signal);

    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(ProjectIdentityRequestAbortedError);
    const third = resolver.resolve("/three");

    workerMocks.workers[0]!.emit("message", resolved(1, "/one"));
    expect(workerMocks.workers[0]!.postedMessages.at(-1)).toEqual({
      type: "resolve",
      requestId: 3,
      cwd: "/three",
    });
    workerMocks.workers[0]!.emit("message", resolved(3, "/three"));
    await expect(first).resolves.toMatchObject({ identity: { key: "/one" } });
    await expect(third).resolves.toMatchObject({ identity: { key: "/three" } });
    await resolver.shutdown();
  });

  it("terminates active work when its final subscriber aborts", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, { maxWorkers: 1 });
    const controller = new AbortController();
    const aborted = resolver.resolve("/one", controller.signal);
    const second = resolver.resolve("/two");

    controller.abort();
    await expect(aborted).rejects.toBeInstanceOf(ProjectIdentityRequestAbortedError);
    await vi.waitFor(() => expect(workerMocks.workers).toHaveLength(2));

    expect(workerMocks.workers[0]!.terminated).toBe(true);
    expect(workerMocks.workers[1]!.postedMessages).toEqual([
      { type: "resolve", requestId: 2, cwd: "/two" },
    ]);
    workerMocks.workers[1]!.emit("message", resolved(2, "/two"));
    await expect(second).resolves.toMatchObject({ identity: { key: "/two" } });
    await resolver.shutdown();
  });
});
