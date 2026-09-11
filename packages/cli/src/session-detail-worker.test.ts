import { beforeEach, expect, it, vi } from "vitest";
import { SAMPLE_SESSION_HEAD } from "@codesesh/core/test-fixtures";
const mocks = vi.hoisted(() => ({
  materialize: vi.fn(),
  post: vi.fn(),
  restore: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Keep worker import tests from installing process-wide diagnostic forwarding.
vi.mock("./diagnostics-bridge.js", () => ({}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Drive this worker entry point with controlled messages and observe its replies in-process.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: { postMessage: mocks.post, on: mocks.on },
  workerData: {
    reference: { agentName: "codex", sessionId: "s1" },
    meta: {},
    pricingGenerationId: 0,
  },
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Register only the fixture agents so orchestration cannot discover host agent data.
vi.mock("@codesesh/core/runtime/agents", () => ({
  createRegisteredAgents: () => [{ name: "codex", restoreSessionCacheMeta: mocks.restore }],
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control pricing generation publication and synchronization independently of network refresh.
vi.mock("@codesesh/core/runtime/pricing", () => ({ synchronizePricingGeneration: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control cache publication, revisions and failures at the scan orchestration boundary.
vi.mock("@codesesh/core/runtime/discovery", () => ({
  materializeSessionDetailResponse: mocks.materialize,
  closeCacheStorage: mocks.close,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

it("serializes source messages inside the worker", async () => {
  mocks.materialize.mockReturnValue({
    status: "found",
    data: { ...SAMPLE_SESSION_HEAD, messages: [{ id: "m1", parts: [] }] },
  });
  await import("./session-detail-worker.js");
  expect(mocks.post).toHaveBeenCalledWith({
    type: "result",
    result: expect.objectContaining({
      status: "found-json",
      messages: ['{"id":"m1","parts":[]}'],
      messageCount: 1,
      sentMessageCount: 1,
    }),
  });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.post.mock.invocationCallOrder[0]!,
  );
});

it("materializes cached message iterators before crossing threads", async () => {
  mocks.materialize.mockReturnValue({
    status: "found-json",
    data: SAMPLE_SESSION_HEAD,
    messages: new Set(['{"id":"m1"}']),
    messageCount: 1,
    sentMessageCount: 1,
  });
  await import("./session-detail-worker.js");
  expect(mocks.post).toHaveBeenCalledWith({
    type: "result",
    result: expect.objectContaining({ messages: ['{"id":"m1"}'] }),
  });
});

it("forwards missing results", async () => {
  mocks.materialize.mockReturnValue({ status: "not-ready" });
  await import("./session-detail-worker.js");
  expect(mocks.post).toHaveBeenCalledWith({ type: "result", result: { status: "not-ready" } });
});

it("reports parsing errors and closes storage", async () => {
  mocks.materialize.mockImplementation(() => {
    throw new Error("parse failed");
  });
  await import("./session-detail-worker.js");
  expect(mocks.post).toHaveBeenCalledWith({ type: "error", error: "parse failed" });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.post.mock.invocationCallOrder[0]!,
  );
});
