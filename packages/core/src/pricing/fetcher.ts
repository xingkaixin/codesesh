import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory, restrictPrivateFile } from "../utils/private-storage.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import snapshotData from "./data/snapshot.json";

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheCreateCostPerToken: number;
  cacheReadCostPerToken: number;
  reasoningCostPerToken: number;
  webSearchCostPerRequest: number;
}

type SnapshotEntry = [number, number, number | null, number | null, number?, number?];

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  output_reasoning_cost_per_token?: number;
  web_search_cost_per_request?: unknown;
  search_context_cost_per_query?: unknown;
}

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const WEB_SEARCH_COST = 0.01;
const REFRESH_TIMEOUT_MS = 10_000;

/**
 * A published set of prices. Estimates read one generation for as long as they
 * need it: a refresh landing mid-scan used to mean the first sessions of a scan
 * were priced differently from the last, with no record of which applied.
 */
export interface PricingGeneration {
  id: number;
  pricing: Map<string, ModelPricing>;
}

let published = createPricingGeneration(loadSnapshot());
/** A completed refresh waiting for a safe point to become current. */
let pending: Map<string, ModelPricing> | null = null;
published = readDiskCache() ?? published;

export function normalizeModelKey(key: string): string {
  return key.trim().toLowerCase().replaceAll("_", "-");
}

function createPricingGeneration(pricing: Map<string, ModelPricing>): PricingGeneration {
  const hash = createHash("sha256");
  const entries = [...pricing.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const [name, modelPricing] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(JSON.stringify(modelPricing));
    hash.update("\n");
  }

  return {
    id: Number.parseInt(hash.digest("hex").slice(0, 13), 16) || 1,
    pricing,
  };
}

function costNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function getCacheDir() {
  return join(homedir(), ".cache", "codesesh");
}

function getCachePath() {
  return join(getCacheDir(), "litellm-pricing.json");
}

function loadSnapshot(): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  const snapshot = snapshotData as unknown as Record<string, SnapshotEntry>;
  for (const [name, entry] of Object.entries(snapshot)) {
    const [input, output, cacheCreate, cacheRead, reasoning, webSearch] = entry;
    indexPricing(map, name, {
      inputCostPerToken: input,
      outputCostPerToken: output,
      cacheCreateCostPerToken: cacheCreate ?? input * 1.25,
      cacheReadCostPerToken: cacheRead ?? input * 0.1,
      reasoningCostPerToken: reasoning ?? output,
      webSearchCostPerRequest: webSearch ?? WEB_SEARCH_COST,
    });
  }
  return map;
}

function parseLiteLLMEntry(entry: LiteLLMEntry): ModelPricing | null {
  return normalizePricing({
    inputCostPerToken: entry.input_cost_per_token,
    outputCostPerToken: entry.output_cost_per_token,
    cacheCreateCostPerToken: entry.cache_creation_input_token_cost,
    cacheReadCostPerToken: entry.cache_read_input_token_cost,
    reasoningCostPerToken: entry.output_reasoning_cost_per_token,
    webSearchCostPerRequest:
      entry.web_search_cost_per_request ?? entry.search_context_cost_per_query,
  });
}

function normalizePricing(raw: Record<string, unknown>): ModelPricing | null {
  const input = costNumber(raw["inputCostPerToken"]);
  const output = costNumber(raw["outputCostPerToken"]);
  if (input === undefined || output === undefined) return null;

  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreateCostPerToken: costNumber(raw["cacheCreateCostPerToken"]) ?? input * 1.25,
    cacheReadCostPerToken: costNumber(raw["cacheReadCostPerToken"]) ?? input * 0.1,
    reasoningCostPerToken: costNumber(raw["reasoningCostPerToken"]) ?? output,
    webSearchCostPerRequest: costNumber(raw["webSearchCostPerRequest"]) ?? WEB_SEARCH_COST,
  };
}

function indexPricing(map: Map<string, ModelPricing>, name: string, pricing: ModelPricing) {
  const normalized = normalizeModelKey(name);
  map.set(normalized, pricing);

  const slashIndex = normalized.indexOf("/");
  if (slashIndex >= 0) {
    const stripped = normalized.slice(slashIndex + 1);
    if (!map.has(stripped)) map.set(stripped, pricing);
  }
}

function parseLiteLLMData(data: Record<string, LiteLLMEntry>): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [name, entry] of Object.entries(data)) {
    const pricing = parseLiteLLMEntry(entry);
    if (pricing) indexPricing(map, name, pricing);
  }
  return map;
}

