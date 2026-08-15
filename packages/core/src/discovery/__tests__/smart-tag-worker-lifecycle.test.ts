import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseAgent, SessionCacheMeta } from "../../agents/index.js";
import type { SessionDetail, SessionHead } from "../../types/index.js";

type WorkerBehavior = "clean-exit-without-message" | "empty-results" | "results";

const workers = vi.hoisted(() => {
  const state = {
    behavior: "results" as WorkerBehavior,
    created: 0,
    terminated: 0,
  };

  class FakeWorker {
    private readonly sessionIds: string[];
    private readonly handlers = new Map<string, (payload: unknown) => void>();

    constructor(_url: URL | string, options: { workerData: { sessionIds: string[] } }) {
      this.sessionIds = options.workerData.sessionIds;
      state.created += 1;
      queueMicrotask(() => this.run());
    }

    private run(): void {
      if (state.behavior === "clean-exit-without-message") {
        this.handlers.get("exit")?.(0);
        return;
      }
      const results =
        state.behavior === "empty-results"
          ? []
          : this.sessionIds.map((id) => ({ id, tags: ["bugfix"], sourceUpdatedAt: 1000 }));
      this.handlers.get("message")?.(results);
      this.handlers.get("exit")?.(0);
    }

    on(event: string, handler: (payload: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    once(event: string, handler: (payload: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    terminate(): Promise<number> {
      state.terminated += 1;
      return Promise.resolve(0);
    }
  }

  return { FakeWorker, state };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: vi.fn(() => 3),
}));
vi.mock("node:worker_threads", () => ({ Worker: workers.FakeWorker }));

import { finalizeAgentScan } from "../scanner.js";

function makeSession(index: number): SessionHead {
  return {
    id: `session-${index}`,
    slug: `test/session-${index}`,
    title: `Session ${index}`,
    directory: "/workspace",
    time_created: 1000,
    time_updated: 1000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

function makeAgent(): BaseAgent {
  const meta = new Map<string, SessionCacheMeta>();
  return {
    name: "test",
    getSessionMetaMap: () => meta,
    getSessionData: vi.fn(
      (): SessionDetail => ({ ...makeSession(0), messages: [] }) as unknown as SessionDetail,
    ),
  } as unknown as BaseAgent;
}

async function runScan(agent: BaseAgent, sessions: SessionHead[]) {
  return finalizeAgentScan(agent, sessions, {
    finalization: { kind: "unchanged", cached: { sessions, meta: {}, timestamp: 1 } },
    options: {
      smartTagWorkerUrl: new URL("file:///smart-tag-worker.js"),
      writeCache: false,
    },
    timing: { total: 0 },
    agentStart: performance.now(),
    completeness: "complete",
  });
}

afterEach(() => {
  workers.state.behavior = "results";
  workers.state.created = 0;
  workers.state.terminated = 0;
});

describe("smart tag worker lifecycle", () => {
  it("terminates workers after a successful classification", async () => {
    const sessions = Array.from({ length: 50 }, (_, index) => makeSession(index));

    const result = await runScan(makeAgent(), sessions);

    expect(result.heads.every((session) => session.smart_tags?.[0] === "bugfix")).toBe(true);
    expect(workers.state.created).toBeGreaterThan(0);
    expect(workers.state.terminated).toBe(workers.state.created);
  });

  it("falls back to sync tagging when a worker exits cleanly without responding", async () => {
    workers.state.behavior = "clean-exit-without-message";
    const agent = makeAgent();
    const sessions = Array.from({ length: 50 }, (_, index) => makeSession(index));

    const result = await runScan(agent, sessions);

    expect(result.heads).toHaveLength(50);
    expect(agent.getSessionData).toHaveBeenCalled();
    expect(workers.state.terminated).toBe(workers.state.created);
  });

  it("treats an empty worker answer to a non-empty request as a failure", async () => {
    workers.state.behavior = "empty-results";
    const agent = makeAgent();
    const sessions = Array.from({ length: 50 }, (_, index) => makeSession(index));

    const result = await runScan(agent, sessions);

    expect(result.heads).toHaveLength(50);
    expect(agent.getSessionData).toHaveBeenCalled();
  });
});
