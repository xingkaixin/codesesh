import { availableParallelism } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BaseAgent, SessionCacheMeta } from "../../agents/index.js";
import type { IdentifiedSessionHead } from "../../types/index.js";
import { setCoreDiagnostics } from "../../utils/index.js";

const workers = vi.hoisted(() => {
  class FakeWorker {
    private readonly sessionIds: string[];

    constructor(_url: URL | string, options: { workerData: { sessionIds: string[] } }) {
      this.sessionIds = options.workerData.sessionIds;
    }

    on(event: string, handler: (message: unknown) => void): this {
      if (event === "message") {
        queueMicrotask(() => {
          handler({
            type: "codesesh.worker-log",
            ts: "2026-08-12T00:00:00.000Z",
            level: "info",
            event: "smart_tags.worker",
            pid: 42,
            threadId: 3,
            data: { sessions: this.sessionIds.length },
          });
          handler(this.sessionIds.map((id) => ({ id, tags: ["bugfix"], sourceUpdatedAt: 1000 })));
        });
      }
      return this;
    }

    once(): this {
      return this;
    }

    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
  }

  return { FakeWorker };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: vi.fn(() => 3),
}));
vi.mock("node:worker_threads", () => ({ Worker: workers.FakeWorker }));

import { finalizeAgentScan } from "../scanner.js";

function makeSession(index: number): IdentifiedSessionHead {
  return {
    reference: { agentName: "test", sessionId: `session-${index}` },
    id: `session-${index}`,
    slug: `test/session-${index}`,
    title: `Session ${index}`,
    directory: "/workspace",
    project_identity: { kind: "path", key: "/workspace", displayName: "workspace" },
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

afterEach(() => {
  setCoreDiagnostics(null);
});

describe("smart tag worker logging", () => {
  it("relays log messages without mistaking them for worker results", async () => {
    expect(availableParallelism()).toBe(3);
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    setCoreDiagnostics({
      info: (event, detail) => events.push({ event, detail }),
      warn: vi.fn(),
    });
    const sessions = Array.from({ length: 50 }, (_, index) => makeSession(index));
    const meta = new Map<string, SessionCacheMeta>();
    const agent = {
      name: "test",
      getSessionMetaMap: () => meta,
      getSessionData: vi.fn(),
    } as unknown as BaseAgent;

    const result = await finalizeAgentScan(agent, sessions, {
      finalization: { kind: "unchanged", cached: { sessions, meta: {}, timestamp: 1 } },
      options: {
        smartTagWorkerUrl: new URL("file:///smart-tag-worker.js"),
        writeCache: false,
      },
      timing: { total: 0 },
      agentStart: performance.now(),
      completeness: "complete",
    });

    expect(result.heads).toHaveLength(50);
    expect(result.heads.every((session) => session.smart_tags?.[0] === "bugfix")).toBe(true);
    expect(agent.getSessionData).not.toHaveBeenCalled();
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      event: "smart_tags.worker",
      detail: expect.objectContaining({
        sessions: 25,
        worker_pid: 42,
        worker_thread_id: 3,
        worker_level: "info",
      }),
    });
  });
});
