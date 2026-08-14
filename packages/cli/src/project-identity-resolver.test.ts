import { beforeEach, describe, expect, it, vi } from "vitest";

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

    unref(): void {}

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
  return { FakeWorker, workers, consumeWorkerMessage: vi.fn(() => false) };
});

vi.mock("node:worker_threads", () => ({ Worker: workerMocks.FakeWorker }));
vi.mock("./logging.js", () => ({
  appLogger: { consumeWorkerMessage: workerMocks.consumeWorkerMessage },
}));

import { ThreadProjectIdentityResolver } from "./project-identity-resolver.js";

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

describe("ThreadProjectIdentityResolver", () => {
  it("limits concurrent resolution and dispatches queued work when a slot frees", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, 2);
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

  it("leaves the event loop free while a worker resolves", async () => {
    const resolver = new ThreadProjectIdentityResolver(workerUrl, 1);
    const pending = resolver.resolve("/slow");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(workerMocks.workers).toHaveLength(1);

    await resolver.shutdown();
    await expect(pending).rejects.toThrow("Project identity resolver shut down");
  });
});
