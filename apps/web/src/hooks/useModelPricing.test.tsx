import type {
  PricingOverridesResponse,
  ScanStatusEvent,
  UnmatchedModelsResponse,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/contract/test-fixtures";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../lib/query-client";
import { queryKeys } from "../lib/query-keys";
import { ScanStatusProvider, useScanStatusPublisher } from "./useScanStatus";
import { useModelPricing } from "./useModelPricing";

const initialUnmatched: UnmatchedModelsResponse = {
  unmatchedModels: [
    {
      modelKey: "ollama/qwen3",
      displayModel: "ollama/qwen3",
      agents: ["opencode"],
      sessionCount: 2,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1500,
    },
  ],
};

const emptyUnmatched: UnmatchedModelsResponse = { unmatchedModels: [] };

const noOverrides: PricingOverridesResponse = { overrides: [] };

const overridesAfterSave: PricingOverridesResponse = {
  overrides: [
    {
      modelKey: "ollama/qwen3",
      displayModel: "ollama/qwen3",
      kind: "manual",
      targetModel: null,
      effectiveRates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      targetMissing: false,
      officialPriceAvailable: false,
      officialRates: null,
      updatedAt: 10,
    },
  ],
};

const overridesAfterAcknowledge: PricingOverridesResponse = {
  overrides: [
    {
      modelKey: "custom/model",
      displayModel: "custom/model",
      kind: "manual",
      targetModel: null,
      effectiveRates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      targetMissing: false,
      officialPriceAvailable: false,
      officialRates: { input: 1.5, output: 3, cacheRead: 0, cacheWrite: 0 },
      updatedAt: 20,
    },
  ],
};

function createTestHarness(initialScanStatus: ScanStatusEvent | null = null) {
  const client = createQueryClient();
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <ScanStatusProvider initialStatus={initialScanStatus}>{children}</ScanStatusProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

function unmatchedCount(state: ReturnType<typeof useModelPricing>): number | null {
  return state.unmatched.status === "ready" ? state.unmatched.models.length : null;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useModelPricing", () => {
  it("stays disabled until app config is ready", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Response.json(noOverrides);
    });

    const { wrapper } = createTestHarness(SAMPLE_SCAN_STATUS_EVENT);
    const { result } = renderHook(() => useModelPricing({ days: 30 }, false), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.overrides).toBeUndefined();
    expect(result.current.unmatched.status).toBe("pending");
    expect(requestedUrls).toHaveLength(0);
  });

  it("shows overrides while unmatched models are still counting", async () => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname === "/api/pricing/overrides") {
        return Promise.resolve(Response.json(overridesAfterSave));
      }
      return new Promise<Response>(() => {});
    });

    const { wrapper } = createTestHarness(SAMPLE_SCAN_STATUS_EVENT);
    const { result } = renderHook(() => useModelPricing({ days: 30 }, true), { wrapper });

    await waitFor(() => {
      expect(result.current.overrides).toEqual(overridesAfterSave.overrides);
    });
    expect(result.current.unmatched.status).toBe("pending");
  });

  it("requests unmatched models for the selected window", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      return Response.json(url.startsWith("/api/pricing/unmatched") ? emptyUnmatched : noOverrides);
    });

    const { wrapper } = createTestHarness(SAMPLE_SCAN_STATUS_EVENT);
    const initialWindow: { days?: number; from?: number; to?: number } = { from: 0, days: 0 };
    const { rerender } = renderHook(
      ({ window }: { window: { days?: number; from?: number; to?: number } }) =>
        useModelPricing(window, true),
      {
        wrapper,
        initialProps: { window: initialWindow },
      },
    );

    await waitFor(() => {
      expect(requestedUrls).toContain("/api/pricing/unmatched?days=0");
    });

    rerender({ window: { from: 1_700_000_000_000, to: 1_700_086_400_000, days: 1 } });

    await waitFor(() => {
      expect(requestedUrls).toContain(
        "/api/pricing/unmatched?from=2023-11-14T22%3A13%3A20.000Z&to=2023-11-15T22%3A13%3A20.000Z",
      );
    });
    expect(requestedUrls.filter((url) => url === "/api/pricing/overrides")).toHaveLength(1);
  });

  it("recounts unmatched models after save/delete, without invalidating dashboard on acknowledge", async () => {
    let unmatchedResponse = initialUnmatched;
    const updatedCatalogView = {
      overrides: overridesAfterSave.overrides.map((rule) => ({
        ...rule,
        officialPriceAvailable: true,
        officialRates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      })),
    };
    let overrides = noOverrides;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname === "/api/pricing/unmatched") return Response.json(unmatchedResponse);
      if (pathname === "/api/pricing/overrides" && init?.method === "PUT") {
        unmatchedResponse = emptyUnmatched;
        // A catalog refresh can finish while the save response waits for historical repricing.
        overrides = updatedCatalogView;
        return Response.json(overridesAfterSave);
      }
      if (pathname === "/api/pricing/overrides") return Response.json(overrides);
      if (pathname === "/api/pricing/overrides/acknowledge") {
        overrides = overridesAfterAcknowledge;
        return Response.json(overrides);
      }
      if (pathname === "/api/pricing/overrides/delete") {
        unmatchedResponse = initialUnmatched;
        overrides = noOverrides;
        return Response.json(overrides);
      }
      return Response.json({});
    });

    const { client, wrapper } = createTestHarness(SAMPLE_SCAN_STATUS_EVENT);
    const dashboardKey = queryKeys.dashboard({ days: 30 }, { timeZone: "UTC" });
    const projectionKey = queryKeys.sessionProjection({ days: 30 });
    client.setQueryData(dashboardKey, { staleCheck: true });
    client.setQueryData(projectionKey, { sessions: [], complete: true });

    const { result } = renderHook(() => useModelPricing({ days: 30 }, true), { wrapper });

    await waitFor(() => {
      expect(unmatchedCount(result.current)).toBe(1);
    });

    const request: UpsertPricingOverrideRequest = {
      model: "ollama/qwen3",
      kind: "manual",
      rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
    await act(async () => {
      await result.current.saveOverride(request);
    });

    await waitFor(() => {
      expect(result.current.overrides).toEqual(updatedCatalogView.overrides);
      expect(unmatchedCount(result.current)).toBe(0);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(true);

    client.setQueryData(dashboardKey, { staleCheck: "reset" });
    client.setQueryData(projectionKey, { sessions: [], complete: true });

    await act(async () => {
      await result.current.acknowledgeOfficial("custom/model");
    });

    await waitFor(() => {
      expect(result.current.overrides).toEqual(overridesAfterAcknowledge.overrides);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(false);

    await act(async () => {
      await result.current.deleteOverride("ollama/qwen3");
    });

    await waitFor(() => {
      expect(result.current.overrides).toEqual([]);
      expect(unmatchedCount(result.current)).toBe(1);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(true);
  });

  it.each(["scan", "pricing"])("recounts unmatched models when %s finishes", async (task) => {
    let unmatchedFetches = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname === "/api/pricing/overrides") return Response.json(noOverrides);
      unmatchedFetches += 1;
      return Response.json(unmatchedFetches === 1 ? initialUnmatched : emptyUnmatched);
    });

    const activeScan: ScanStatusEvent = {
      ...SAMPLE_SCAN_STATUS_EVENT,
      active: task === "scan",
      pricingHistory: { generation: 1, phase: task === "pricing" ? "repricing" : "current" },
      updatedAt: 100,
    };
    const { wrapper } = createTestHarness(activeScan);

    const { result } = renderHook(
      () => ({
        pricing: useModelPricing({ days: 30 }, true),
        publishScanStatus: useScanStatusPublisher(),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(unmatchedCount(result.current.pricing)).toBe(1);
    });

    act(() => {
      result.current.publishScanStatus({
        ...activeScan,
        active: false,
        pricingHistory: { generation: 1, phase: "current" },
        updatedAt: 200,
      });
    });

    await waitFor(() => {
      expect(unmatchedCount(result.current.pricing)).toBe(0);
      expect(unmatchedFetches).toBe(2);
    });
  });
});
