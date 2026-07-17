import { describe, it, expect } from "vitest";
import { SAMPLE_SCAN_STATUS_EVENT, SAMPLE_SESSION_HEAD } from "@codesesh/core/contract";
import type { ScanResult } from "@codesesh/core";
import { createApiRoutes } from "../routes.js";
import type { ScanResultSource } from "../handlers.js";
import type { ScanEventSource } from "../../scan-source.js";

function makeScanSource(): ScanResultSource {
  return {
    getSnapshot: () =>
      ({
        sessions: [SAMPLE_SESSION_HEAD],
        byAgent: { claudecode: [SAMPLE_SESSION_HEAD] },
        agents: [],
      }) as ScanResult,
  };
}

function makeEventSource(): ScanEventSource {
  return {
    getScanStatus: () => SAMPLE_SCAN_STATUS_EVENT,
    subscribe: () => () => {},
    subscribeScanStatus: () => () => {},
  };
}

describe("cli routes stay wire-compatible with @codesesh/core/contract", () => {
  it("GET /status returns the ScanStatusEvent fixture as-is", async () => {
    const app = createApiRoutes(makeScanSource(), makeEventSource());
    const res = await app.request("/status");
    expect(await res.json()).toEqual(SAMPLE_SCAN_STATUS_EVENT);
  });

  it("SSE /events opens with the ScanStatusEvent fixture from the store", async () => {
    const app = createApiRoutes(makeScanSource(), makeEventSource());
    const controller = new AbortController();
    const res = await app.request("/events", { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // "connected" then "scan-status" are each written as an "event:" line + a "data:" line.
    for (let i = 0; i < 4; i++) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    controller.abort();

    expect(text).toContain(
      `event: scan-status\ndata: ${JSON.stringify(SAMPLE_SCAN_STATUS_EVENT)}\n\n`,
    );
  });

  it("GET /search falls back to recent sessions shaped like the contract SearchResult", async () => {
    const app = createApiRoutes(makeScanSource());
    const res = await app.request("/search");
    const body = (await res.json()) as { results: unknown[] };

    expect(body.results).toEqual([
      {
        agentName: "claudecode",
        session: SAMPLE_SESSION_HEAD,
        snippet: `Recent session · ${SAMPLE_SESSION_HEAD.directory}`,
        matchType: "recent",
      },
    ]);
  });
});
