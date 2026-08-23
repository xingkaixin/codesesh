import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  computeIdentityProjection: vi.fn(),
  handler: undefined as
    | ((message: { type: string; requestId: number; cwd: string }) => void)
    | undefined,
  postMessage: vi.fn(),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: {
    on: (
      _event: string,
      handler: (message: { type: string; requestId: number; cwd: string }) => void,
    ) => {
      mocks.handler = handler;
    },
    postMessage: mocks.postMessage,
  },
  threadId: 17,
}));

vi.mock("@codesesh/core/runtime/projects", () => ({
  computeIdentityProjection: mocks.computeIdentityProjection,
}));

vi.mock("@codesesh/core/runtime/diagnostics", () => ({
  setCoreDiagnostics: vi.fn(),
}));

vi.mock("./logging.js", () => ({
  appLogger: { forwardToParent: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

async function runWorker() {
  await import("./project-identity-worker.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.handler = undefined;
});

describe("project identity worker", () => {
  it("uses the core projection resolver in the worker", async () => {
    mocks.computeIdentityProjection.mockReturnValue({
      identity: { kind: "path", key: "/repo", displayName: "repo" },
      resolverRevision: "project-identity-v2",
      inputSignature: "test",
    });
    await runWorker();

    mocks.handler?.({ type: "resolve", requestId: 7, cwd: "/repo" });

    expect(mocks.computeIdentityProjection).toHaveBeenCalledWith("/repo");
    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: "resolved",
      requestId: 7,
      projection: expect.objectContaining({
        identity: expect.objectContaining({ kind: "path", key: "/repo" }),
      }),
    });
  });

  it("returns worker failures without terminating the resolver pool", async () => {
    mocks.computeIdentityProjection.mockImplementation(() => {
      throw new Error("git timed out");
    });
    await runWorker();

    mocks.handler?.({ type: "resolve", requestId: 8, cwd: "/slow" });

    expect(mocks.postMessage).toHaveBeenCalledWith({
      type: "failed",
      requestId: 8,
      error: "git timed out",
    });
  });
});
