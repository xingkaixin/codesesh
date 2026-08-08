import { describe, it, expect, vi } from "vitest";
import {
  SAMPLE_SCAN_STATUS_EVENT,
  SAMPLE_SESSIONS_UPDATED_EVENT,
  type ScanStatusEvent,
  type SessionsUpdatedEvent,
} from "@codesesh/core/contract";
import { createApiRoutes } from "../routes.js";
import { MAX_PENDING_CRITICAL_SSE_FRAMES } from "../sse-event-buffer.js";
import type { LiveSnapshot } from "@codesesh/core";
import type { ScanResultSource } from "../handlers.js";
import type { ScanEventSource } from "../../scan-source.js";

describe("createApiRoutes", () => {
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
    await expect(response.body!.getReader().read()).rejects.toThrow("SSE client fell behind");
  });
});
