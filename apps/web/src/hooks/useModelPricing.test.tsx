import type {
  PricingMutationResponse,
  PricingOverviewResponse,
  ScanStatusEvent,
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

const initialOverview: PricingOverviewResponse = {
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
  overrides: [],
  attentionCount: 1,
};

const updatedAfterSave: PricingOverviewResponse = {
  unmatchedModels: [],
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
  attentionCount: 0,
};

const updatedAfterAcknowledge: PricingOverviewResponse = {
  unmatchedModels: [],
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
  attentionCount: 0,
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useModelPricing", () => {
  it("stays disabled when hubEnabled disables pricing", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Response.json(initialOverview);
    });

    const { wrapper } = createTestHarness(SAMPLE_SCAN_STATUS_EVENT);
    const { result } = renderHook(() => useModelPricing({ days: 30 }, false), { wrapper });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.overview).toBeUndefined();
    expect(requestedUrls).toHaveLength(0);
  });

  it("includes time window parameters cleanly across days=0 and bounded ranges", async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return Response.json(initialOverview);
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
      expect(requestedUrls).toEqual(["/api/pricing/overview?days=0"]);
    });

    rerender({ window: { from: 1_700_000_000_000, to: 1_700_086_400_000, days: 1 } });

    await waitFor(() => {
      expect(requestedUrls[1]).toBe(
        "/api/pricing/overview?from=2023-11-14T22%3A13%3A20.000Z&to=2023-11-15T22%3A13%3A20.000Z",
      );
    });
  });

  it("updates pricing cache and invalidates derived caches on save/delete, without invalidating dashboard on acknowledge", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      if (parsed.pathname === "/api/pricing/overview") {
        return Response.json(initialOverview);
      }
      if (parsed.pathname === "/api/pricing/overrides" && init?.method === "PUT") {
        const body: PricingMutationResponse = { overview: updatedAfterSave };
        return Response.json(body);
      }
      if (parsed.pathname === "/api/pricing/overrides/acknowledge") {
        return Response.json(updatedAfterAcknowledge);
      }
      if (parsed.pathname === "/api/pricing/overrides/delete") {
        const body: PricingMutationResponse = { overview: initialOverview };
        return Response.json(body);
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
      expect(result.current.overview?.attentionCount).toBe(1);
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
      expect(result.current.overview).toEqual(updatedAfterSave);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(true);

    client.setQueryData(dashboardKey, { staleCheck: "reset" });
    client.setQueryData(projectionKey, { sessions: [], complete: true });

    await act(async () => {
      await result.current.acknowledgeOfficial("custom/model");
    });

    await waitFor(() => {
      expect(result.current.overview).toEqual(updatedAfterAcknowledge);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(false);

    await act(async () => {
      await result.current.deleteOverride("ollama/qwen3");
    });

    await waitFor(() => {
      expect(result.current.overview).toEqual(initialOverview);
    });
    expect(client.getQueryState(dashboardKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(projectionKey)?.isInvalidated).toBe(true);
  });

  it("refreshes pricing overview when local scan finishes", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return Response.json(fetchCount === 1 ? initialOverview : updatedAfterSave);
    });

    const activeScan: ScanStatusEvent = {
      ...SAMPLE_SCAN_STATUS_EVENT,
      active: true,
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
      expect(result.current.pricing.overview?.attentionCount).toBe(1);
    });

    act(() => {
      result.current.publishScanStatus({
        ...activeScan,
        active: false,
        updatedAt: 200,
      });
    });

    await waitFor(() => {
      expect(result.current.pricing.overview?.attentionCount).toBe(0);
      expect(fetchCount).toBe(2);
    });
  });
});
