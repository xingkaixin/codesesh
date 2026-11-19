import type {
  AgentInfo,
  OfficialModelListResponse,
  ModelPriceOverrideView,
  UnmatchedModelStat,
  UpsertPricingOverrideRequest,
} from "@codesesh/contract";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/contract/test-fixtures";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScanStatusProvider } from "../../hooks/useScanStatus";
import { useModelPricing } from "../../hooks/useModelPricing";
import { createAgentCatalog } from "../../lib/agents";
import { createQueryClient } from "../../lib/query-client";
import { PricingDrawer, type PricingDrawerTab } from "./PricingDrawer";

const catalog = createAgentCatalog([
  { name: "opencode", displayName: "OpenCode", count: 4 },
] as AgentInfo[]);

const officialModels: OfficialModelListResponse = {
  models: [
    {
      model: "claude-sonnet-4-5",
      rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      hasLongContext: true,
    },
    {
      model: "gpt-5-mini",
      rates: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
      hasLongContext: false,
    },
  ],
  total: 2,
};

interface PricingFixture {
  unmatchedModels: UnmatchedModelStat[];
  overrides: ModelPriceOverrideView[];
}

function createOverview(): PricingFixture {
  return {
    unmatchedModels: [
      {
        modelKey: "proxy/sonnet-4-5",
        displayModel: "proxy/sonnet-4-5",
        agents: ["opencode"],
        sessionCount: 3,
        inputTokens: 12000,
        outputTokens: 3400,
        cacheReadTokens: 8000,
        cacheWriteTokens: 0,
        totalTokens: 23400,
      },
    ],
    overrides: [
      {
        modelKey: "custom/old",
        displayModel: "custom/old",
        kind: "manual",
        targetModel: null,
        effectiveRates: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        targetMissing: false,
        officialPriceAvailable: false,
        officialRates: null,
        updatedAt: 100,
      },
      {
        modelKey: "custom/broken",
        displayModel: "custom/broken",
        kind: "remap",
        targetModel: "removed-official-model",
        effectiveRates: null,
        targetMissing: true,
        officialPriceAvailable: false,
        officialRates: null,
        updatedAt: 200,
      },
      {
        modelKey: "custom/new-official",
        displayModel: "custom/new-official",
        kind: "manual",
        targetModel: null,
        effectiveRates: { input: 2.5, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
        targetMissing: false,
        officialPriceAvailable: true,
        officialRates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        updatedAt: 300,
      },
    ],
  };
}

function readPricing(fixture: PricingFixture, parsed: URL, init?: RequestInit): Response | null {
  if (parsed.pathname === "/api/pricing/unmatched") {
    return Response.json({ unmatchedModels: fixture.unmatchedModels });
  }
  if (parsed.pathname === "/api/pricing/overrides" && (init?.method ?? "GET") === "GET") {
    return Response.json({ overrides: fixture.overrides });
  }
  return null;
}

function DrawerHarness({ initialTab }: { initialTab: PricingDrawerTab }) {
  const [open, setOpen] = useState(true);
  const pricing = useModelPricing({ days: 30 }, true);

  return (
    <PricingDrawer
      open={open}
      onOpenChange={setOpen}
      initialTab={initialTab}
      agentCatalog={catalog}
      pricing={pricing}
      scopeLabel="Last 30d"
      sessionCount={655}
    />
  );
}

function renderDrawer(initialTab: PricingDrawerTab) {
  const client = createQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ScanStatusProvider initialStatus={SAMPLE_SCAN_STATUS_EVENT}>
        <DrawerHarness initialTab={initialTab} />
      </ScanStatusProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PricingDrawer", () => {
  it("never reports zero unmatched models before counting finishes", async () => {
    const fixture = createOverview();
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      if (parsed.pathname === "/api/pricing/unmatched") return new Promise<Response>(() => {});
      return Promise.resolve(readPricing(fixture, parsed, init) ?? Response.json({}));
    });

    renderDrawer("unmatched");

    expect(await screen.findByText("3 pricing rules are active and unaffected.")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Counting" })).toBeTruthy();
    expect(screen.queryByText("All models in range are priced")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View rules" }));
    expect(await screen.findByText("custom/old")).toBeTruthy();
  });

  it("remaps an unmatched model after refreshing an empty official search", async () => {
    let currentOverview = createOverview();
    let capturedSaveBody: UpsertPricingOverrideRequest | null = null;
    let published = false;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      const read = readPricing(currentOverview, parsed, init);
      if (read) return read;
      if (parsed.pathname === "/api/pricing/refresh" && init?.method === "POST") {
        published = true;
        return Response.json({ changed: true });
      }
      if (parsed.pathname === "/api/pricing/models") {
        const q = parsed.searchParams.get("q") ?? "";
        const filtered = q
          ? officialModels.models.filter((item) => item.model.includes(q))
          : officialModels.models;
        const models = published
          ? filtered
          : filtered.filter((item) => item.model === "gpt-5-mini");
        return Response.json({ models, total: models.length });
      }
      if (parsed.pathname === "/api/pricing/overrides" && init?.method === "PUT") {
        capturedSaveBody = JSON.parse(String(init.body));
        currentOverview = {
          ...currentOverview,
          unmatchedModels: [],
          overrides: [
            ...currentOverview.overrides,
            {
              modelKey: "proxy/sonnet-4-5",
              displayModel: "proxy/sonnet-4-5",
              kind: "remap",
              targetModel: "claude-sonnet-4-5",
              effectiveRates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
              targetMissing: false,
              officialPriceAvailable: false,
              officialRates: null,
              updatedAt: 400,
            },
          ],
        };
        return Response.json({ overrides: currentOverview.overrides });
      }
      return Response.json({});
    });

    renderDrawer("unmatched");

    expect(await screen.findByText("proxy/sonnet-4-5")).toBeTruthy();
    expect(screen.getByText("OpenCode")).toBeTruthy();
    expect(screen.getByText("3 sessions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Set price" }));

    const searchInput = await screen.findByPlaceholderText("Search official models");
    expect(await screen.findByRole("button", { name: /gpt-5-mini/i })).toBeTruthy();
    fireEvent.change(searchInput, { target: { value: "claude" } });

    expect(await screen.findByText("No official models match this search.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update models and prices" }));

    const candidate = await screen.findByRole("button", { name: /claude-sonnet-4-5/i });
    expect(candidate.textContent).toContain("Long context");
    fireEvent.click(candidate);

    fireEvent.click(screen.getByRole("button", { name: "Save override" }));

    await waitFor(() => {
      expect(capturedSaveBody).toEqual({
        model: "proxy/sonnet-4-5",
        kind: "remap",
        targetModel: "claude-sonnet-4-5",
      });
      expect(screen.getByText("All models in range are priced")).toBeTruthy();
    });
  });

  it("validates and saves manual USD/1M pricing including $0 free preset", async () => {
    let currentOverview = createOverview();
    let capturedSaveBody: UpsertPricingOverrideRequest | null = null;

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      const read = readPricing(currentOverview, parsed, init);
      if (read) return read;
      if (parsed.pathname === "/api/pricing/models") {
        return Response.json(officialModels);
      }
      if (parsed.pathname === "/api/pricing/overrides" && init?.method === "PUT") {
        capturedSaveBody = JSON.parse(String(init.body));
        currentOverview = { ...currentOverview, unmatchedModels: [] };
        return Response.json({ overrides: currentOverview.overrides });
      }
      return Response.json({});
    });

    renderDrawer("unmatched");
    fireEvent.click(await screen.findByRole("button", { name: "Set price" }));

    fireEvent.click(screen.getByRole("radio", { name: "Manual USD / 1M" }));

    fireEvent.click(screen.getByRole("button", { name: "Save override" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Enter valid non-negative USD/1M rates.");

    fireEvent.click(screen.getByRole("button", { name: "$0 (Free / Local)" }));
    fireEvent.click(screen.getByRole("button", { name: "Save override" }));

    await waitFor(() => {
      expect(capturedSaveBody).toEqual({
        model: "proxy/sonnet-4-5",
        kind: "manual",
        rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    });
  });

  it("prioritizes official updates and missing targets, and handles keep/use-official/edit/remove actions", async () => {
    let currentOverview = createOverview();
    const calls: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      const read = readPricing(currentOverview, parsed, init);
      if (read) return read;
      if (parsed.pathname === "/api/pricing/models") {
        return Response.json(officialModels);
      }
      if (parsed.pathname === "/api/pricing/overrides/acknowledge") {
        const body = JSON.parse(String(init?.body));
        calls.push(`ack:${body.model}`);
        currentOverview = {
          ...currentOverview,
          overrides: currentOverview.overrides.map((item) =>
            item.modelKey === body.model ? { ...item, officialPriceAvailable: false } : item,
          ),
        };
        return Response.json({ overrides: currentOverview.overrides });
      }
      if (parsed.pathname === "/api/pricing/overrides/delete") {
        const body = JSON.parse(String(init?.body));
        calls.push(`del:${body.model}`);
        currentOverview = {
          ...currentOverview,
          overrides: currentOverview.overrides.filter((item) => item.modelKey !== body.model),
        };
        return Response.json({ overrides: currentOverview.overrides });
      }
      return Response.json({});
    });

    renderDrawer("overrides");

    expect(
      await screen.findByText(
        "Official pricing is now available. Your custom rule is still active.",
      ),
    ).toBeTruthy();

    const modelHeadings = screen.getAllByText(/^custom\//).map((element) => element.textContent);
    expect(modelHeadings).toEqual(["custom/new-official", "custom/broken", "custom/old"]);

    expect(
      screen.getByText(
        "Target official model removed-official-model is missing. Edit or remove this rule.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Keep custom rule" }));
    await waitFor(() => {
      expect(calls).toContain("ack:custom/new-official");
      expect(
        screen.queryByText("Official pricing is now available. Your custom rule is still active."),
      ).toBeNull();
    });

    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editButtons[1]!);
    const inputField = await screen.findByLabelText("Input (USD / 1M)");
    expect(inputField).toBeInstanceOf(HTMLInputElement);
    if (inputField instanceof HTMLInputElement) {
      expect(inputField.value).toBe("1");
    }
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const removeButtons = screen.getAllByRole("button", { name: "Remove" });
    fireEvent.click(removeButtons[0]!);
    await waitFor(() => {
      expect(calls).toContain("del:custom/broken");
      expect(screen.queryByText("custom/broken")).toBeNull();
    });
  });

  it("deletes override when clicking Use official price", async () => {
    let currentOverview = createOverview();
    const deletedModels: string[] = [];

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const parsed = new URL(String(input), "http://localhost");
      const read = readPricing(currentOverview, parsed, init);
      if (read) return read;
      if (parsed.pathname === "/api/pricing/overrides/delete") {
        const body = JSON.parse(String(init?.body));
        deletedModels.push(body.model);
        currentOverview = {
          ...currentOverview,
          overrides: currentOverview.overrides.filter((item) => item.modelKey !== body.model),
        };
        return Response.json({ overrides: currentOverview.overrides });
      }
      return Response.json({});
    });

    renderDrawer("overrides");
    fireEvent.click(await screen.findByRole("button", { name: "Use official price" }));

    await waitFor(() => {
      expect(deletedModels).toEqual(["custom/new-official"]);
      expect(screen.queryByText("custom/new-official")).toBeNull();
    });
  });
});
