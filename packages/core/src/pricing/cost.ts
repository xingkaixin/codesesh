import type { CostSource, Message, MessageTokens, SessionStats } from "../types/index.js";
import { pricingResolver } from "./resolver.js";

export interface CostUsage extends MessageTokens {
  web_search_requests?: number;
}

export interface CostEstimate {
  cost: number;
  source: CostSource;
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

let pricingMissCapture: Set<string> | null = null;

export const PRICING_CAPTURE_EPOCH = "pricing-capture-v1";

/** Whether a model that previously produced a zero estimate is now billable. */
export function pricingBecameAvailable(unpricedModels: unknown): boolean {
  if (!Array.isArray(unpricedModels)) return false;
  return unpricedModels.some(
    (model) => typeof model === "string" && pricingResolver.resolve(model) !== null,
  );
}

/**
 * Records which models {@link estimateCostForTokens} failed to price during
 * `run`. Cached session heads carry these misses so they can be re-parsed once
 * pricing for those models becomes available.
 */
export function capturePricingMisses<T>(run: () => T): { result: T; unpricedModels: string[] } {
  const previous = pricingMissCapture;
  const capture = new Set<string>();
  pricingMissCapture = capture;
  try {
    return { result: run(), unpricedModels: [...capture] };
  } finally {
    pricingMissCapture = previous;
  }
}

export function estimateCostForTokens(
  model: string | null | undefined,
  usage: CostUsage | undefined,
): CostEstimate | null {
  if (!model || !usage) return null;

  const pricing = pricingResolver.resolve(model);
  if (!pricing) {
    pricingMissCapture?.add(model);
    return null;
  }

  const cacheRead = positive(usage.cache_read);
  const cacheCreate = positive(usage.cache_create);
  const input = Math.max(0, positive(usage.input) - cacheRead - cacheCreate);
  const output = positive(usage.output);
  const reasoning = positive(usage.reasoning);
  const webSearchRequests = positive(usage.web_search_requests);

  const cost =
    input * pricing.inputCostPerToken +
    output * pricing.outputCostPerToken +
    reasoning * pricing.reasoningCostPerToken +
    cacheRead * pricing.cacheReadCostPerToken +
    cacheCreate * pricing.cacheCreateCostPerToken +
    webSearchRequests * pricing.webSearchCostPerRequest;

  return cost > 0 ? { cost: Number(cost.toFixed(8)), source: "estimated" } : null;
}

export function applyMessageCost(message: Message): void {
  if ((message.cost ?? 0) > 0) {
    message.cost_source = "recorded";
    return;
  }

  const estimate = estimateCostForTokens(message.model, message.tokens);
  if (!estimate) return;

  message.cost = estimate.cost;
  message.cost_source = estimate.source;
}

export function applyMessageCosts(messages: Message[]): { totalCost: number; source?: CostSource } {
  let totalCost = 0;
  let source: CostSource | undefined;

  for (const message of messages) {
    applyMessageCost(message);
    const cost = message.cost ?? 0;
    if (cost <= 0) continue;

    totalCost += cost;
    if (message.cost_source === "estimated") source = "estimated";
    else if (!source) source = "recorded";
  }

  return { totalCost: Number(totalCost.toFixed(8)), source };
}

export function withEstimatedSessionCost<T extends SessionStats>(
  stats: T,
  model: string | null | undefined,
): T {
  if (stats.total_cost > 0) {
    return { ...stats, cost_source: stats.cost_source ?? "recorded" };
  }

  const estimate = estimateCostForTokens(model, {
    input: stats.total_input_tokens,
    output: stats.total_output_tokens,
    cache_read: stats.total_cache_read_tokens,
    cache_create: stats.total_cache_create_tokens,
  });
  if (!estimate) return stats;

  return { ...stats, total_cost: estimate.cost, cost_source: estimate.source };
}
