import { describe, it, expect, vi } from "vitest";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/core/contract";
import { createApiRoutes } from "../routes.js";
import type { ScanResult } from "@codesesh/core";
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
        } as unknown as ScanResult;
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
});
