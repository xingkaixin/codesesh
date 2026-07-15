import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerData: {} as Record<string, unknown>,
  postMessage: vi.fn(),
  createRegisteredAgents: vi.fn(),
  classifySessionTags: vi.fn(() => ["bugfix"]),
  getSmartTagSourceTimestamp: vi.fn(() => 42),
}));

vi.mock("node:worker_threads", () => ({
  parentPort: { postMessage: mocks.postMessage },
  get workerData() {
    return mocks.workerData;
  },
}));

vi.mock("@codesesh/core", () => ({
  createRegisteredAgents: mocks.createRegisteredAgents,
  classifySessionTags: mocks.classifySessionTags,
  getSmartTagSourceTimestamp: mocks.getSmartTagSourceTimestamp,
}));

async function runWorker() {
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
  it("classifies sessions and isolates per-session failures", async () => {
    const sessionData = { messages: [] };
    const agent = {
      name: "codex",
      setSessionMetaMap: vi.fn(),
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

    expect(agent.setSessionMetaMap).toHaveBeenCalledWith(
      new Map([["ready", { sourcePath: "/ready" }]]),
    );
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
