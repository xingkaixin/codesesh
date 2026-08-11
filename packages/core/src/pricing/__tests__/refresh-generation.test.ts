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
const {
  getPricingGeneration,
  getPricingRegistry,
  hasPendingPricing,
  publishPendingPricing,
  refreshPricingCache,
} = await import("../fetcher.js");

const MODEL = "claude-sonnet-4-5";
const MILLION_INPUT = { input: 1_000_000, output: 0 };
const cachePath = join(testHome, ".cache", "codesesh", "litellm-pricing.json");

/** A remote payload that moves this model's price to an unmistakable value. */
function remotePricing(inputCost: number) {
  return {
    [MODEL]: { input_cost_per_token: inputCost, output_cost_per_token: inputCost },
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
  it("CS-194: keeps parent and isolated worker pricing on one generation", async () => {
    const generationBefore = getPricingGeneration().id;
    const pricingBefore = getPricingRegistry().get(MODEL);
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000999) }));

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
    expect(getPricingGeneration().id).toBe(generationBefore + 1);
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

  it("publishes the disk cache and generation in one step", async () => {
    stubFetch(async () => ({ ok: true, json: async () => remotePricing(0.000123) }));

    await refreshPricingCache();
    expect(existsSync(cachePath)).toBe(false);
    expect(publishPendingPricing()).toBe(true);

    const raw = readFileSync(cachePath, "utf8");
    // A truncated write would not parse.
    const parsed = JSON.parse(raw) as {
      timestamp: number;
      generation: number;
      data: Record<string, unknown>;
    };
    expect(typeof parsed.timestamp).toBe("number");
    expect(parsed.generation).toBe(getPricingGeneration().id);
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
