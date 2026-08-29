import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSnapshot } from "@codesesh/core/runtime/discovery";
import { SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";

const mocks = vi.hoisted(() => ({ cached: vi.fn(), workers: [] as any[] }));
vi.mock("@codesesh/core/runtime/discovery", () => ({
  materializeCachedSessionDetailResponse: mocks.cached,
}));
vi.mock("./logging.js", () => ({
  appLogger: {
    info: vi.fn(),
    consumeWorkerMessage: vi.fn(() => false),
    captureContext: vi.fn(() => ({})),
  },
}));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    postMessage = vi.fn((message: { type?: string; requestId?: string }) => {
      if (message.type !== "codesesh.worker-log-drain") return;
      queueMicrotask(() => {
        this.emit("message", {
          type: "codesesh.worker-log-drained",
          requestId: message.requestId,
        });
      });
    });
    terminate = vi.fn(async () => {
      this.emit("exit", 0);
      return 0;
    });
    constructor(
      readonly url: URL,
      readonly options: unknown,
    ) {
      super();
      mocks.workers.push(this);
    }
  },
}));
import { SessionDetailBusyError, ThreadSessionDetailLoader } from "./session-detail-loader.js";

const snapshot = {
  agents: [],
  sessions: [SAMPLE_SESSION_HEAD],
  byAgent: { claudecode: [SAMPLE_SESSION_HEAD] },
} as unknown as LiveSnapshot;
const reference = SAMPLE_SESSION_HEAD.reference;
let loader: ThreadSessionDetailLoader;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.workers.length = 0;
  mocks.cached.mockReturnValue(null);
  loader = new ThreadSessionDetailLoader();
});
afterEach(async () => {
  await loader.shutdown();
  vi.useRealTimers();
});

it("serves a cached result without creating a worker", async () => {
  mocks.cached.mockReturnValue({ status: "not-ready" });
  await expect(loader.load(snapshot, reference)).resolves.toEqual({ status: "not-ready" });
  expect(mocks.workers).toHaveLength(0);
});

it("returns serialized worker results and retires the worker", async () => {
  const pending = loader.load(snapshot, reference);
  mocks.workers[0].emit("message", { type: "result", result: { status: "not-ready" } });
  await expect(pending).resolves.toEqual({ status: "not-ready" });
  expect(mocks.workers[0].postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "codesesh.worker-log-drain" }),
  );
  expect(mocks.workers[0].terminate).toHaveBeenCalledOnce();
});

it.each(["error", "exit", "reported-error"])(
  "rejects a worker %s without retaining capacity",
  async (failure) => {
    const pending = loader.load(snapshot, reference);
    const rejection = expect(pending).rejects.toThrow();
    if (failure === "error") mocks.workers[0].emit("error", new Error("failed"));
    else if (failure === "exit") mocks.workers[0].emit("exit", 1);
    else mocks.workers[0].emit("message", { type: "error", error: "source failed" });
    await rejection;
    expect(mocks.workers[0].terminate).toHaveBeenCalledOnce();
  },
);

it("bounds concurrent parsing and cancels outstanding work on shutdown", async () => {
  const first = expect(loader.load(snapshot, reference)).rejects.toThrow();
  const second = expect(loader.load(snapshot, reference)).rejects.toThrow();
  await expect(loader.load(snapshot, reference)).rejects.toBeInstanceOf(SessionDetailBusyError);
  await loader.shutdown();
  await Promise.all([first, second]);
  await expect(loader.load(snapshot, reference)).rejects.toThrow();
});

it("waits for every worker retirement when one termination fails", async () => {
  const first = expect(loader.load(snapshot, reference)).rejects.toThrow();
  const second = expect(loader.load(snapshot, reference)).rejects.toThrow();
  mocks.workers[0].terminate.mockRejectedValueOnce(new Error("termination failed"));
  let finishSecond = () => {};
  mocks.workers[1].terminate.mockImplementationOnce(
    () =>
      new Promise<number>((resolve) => {
        finishSecond = () => {
          mocks.workers[1].emit("exit", 0);
          resolve(0);
        };
      }),
  );
  let shutdownCompleted = false;

  const shutdown = loader.shutdown().then(() => {
    shutdownCompleted = true;
  });
  await vi.waitFor(() => expect(mocks.workers[1].terminate).toHaveBeenCalledOnce());
  expect(shutdownCompleted).toBe(false);

  finishSecond();
  await shutdown;
  await Promise.all([first, second]);
});

it("cancels a worker when the client aborts", async () => {
  const controller = new AbortController();
  const pending = expect(loader.load(snapshot, reference, {}, controller.signal)).rejects.toThrow();
  controller.abort();
  await pending;
  expect(mocks.workers[0].terminate).toHaveBeenCalledOnce();
});

it("terminates a worker that never returns", async () => {
  vi.useFakeTimers();
  const pending = expect(loader.load(snapshot, reference)).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(60_000);
  await pending;
});

it("keeps the event loop responsive during real worker computation", async () => {
  vi.doUnmock("node:worker_threads");
  vi.resetModules();
  const { ThreadSessionDetailLoader: RealLoader } = await import("./session-detail-loader.js");
  const workerUrl = new URL(
    "data:text/javascript," +
      encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    const start = performance.now();
    while (performance.now() - start < 150) {}
    parentPort.postMessage({ type: "result", result: { status: "not-ready" } });
  `),
  );
  const realLoader = new RealLoader(workerUrl);
  let settled = false;
  try {
    const pending = Promise.resolve(realLoader.load(snapshot, reference)).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    await expect(pending).resolves.toEqual({ status: "not-ready" });
  } finally {
    await realLoader.shutdown();
  }
});
