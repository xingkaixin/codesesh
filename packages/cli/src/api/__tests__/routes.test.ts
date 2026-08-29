import { beforeEach, describe, it, expect, vi } from "vitest";

const loggerMocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("../../logging.js", () => ({ appLogger: loggerMocks }));
import {
  SAMPLE_SCAN_STATUS_EVENT,
  SAMPLE_SESSIONS_UPDATED_EVENT,
} from "@codesesh/core/test-fixtures";
import type { ScanStatusEvent, SessionsUpdatedEvent } from "@codesesh/core/contract";
import { createApiRoutes, MAX_ACTIVE_SSE_CONNECTIONS } from "../routes.js";
import { MAX_PENDING_CRITICAL_SSE_FRAMES } from "../sse-event-buffer.js";
import type { LiveSnapshot } from "@codesesh/core/runtime/discovery";
import type { ScanResultSource } from "../scan-sources.js";
import type { ScanEventSource } from "../../scan-source.js";

describe("createApiRoutes", () => {
  beforeEach(() => {
    loggerMocks.info.mockClear();
    loggerMocks.warn.mockClear();
  });

  function infoLogs(event: string): Record<string, unknown>[] {
    return loggerMocks.info.mock.calls
      .filter(([loggedEvent]) => loggedEvent === event)
      .map(([, data]) => data as Record<string, unknown>);
  }

  it("logs bounded connection lifecycle data with elapsed time", async () => {
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: () => () => {},
      subscribeScanStatus: () => () => {},
    };
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );

    try {
      const response = await app.request("/events");
      const opened = infoLogs("api.sse.connection.opened");
      expect(opened).toEqual([
        {
          connection_id: expect.any(String),
          active_connections: 1,
          connection_limit: MAX_ACTIVE_SSE_CONNECTIONS,
        },
      ]);

      now.mockReturnValue(1_375);
      await response.body?.cancel();

      expect(infoLogs("api.sse.connection.closed")).toEqual([
        {
          connection_id: opened[0]!.connection_id,
          close_reason: "client_cancelled",
          duration_ms: 375,
          active_connections: 0,
        },
      ]);
    } finally {
      now.mockRestore();
    }
  });

  it("bounds active SSE clients and restores capacity after cancellation", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn(() => unsubscribeSessions),
      subscribeScanStatus: vi.fn(() => unsubscribeScanStatus),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );

    const responses = await Promise.all(
      Array.from({ length: MAX_ACTIVE_SSE_CONNECTIONS }, () => app.request("/events")),
    );
    const rejected = await app.request("/events");

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get("Retry-After")).toBe("1");
    expect(await rejected.json()).toEqual({ error: "Too many active event streams" });
    expect(eventSource.subscribe).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS);
    expect(eventSource.subscribeScanStatus).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS);
    expect(loggerMocks.warn).toHaveBeenCalledWith("api.sse.connection_limit_reached", {
      active_connections: MAX_ACTIVE_SSE_CONNECTIONS,
      connection_limit: MAX_ACTIVE_SSE_CONNECTIONS,
    });
    expect(infoLogs("api.sse.connection.opened").at(-1)).toEqual({
      connection_id: expect.any(String),
      active_connections: MAX_ACTIVE_SSE_CONNECTIONS,
      connection_limit: MAX_ACTIVE_SSE_CONNECTIONS,
    });

    await responses[0]!.body?.cancel();
    const replacement = await app.request("/events");

    expect(replacement.status).toBe(200);
    expect(eventSource.subscribe).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);
    expect(eventSource.subscribeScanStatus).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);

    await Promise.all([
      ...responses.slice(1).map((response) => response.body?.cancel()),
      replacement.body?.cancel(),
    ]);
    expect(unsubscribeSessions).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);
    expect(unsubscribeScanStatus).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);
  });

  it("releases every SSE connection when the server shuts down", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn(() => unsubscribeSessions),
      subscribeScanStatus: vi.fn(() => unsubscribeScanStatus),
    };
    const shutdownController = new AbortController();
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
      { shutdownSignal: shutdownController.signal },
    );
    const responses = await Promise.all(
      Array.from({ length: MAX_ACTIVE_SSE_CONNECTIONS }, () => app.request("/events")),
    );

    expect((await app.request("/events")).status).toBe(429);
    shutdownController.abort();

    expect(unsubscribeSessions).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS);
    expect(unsubscribeScanStatus).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS);
    expect(infoLogs("api.sse.connection.closed")).toHaveLength(MAX_ACTIVE_SSE_CONNECTIONS);
    expect(
      infoLogs("api.sse.connection.closed").every(
        (data) => data.close_reason === "server_shutdown",
      ),
    ).toBe(true);
    expect(infoLogs("api.sse.connection.closed").at(-1)).toEqual({
      connection_id: expect.any(String),
      close_reason: "server_shutdown",
      duration_ms: expect.any(Number),
      active_connections: 0,
    });
    const afterShutdown = await app.request("/events");
    expect(afterShutdown.status).toBe(200);
    const reader = afterShutdown.body!.getReader();
    let done = false;
    while (!done) ({ done } = await reader.read());
    expect(done).toBe(true);

    await Promise.all(responses.map((response) => response.body?.cancel()));
  });

  it("releases SSE capacity when subscription setup fails", async () => {
    const unsubscribeSessions = vi.fn();
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn(() => unsubscribeSessions),
      subscribeScanStatus: vi.fn(() => {
        throw new Error("status subscription failed");
      }),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (let index = 0; index <= MAX_ACTIVE_SSE_CONNECTIONS; index += 1) {
        expect((await app.request("/events")).status).toBe(500);
      }
    } finally {
      consoleError.mockRestore();
    }

    expect(eventSource.subscribe).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);
    expect(unsubscribeSessions).toHaveBeenCalledTimes(MAX_ACTIVE_SSE_CONNECTIONS + 1);
    expect(infoLogs("api.sse.connection.closed")).toHaveLength(MAX_ACTIVE_SSE_CONNECTIONS + 1);
    expect(
      infoLogs("api.sse.connection.closed").every(
        (data) => data.close_reason === "setup_failed" && data.active_connections === 0,
      ),
    ).toBe(true);
  });

  it("returns a Hono instance with route handlers", () => {
    const scanSource: ScanResultSource = {
      getSnapshot() {
        return {
          sessions: [],
          byAgent: {},
          agents: [],
        } as unknown as LiveSnapshot;
      },
    };
    const app = createApiRoutes(scanSource);
    expect(app).toBeDefined();
    expect(app.fetch).toBeDefined();
  });

  it("cleans up SSE subscriptions once when cancellation and abort overlap", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    let emitSession: ((event: { type: string }) => void) | undefined;
    let emitScanStatus: ((event: { type: string }) => void) | undefined;
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn((listener: (event: { type: string }) => void) => {
        emitSession = listener;
        return unsubscribeSessions;
      }),
      subscribeScanStatus: vi.fn((listener: (event: { type: string }) => void) => {
        emitScanStatus = listener;
        return unsubscribeScanStatus;
      }),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );
    const requestController = new AbortController();

    const response = await app.request(
      new Request("http://localhost/events", { signal: requestController.signal }),
    );
    await response.body?.cancel();
    requestController.abort();

    expect(unsubscribeSessions).toHaveBeenCalledOnce();
    expect(unsubscribeScanStatus).toHaveBeenCalledOnce();
    expect(infoLogs("api.sse.connection.closed")).toEqual([
      expect.objectContaining({ close_reason: "client_cancelled", active_connections: 0 }),
    ]);
    expect(() => emitSession?.({ type: "sessions-updated" })).not.toThrow();
    expect(() => emitScanStatus?.({ type: "scan-status" })).not.toThrow();
  });

  it("cleans up SSE subscriptions once when abort happens first", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn(() => unsubscribeSessions),
      subscribeScanStatus: vi.fn(() => unsubscribeScanStatus),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );
    const requestController = new AbortController();
    const response = await app.request(
      new Request("http://localhost/events", { signal: requestController.signal }),
    );

    requestController.abort();
    await response.body?.cancel();

    expect(unsubscribeSessions).toHaveBeenCalledOnce();
    expect(unsubscribeScanStatus).toHaveBeenCalledOnce();
    expect(infoLogs("api.sse.connection.closed")).toEqual([
      expect.objectContaining({ close_reason: "client_disconnected", active_connections: 0 }),
    ]);
  });

  it("keeps only the latest numeric status for a slow SSE client", async () => {
    let emitScanStatus: ((event: ScanStatusEvent) => void) | undefined;
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn(() => () => {}),
      subscribeScanStatus: vi.fn((listener) => {
        emitScanStatus = listener;
        return () => {};
      }),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );
    const requestController = new AbortController();
    const response = await app.request(
      new Request("http://localhost/events", { signal: requestController.signal }),
    );

    for (let processed = 1; processed <= 10_000; processed += 1) {
      emitScanStatus?.({
        ...SAMPLE_SCAN_STATUS_EVENT,
        updatedAt: SAMPLE_SCAN_STATUS_EVENT.updatedAt + processed,
        agentStatuses: {
          claudecode: { ...SAMPLE_SCAN_STATUS_EVENT.agentStatuses.claudecode, processed },
        },
      });
    }
    emitScanStatus?.({
      ...SAMPLE_SCAN_STATUS_EVENT,
      active: true,
      phase: "scanning",
      scanningAgents: ["claudecode"],
      completedAgents: [],
      agentStatuses: {
        claudecode: {
          ...SAMPLE_SCAN_STATUS_EVENT.agentStatuses.claudecode,
          status: "finalizing",
          processed: 10_000,
        },
      },
      updatedAt: SAMPLE_SCAN_STATUS_EVENT.updatedAt + 10_001,
    });
    emitScanStatus?.({
      ...SAMPLE_SCAN_STATUS_EVENT,
      agentStatuses: {
        claudecode: {
          ...SAMPLE_SCAN_STATUS_EVENT.agentStatuses.claudecode,
          status: "failed",
          error: "source failed",
        },
      },
      updatedAt: SAMPLE_SCAN_STATUS_EVENT.updatedAt + 10_002,
    });

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (let index = 0; index < 5; index += 1) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    requestController.abort();

    expect(text.match(/event: scan-status/g)).toHaveLength(4);
    expect(text).toContain('"processed":10000');
    expect(text).toContain('"error":"source failed"');
  });

  it("disconnects a slow SSE client when critical events reach the bound", async () => {
    const unsubscribeSessions = vi.fn();
    const unsubscribeScanStatus = vi.fn();
    let emitSession: ((event: SessionsUpdatedEvent) => void) | undefined;
    const eventSource: ScanEventSource = {
      getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
      subscribe: vi.fn((listener) => {
        emitSession = listener;
        return unsubscribeSessions;
      }),
      subscribeScanStatus: vi.fn(() => unsubscribeScanStatus),
    };
    const app = createApiRoutes(
      { getSnapshot: () => ({ sessions: [], byAgent: {}, agents: [] }) },
      eventSource,
    );
    const response = await app.request("/events");

    for (let index = 0; index <= MAX_PENDING_CRITICAL_SSE_FRAMES; index += 1) {
      emitSession?.({ ...SAMPLE_SESSIONS_UPDATED_EVENT, timestamp: index });
    }

    expect(unsubscribeSessions).toHaveBeenCalledOnce();
    expect(unsubscribeScanStatus).toHaveBeenCalledOnce();
    expect(infoLogs("api.sse.connection.closed")).toEqual([
      expect.objectContaining({ close_reason: "client_too_slow", active_connections: 0 }),
    ]);
    await expect(response.body!.getReader().read()).rejects.toThrow("SSE client fell behind");
  });
});
