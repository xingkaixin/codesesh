import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerData: {} as Record<string, unknown>,
  postMessage: vi.fn(),
  createRegisteredAgents: vi.fn(),
  synchronizePricingGeneration: vi.fn(),
  classifySessionTags: vi.fn(() => ["bugfix"]),
  getSmartTagSourceTimestamp: vi.fn(() => 42),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
  threadId: 17,
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("./logging.js", () => ({
  appLogger: {
    forwardToParent: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("@codesesh/core/runtime/agents", () => ({
  createRegisteredAgents: mocks.createRegisteredAgents,
}));

vi.mock("@codesesh/core/runtime/diagnostics", () => ({
  classifySessionTags: mocks.classifySessionTags,
  getSmartTagSourceTimestamp: mocks.getSmartTagSourceTimestamp,
  setCoreDiagnostics: vi.fn(),
}));

vi.mock("@codesesh/core/runtime/pricing", () => ({
  synchronizePricingGeneration: mocks.synchronizePricingGeneration,
}));

async function runWorker() {
  mocks.workerData = { pricingGenerationId: 17, ...mocks.workerData };
  await import("./smart-tag-worker.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.workerData = {
    agentName: "codex",
    sessionIds: [],
    meta: {},
  };
});

describe("smart tag worker", () => {
  it("synchronizes pricing before creating agents", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);

    await runWorker();

    expect(mocks.synchronizePricingGeneration).toHaveBeenCalledWith(17);
    expect(mocks.synchronizePricingGeneration.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createRegisteredAgents.mock.invocationCallOrder[0]!,
    );
  });

  it("classifies sessions and isolates per-session failures", async () => {
    const sessionData = { messages: [] };
    const agent = {
      name: "codex",
      restoreSessionCacheMeta: vi.fn(),
      getSessionData: vi.fn((id: string) => {
        if (id === "broken") throw new Error("cannot parse");
        if (id === "invalid") throw "invalid session";
        return sessionData;
      }),
    };
    mocks.createRegisteredAgents.mockReturnValue([agent]);
    mocks.workerData = {
      agentName: "codex",
      sessionIds: ["ready", "broken", "invalid"],
      meta: { ready: { sourcePath: "/ready" } },
    };

    await runWorker();

    expect(agent.restoreSessionCacheMeta).toHaveBeenCalledWith({
      ready: { sourcePath: "/ready" },
    });
    expect(mocks.classifySessionTags).toHaveBeenCalledWith(sessionData);
    expect(mocks.getSmartTagSourceTimestamp).toHaveBeenCalledWith(sessionData);
    expect(mocks.postMessage).toHaveBeenCalledWith([
      { id: "ready", tags: ["bugfix"], sourceUpdatedAt: 42 },
      { id: "broken", error: "cannot parse" },
      { id: "invalid", error: "invalid session" },
    ]);
  });

  it("returns no results when the requested agent is unavailable", async () => {
    mocks.createRegisteredAgents.mockReturnValue([]);
    mocks.workerData = {
      agentName: "missing",
      sessionIds: ["s1"],
      meta: {},
    };

    await runWorker();

    expect(mocks.postMessage).toHaveBeenCalledWith([]);
  });
});
