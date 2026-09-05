import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory, restrictPrivateFile } from "../utils/private-storage.js";
import { getCoreDiagnostics } from "../utils/diagnostics.js";
import { MODELS_DEV_URL, parseModelsDevPricing } from "./models-dev.js";
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

const CACHE_TTL_MS = 60 * 60 * 1000;
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
let refreshInFlight: Promise<boolean> | null = null;
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
  return join(getCacheDir(), "models-dev-pricing.json");
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

function normalizePricing(raw: unknown): ModelPricing | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = raw as Record<string, unknown>;
  const input = costNumber(values["inputCostPerToken"]);
  const output = costNumber(values["outputCostPerToken"]);
  if (input === undefined || output === undefined) return null;

  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheCreateCostPerToken: costNumber(values["cacheCreateCostPerToken"]) ?? input * 1.25,
    cacheReadCostPerToken: costNumber(values["cacheReadCostPerToken"]) ?? input * 0.1,
    reasoningCostPerToken: costNumber(values["reasoningCostPerToken"]) ?? output,
    webSearchCostPerRequest: costNumber(values["webSearchCostPerRequest"]) ?? WEB_SEARCH_COST,
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

interface PricingCache {
  timestamp: number;
  data: Record<string, Record<string, unknown>>;
}

function readDiskCache(requireFresh = false): PricingGeneration | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;

  try {
    const cached = JSON.parse(readFileSync(path, "utf-8")) as PricingCache;
    if (!Number.isFinite(cached.timestamp) || cached.timestamp > Date.now()) return null;
    if (requireFresh && Date.now() - cached.timestamp >= CACHE_TTL_MS) return null;
    if (cached.data == null || typeof cached.data !== "object" || Array.isArray(cached.data)) {
      return null;
    }

    const next = loadSnapshot();
    let validEntries = 0;
    for (const [name, rawPricing] of Object.entries(cached.data)) {
      const pricing = normalizePricing(rawPricing);
      if (!pricing) continue;
      next.set(normalizeModelKey(name), pricing);
      validEntries++;
    }
    return validEntries > 0 ? createPricingGeneration(next) : null;
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
export function refreshPricingCache(options: RefreshPricingOptions = {}): Promise<boolean> {
  refreshInFlight ??= fetchPricing(options).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function fetchPricing(options: RefreshPricingOptions): Promise<boolean> {
  if (pending || readDiskCache(true)) return false;

  const timeout = AbortSignal.timeout(options.timeoutMs ?? REFRESH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  getCoreDiagnostics()?.info?.("pricing.refresh.started", { generation: published.id });
  try {
    const response = await fetch(MODELS_DEV_URL, { signal });
    if (!response.ok) return false;
    const remote = parseModelsDevPricing(await response.json());
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
