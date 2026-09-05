import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHome = mkdtempSync(join(tmpdir(), "codesesh-pricing-refresh-"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => testHome };
});

const { setCoreDiagnostics } = await import("../../utils/diagnostics.js");
const { estimateTokenCost } = await import("../../utils/cost.js");
const { getPricingGeneration, hasPendingPricing, publishPendingPricing, refreshPricingCache } =
  await import("../fetcher.js");

const MODEL = "claude-sonnet-4-5";
const MILLION_INPUT = { input: 1_000_000, output: 0 };
const cachePath = join(testHome, ".cache", "codesesh", "models-dev-pricing.json");

/** A remote payload that moves this model's price to an unmistakable value. */
function remotePricing(inputCost: number) {
  return {
    anthropic: {
      models: {
        [MODEL]: { cost: { input: inputCost * 1_000_000, output: inputCost * 1_000_000 } },
      },
    },
  };
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal("fetch", handler);
}

beforeEach(() => {
  rmSync(cachePath, { force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  publishPendingPricing();
});

describe("CS-148: pricing generations", () => {
  it("reuses fresh prices across process restarts without fetching", async () => {
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));
    await refreshPricingCache();
    publishPendingPricing();
    vi.resetModules();
    const restarted = await import("../fetcher.js");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await restarted.refreshPricingCache()).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(restarted.getPricingRegistry().get(MODEL)?.inputCostPerToken).toBe(0.000123);
  });

  it("refreshes an expired cache and makes a previously missing model priceable", async () => {
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));
    await refreshPricingCache();
    publishPendingPricing();
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    cache.timestamp = Date.now() - 60 * 60 * 1000;
    writeFileSync(cachePath, JSON.stringify(cache));
    vi.resetModules();
    const restarted = await import("../fetcher.js");
    const { pricingBecameAvailable } = await import("../cost.js");
    const missing = ["brand-new-model"];
    expect(pricingBecameAvailable(missing)).toBe(false);
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        openai: { models: { "brand-new-model": { cost: { input: 2, output: 8 } } } },
      }),
    }));
    vi.stubGlobal("fetch", fetch);
    expect(await restarted.refreshPricingCache()).toBe(true);
    expect(fetch).toHaveBeenCalledWith("https://models.dev/api.json", expect.any(Object));
    expect(pricingBecameAvailable(missing)).toBe(false);
    restarted.publishPendingPricing();
    expect(pricingBecameAvailable(missing)).toBe(true);
  });

  it.each([{}, { bad: null }, { bad: { inputCostPerToken: -1 } }])(
    "refreshes a fresh but unusable cache: %j",
    async (data) => {
      mkdirSync(join(testHome, ".cache", "codesesh"), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ timestamp: Date.now(), data }));
      stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));
      expect(await refreshPricingCache()).toBe(true);
    },
  );

  it("shares concurrent refresh requests", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));
    vi.stubGlobal("fetch", fetch);
    expect(await Promise.all([refreshPricingCache(), refreshPricingCache()])).toEqual([true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loads stale cache data and derives generation identity from its content", async () => {
    mkdirSync(join(testHome, ".cache", "codesesh"), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
        generation: 41,
        data: {
          "vertex_ai/cs_202_model": {
            inputCostPerToken: 0.000001,
            outputCostPerToken: 0.000002,
          },
        },
      }),
    );

    vi.resetModules();
    const isolatedPricing = await import("../fetcher.js");
    const isolatedResolver = await import("../resolver.js");
    const firstGeneration = isolatedPricing.getPricingGeneration().id;

    expect(isolatedResolver.pricingResolver.resolve("vertex_ai/cs_202_model")).not.toBeNull();

    writeFileSync(
      cachePath,
      JSON.stringify({
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
        generation: 41,
        data: {
          "vertex_ai/cs_202_model": {
            inputCostPerToken: 0.000003,
            outputCostPerToken: 0.000004,
          },
        },
      }),
    );
    vi.resetModules();
    const changedPricing = await import("../fetcher.js");

    expect(changedPricing.getPricingGeneration().id).not.toBe(firstGeneration);
  });

  it("CS-194: keeps parent and isolated worker pricing on one generation", async () => {
    vi.resetModules();
    const { getPricingGeneration, getPricingRegistry, refreshPricingCache, publishPendingPricing } =
      await import("../fetcher.js");
    const generationBefore = getPricingGeneration().id;
    const pricingBefore = getPricingRegistry().get(MODEL);
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000777) }));

    expect(await refreshPricingCache()).toBe(true);
    expect(existsSync(cachePath)).toBe(false);

    vi.resetModules();
    const workerPricing = await import("../fetcher.js");
    expect(workerPricing.getPricingGeneration().id).toBe(generationBefore);
    expect(workerPricing.getPricingRegistry().get(MODEL)).toEqual(pricingBefore);

    expect(publishPendingPricing()).toBe(true);
    const publishedGeneration = getPricingGeneration();
    expect(workerPricing.getPricingGeneration().id).toBe(generationBefore);

    workerPricing.synchronizePricingGeneration(publishedGeneration.id);
    expect(workerPricing.getPricingGeneration()).toEqual(publishedGeneration);
  });

  it.each([
    [
      "zero input or output prices",
      {
        "input-only": { input: 0.000001, output: 0 },
        "output-only": { input: 0, output: 0.000002 },
        free: { input: 0, output: 0 },
      },
    ],
    [
      "nested provider prefixes",
      {
        "provider/vendor/chat-model": {
          input: 0.000001,
          output: 0.000002,
        },
      },
    ],
    [
      "invalid optional prices",
      {
        "fallback-prices": {
          input: 0.000001,
          output: 0.000002,
          cache_write: Infinity,
          cache_read: NaN,
        },
      },
    ],
  ])("preserves the complete published generation with %s", async (_name, data) => {
    vi.resetModules();
    const parentPricing = await import("../fetcher.js");
    vi.resetModules();
    const existingWorkerPricing = await import("../fetcher.js");
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        test: {
          models: Object.fromEntries(Object.entries(data).map(([name, cost]) => [name, { cost }])),
        },
      }),
    }));

    expect(await parentPricing.refreshPricingCache()).toBe(true);
    expect(parentPricing.publishPendingPricing()).toBe(true);
    const publishedGeneration = parentPricing.getPricingGeneration();
    for (const [name, entry] of Object.entries(data)) {
      expect(publishedGeneration.pricing.get(name)).toMatchObject({
        inputCostPerToken: entry.input / 1_000_000,
        outputCostPerToken: entry.output / 1_000_000,
      });
    }
    existingWorkerPricing.synchronizePricingGeneration(publishedGeneration.id);
    expect(existingWorkerPricing.getPricingGeneration()).toEqual(publishedGeneration);

    vi.resetModules();
    const newWorkerPricing = await import("../fetcher.js");
    expect(newWorkerPricing.getPricingGeneration()).toEqual(publishedGeneration);
  });

  it("does not change live prices until the refresh is published", async () => {
    const before = estimateTokenCost(MODEL, MILLION_INPUT);
    const generationBefore = getPricingGeneration().id;
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000999) }));

    expect(await refreshPricingCache()).toBe(true);
    expect(existsSync(cachePath)).toBe(false);

    // A scan in flight keeps the prices it started with.
    expect(estimateTokenCost(MODEL, MILLION_INPUT)).toBe(before);
    expect(getPricingGeneration().id).toBe(generationBefore);
    expect(hasPendingPricing()).toBe(true);

    expect(publishPendingPricing()).toBe(true);
    expect(estimateTokenCost(MODEL, MILLION_INPUT)).toBe(999);
    expect(getPricingGeneration().id).not.toBe(generationBefore);
  });

  it("reports nothing to publish when no refresh completed", () => {
    expect(hasPendingPricing()).toBe(false);
    expect(publishPendingPricing()).toBe(false);
  });

  it.each([
    ["an HTTP failure", async () => ({ ok: false, json: async () => ({}) })],
    ["an empty payload", async () => ({ ok: true, json: async () => ({}) })],
    [
      "a malformed payload",
      async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    ],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("leaves the current generation alone after %s", async (_name, handler) => {
    const before = estimateTokenCost(MODEL, MILLION_INPUT);
    const generationBefore = getPricingGeneration().id;
    stubFetch(handler as never);

    expect(await refreshPricingCache()).toBe(false);

    expect(hasPendingPricing()).toBe(false);
    expect(estimateTokenCost(MODEL, MILLION_INPUT)).toBe(before);
    expect(getPricingGeneration().id).toBe(generationBefore);
  });

  it("gives up on a request that never answers", async () => {
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const started = performance.now();
    expect(await refreshPricingCache({ timeoutMs: 50 })).toBe(false);

    expect(performance.now() - started).toBeLessThan(2_000);
    expect(hasPendingPricing()).toBe(false);
  });

  it("abandons a refresh its caller cancelled", async () => {
    const controller = new AbortController();
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const refresh = refreshPricingCache({ signal: controller.signal });
    controller.abort();

    expect(await refresh).toBe(false);
    expect(hasPendingPricing()).toBe(false);
  });

  it("publishes the disk cache in one step", async () => {
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));

    await refreshPricingCache();
    expect(existsSync(cachePath)).toBe(false);
    expect(publishPendingPricing()).toBe(true);

    const raw = readFileSync(cachePath, "utf8");
    // A truncated write would not parse.
    const parsed = JSON.parse(raw) as {
      timestamp: number;
      data: Record<string, unknown>;
    };
    expect(typeof parsed.timestamp).toBe("number");
    expect(Object.keys(parsed.data).length).toBeGreaterThan(0);
    expect(existsSync(`${cachePath}.${process.pid}.tmp`)).toBe(false);
  });

  it("reports a failed disk write and leaves no partial file", async () => {
    // A non-empty directory in the cache file's place makes the rename fail.
    rmSync(cachePath, { force: true });
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, "blocker"), "x");
    const events: string[] = [];
    setCoreDiagnostics({ warn: (event) => events.push(event) });
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000321) }));
    const generationBefore = getPricingGeneration();

    try {
      expect(await refreshPricingCache()).toBe(true);
      expect(publishPendingPricing()).toBe(false);
    } finally {
      setCoreDiagnostics(null);
      rmSync(cachePath, { recursive: true, force: true });
    }

    expect(events).toContain("pricing.cache_write_failed");
    expect(getPricingGeneration()).toBe(generationBefore);
    expect(hasPendingPricing()).toBe(true);
    expect(existsSync(`${cachePath}.${process.pid}.tmp`)).toBe(false);
  });
});
