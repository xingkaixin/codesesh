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

let published: PricingGeneration = { id: 1, pricing: loadSnapshot() };
/** A completed refresh waiting for a safe point to become current. */
let pending: Map<string, ModelPricing> | null = null;
loadDiskCache();

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function costNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    map.set(normalizeKey(name), {
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
  const input = entry.input_cost_per_token;
  const output = entry.output_cost_per_token;
  if (typeof input !== "number" || typeof output !== "number") return null;

  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreateCostPerToken: entry.cache_creation_input_token_cost ?? input * 1.25,
    cacheReadCostPerToken: entry.cache_read_input_token_cost ?? input * 0.1,
    reasoningCostPerToken: entry.output_reasoning_cost_per_token ?? output,
    webSearchCostPerRequest: costNumber(
      entry.web_search_cost_per_request ?? entry.search_context_cost_per_query,
      WEB_SEARCH_COST,
    ),
  };
}

function normalizeCachedPricing(raw: Record<string, unknown>): ModelPricing | null {
  const input = costNumber(raw["inputCostPerToken"], 0);
  const output = costNumber(raw["outputCostPerToken"], 0);
  if (input <= 0 || output <= 0) return null;

  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreateCostPerToken: costNumber(raw["cacheCreateCostPerToken"], input * 1.25),
    cacheReadCostPerToken: costNumber(raw["cacheReadCostPerToken"], input * 0.1),
    reasoningCostPerToken: costNumber(raw["reasoningCostPerToken"], output),
    webSearchCostPerRequest: costNumber(raw["webSearchCostPerRequest"], WEB_SEARCH_COST),
  };
}

function indexPricing(map: Map<string, ModelPricing>, name: string, pricing: ModelPricing) {
  const normalized = normalizeKey(name);
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

function loadDiskCache() {
  const path = getCachePath();
  if (!existsSync(path)) return;

  try {
    const cached = JSON.parse(readFileSync(path, "utf-8")) as {
      timestamp: number;
      data: Record<string, Record<string, unknown>>;
    };
    if (Date.now() - cached.timestamp <= CACHE_TTL_MS) {
      const next = loadSnapshot();
      for (const [name, rawPricing] of Object.entries(cached.data)) {
        const pricing = normalizeCachedPricing(rawPricing);
        if (!pricing) continue;
        next.set(normalizeKey(name), pricing);
      }
      published = { id: published.id + 1, pricing: next };
    }
  } catch {
    // ignore malformed cache
  }
}

export function getPricingRegistry(): Map<string, ModelPricing> {
  return published.pricing;
}

/** The generation estimates are currently reading. */
export function getPricingGeneration(): PricingGeneration {
  return published;
}

/**
 * Makes a completed refresh current. Owners call this between scans, never
 * during one, so a scan cannot span two generations.
 */
export function publishPendingPricing(): boolean {
  if (!pending) return false;
  published = { id: published.id + 1, pricing: pending };
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
function writeDiskCacheAtomically(path: string, pricing: Map<string, ModelPricing>): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const payload = JSON.stringify({ timestamp: Date.now(), data: Object.fromEntries(pricing) });
  try {
    ensurePrivateDirectory(getCacheDir());
    writeFileSync(temporaryPath, payload);
    restrictPrivateFile(temporaryPath);
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    getCoreDiagnostics()?.warn("pricing.cache_write_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
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
    writeDiskCacheAtomically(path, next);
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
