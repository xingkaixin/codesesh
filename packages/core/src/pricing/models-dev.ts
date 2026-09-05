import type { ModelPricing } from "./fetcher.js";
import { normalizeModelKey } from "./fetcher.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";

const ORIGINAL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "moonshotai",
  "minimax",
  "mistral",
  "xai",
  "cohere",
  "zai",
  "zhipuai",
  "alibaba",
  "meta",
  "stepfun",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function perToken(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value / 1_000_000
    : undefined;
}

export function parseModelsDevPricing(data: unknown): Map<string, ModelPricing> {
  const providers = Object.entries(record(data) ?? {}).sort(
    ([a], [b]) =>
      Number(ORIGINAL_PROVIDERS.has(b)) - Number(ORIGINAL_PROVIDERS.has(a)) || a.localeCompare(b),
  );
  const qualified = new Map<string, ModelPricing>();
  const aliases = new Map<string, ModelPricing>();
  for (const [provider, rawProvider] of providers) {
    const models = record(record(rawProvider)?.["models"]);
    for (const [model, rawModel] of Object.entries(models ?? {})) {
      const cost = record(record(rawModel)?.["cost"]);
      if (!cost) continue;
      const input = perToken(cost["input"]);
      const output = perToken(cost["output"]);
      if (input === undefined || output === undefined) continue;
      const pricing: ModelPricing = {
        inputCostPerToken: input,
        outputCostPerToken: output,
        cacheCreateCostPerToken: perToken(cost["cache_write"]) ?? input,
        cacheReadCostPerToken: perToken(cost["cache_read"]) ?? input,
        reasoningCostPerToken: output,
        webSearchCostPerRequest: 0.01,
      };
      qualified.set(normalizeModelKey(`${provider}/${model}`), pricing);
      const name = normalizeModelKey(model);
      if (!aliases.has(name)) aliases.set(name, pricing);
    }
  }
  return new Map([...aliases, ...qualified]);
}
