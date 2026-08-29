import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort, type Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "./logging.js";
import { acknowledgeWorkerLogDrain, terminateWorkerAfterLogDrain } from "./worker-log-drain.js";

function workerFromPort(port: MessagePort, terminate: () => Promise<number>): Worker {
  return {
    on: port.on.bind(port),
    once: port.once.bind(port),
    off: port.off.bind(port),
    postMessage: port.postMessage.bind(port),
    terminate,
  } as unknown as Worker;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker log drain", () => {
  it("delivers queued messages before one shared termination", async () => {
    const { port1: workerPort, port2: parentPort } = new MessageChannel();
    const order: string[] = [];
    workerPort.on("message", (message: unknown) => {
      acknowledgeWorkerLogDrain(workerPort, message);
    });
    parentPort.on("message", (message: { type?: string }) => {
      if (message.type === "queued-log") order.push("log");
    });
    const terminate = vi.fn(async () => {
      order.push("terminate");
      workerPort.close();
      parentPort.close();
      return 0;
    });
    const worker = workerFromPort(parentPort, terminate);

    workerPort.postMessage({ type: "queued-log" });
    await Promise.all([terminateWorkerAfterLogDrain(worker), terminateWorkerAfterLogDrain(worker)]);

    expect(order).toEqual(["log", "terminate"]);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it("terminates after a short timeout when the worker cannot acknowledge", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(appLogger, "warn").mockImplementation(() => undefined);
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
      threadId: number;
    };
    worker.threadId = 42;
    worker.postMessage = vi.fn();
    worker.terminate = vi.fn(async () => 0);

    const termination = terminateWorkerAfterLogDrain(worker as unknown as Worker);
    await vi.advanceTimersByTimeAsync(99);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await termination;

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("worker.log_drain_timeout", {
      timeout_ms: 100,
      worker_thread_id: 42,
    });
    expect(worker.listenerCount("message")).toBe(0);
    expect(worker.listenerCount("error")).toBe(0);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  it("does not terminate a worker that exits while draining", async () => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.postMessage = vi.fn();
    worker.terminate = vi.fn(async () => 0);

    const termination = terminateWorkerAfterLogDrain(worker as unknown as Worker);
    worker.emit("exit", 7);

    await expect(termination).resolves.toBe(7);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("waits for exit after an error instead of terminating immediately", async () => {
    const worker = new EventEmitter() as EventEmitter & {
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    };
    worker.postMessage = vi.fn();
    worker.terminate = vi.fn(async () => 0);
    worker.on("error", () => undefined);

    const termination = terminateWorkerAfterLogDrain(worker as unknown as Worker);
    worker.emit("error", new Error("failed"));
    await Promise.resolve();
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.emit("exit", 1);
    await expect(termination).resolves.toBe(1);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it("acknowledges only after the worker barrier settles", async () => {
    const { port1: workerPort, port2: parentPort } = new MessageChannel();
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    workerPort.on("message", (message: unknown) => {
      acknowledgeWorkerLogDrain(workerPort, message, barrier);
    });
    const acknowledged = vi.fn();
    parentPort.on("message", acknowledged);

    parentPort.postMessage({ type: "codesesh.worker-log-drain", requestId: "queued" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acknowledged).not.toHaveBeenCalled();

    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(acknowledged).toHaveBeenCalledWith({
      type: "codesesh.worker-log-drained",
      requestId: "queued",
    });

    workerPort.close();
    parentPort.close();
  });
});