interface PricingCache {
  timestamp: number;
  data: Record<string, Record<string, unknown>>;
}

function readDiskCache(): PricingGeneration | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;

  try {
    const cached = JSON.parse(readFileSync(path, "utf-8")) as PricingCache;
    if (!Number.isFinite(cached.timestamp)) return null;
    if (cached.data == null || typeof cached.data !== "object" || Array.isArray(cached.data)) {
      return null;
    }

    const next = loadSnapshot();
    for (const [name, rawPricing] of Object.entries(cached.data)) {
      const pricing = normalizePricing(rawPricing);
      if (!pricing) continue;
      next.set(normalizeModelKey(name), pricing);
    }
    return createPricingGeneration(next);
  } catch {
    return null;
  }
}

export function getPricingRegistry(): Map<string, ModelPricing> {
  return published.pricing;
}

/** The generation estimates are currently reading. */
export function getPricingGeneration(): PricingGeneration {
  return published;
}

/** Aligns an isolated worker with the generation selected by its parent. */
export function synchronizePricingGeneration(expectedId: number): void {
  if (!Number.isSafeInteger(expectedId) || expectedId < 1) {
    throw new Error(`Invalid pricing generation: ${expectedId}`);
  }
  if (published.id === expectedId) return;

  const cached = readDiskCache();
  if (cached?.id !== expectedId) {
    throw new Error(
      `Pricing generation ${expectedId} is unavailable (current ${published.id}, cached ${cached?.id ?? "none"})`,
    );
  }

  published = cached;
  getCoreDiagnostics()?.info?.("pricing.generation.synchronized", {
    generation: published.id,
    models: published.pricing.size,
  });
}

/**
 * Makes a completed refresh current. Owners call this between scans, never
 * during one, so a scan cannot span two generations.
 */
export function publishPendingPricing(): boolean {
  if (!pending) return false;

  const next = createPricingGeneration(pending);
  if (!writeDiskCacheAtomically(getCachePath(), next)) return false;

  published = next;
  pending = null;
  getCoreDiagnostics()?.info?.("pricing.generation.published", {
    generation: published.id,
    models: published.pricing.size,
  });
  return true;
}

/** Whether a refresh is waiting to be published. */
export function hasPendingPricing(): boolean {
  return pending !== null;
}

export function hasBillablePricing(pricing: ModelPricing): boolean {
  return (
    pricing.inputCostPerToken > 0 ||
    pricing.outputCostPerToken > 0 ||
    pricing.cacheReadCostPerToken > 0 ||
    pricing.cacheCreateCostPerToken > 0
  );
}

/** Replaces the cache in one step, so an interrupted write cannot truncate it. */
function writeDiskCacheAtomically(path: string, generation: PricingGeneration): boolean {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const payload = JSON.stringify({
    timestamp: Date.now(),
    data: Object.fromEntries(generation.pricing),
  });
  try {
    ensurePrivateDirectory(getCacheDir());
    writeFileSync(temporaryPath, payload);
    restrictPrivateFile(temporaryPath);
    renameSync(temporaryPath, path);
    return true;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    getCoreDiagnostics()?.warn("pricing.cache_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface RefreshPricingOptions {
  /** Abort the request when it outlives a startup's patience. */
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Fetches prices into a pending generation. It does not become current until
 * {@link publishPendingPricing}, so an in-flight scan keeps the prices it
 * started with.
 */
export async function refreshPricingCache(options: RefreshPricingOptions = {}): Promise<boolean> {
  const path = getCachePath();
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf-8")) as { timestamp?: number };
      if (typeof cached.timestamp === "number" && Date.now() - cached.timestamp <= CACHE_TTL_MS) {
        return false;
      }
    } catch {
      // refresh malformed cache
    }
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? REFRESH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  getCoreDiagnostics()?.info?.("pricing.refresh.started", { generation: published.id });
  try {
    const response = await fetch(LITELLM_URL, { signal });
    if (!response.ok) return false;
    const data = (await response.json()) as Record<string, LiteLLMEntry>;
    const remote = parseLiteLLMData(data);
    if (remote.size === 0) return false;

    const next = loadSnapshot();
    for (const [name, pricing] of remote.entries()) {
      next.set(name, pricing);
    }

    pending = next;
    getCoreDiagnostics()?.info?.("pricing.refresh.completed", {
      generation: published.id,
      models: next.size,
    });
    return true;
  } catch (error) {
    getCoreDiagnostics()?.warn("pricing.refresh.failed", {
      generation: published.id,
      aborted: signal.aborted,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
