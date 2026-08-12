import aliasesData from "./data/aliases.json";
import {
  getPricingRegistry,
  hasBillablePricing,
  normalizeModelKey,
  type ModelPricing,
} from "./fetcher.js";

const BUILTIN_ALIASES = Object.fromEntries(
  Object.entries(aliasesData as Record<string, string>).map(([key, value]) => [
    normalizeModelKey(key),
    normalizeModelKey(value),
  ]),
);

function stripVersion(model: string): string {
  return model.replace(/@.*$/, "").replace(/-\d{8}$/, "");
}

function stripProviderPrefix(model: string): string {
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

function resolveAlias(model: string): string {
  return BUILTIN_ALIASES[model] ?? model;
}

function getCandidates(rawModel: string): string[] {
  const withPrefix = stripVersion(normalizeModelKey(rawModel));
  const stripped = stripProviderPrefix(withPrefix);
  const aliased = resolveAlias(stripped);
  const candidates = [
    withPrefix,
    resolveAlias(withPrefix),
    stripped,
    aliased,
    `anthropic/${stripped}`,
    `openai/${stripped}`,
    `openrouter/openai/${stripped}`,
    `openrouter/anthropic/${stripped}`,
    `moonshotai/${stripped}`,
    `novita/moonshotai/${stripped}`,
  ];

  return [...new Set(candidates.filter(Boolean))];
}

function lookupCandidate(model: string, registry: Map<string, ModelPricing>) {
  const direct = registry.get(model);
  if (direct && hasBillablePricing(direct)) return direct;

  const alias = resolveAlias(model);
  if (alias !== model) {
    const aliased = registry.get(alias);
    if (aliased && hasBillablePricing(aliased)) return aliased;
  }

  return null;
}

function fuzzyLookup(model: string, registry: Map<string, ModelPricing>) {
  let best: [string, ModelPricing] | null = null;
  for (const [key, pricing] of registry.entries()) {
    if (!hasBillablePricing(pricing)) continue;
    if (model.startsWith(`${key}-`) || model.startsWith(`${key}@`) || model === key) {
      if (!best || key.length > best[0].length) best = [key, pricing];
    }
  }
  return best?.[1] ?? null;
}

export interface PricingResolver {
  resolve(rawModelName: string): ModelPricing | null;
}

export const pricingResolver: PricingResolver = {
  resolve(rawModelName: string): ModelPricing | null {
    const registry = getPricingRegistry();
    const candidates = getCandidates(rawModelName);

    for (const candidate of candidates) {
      const pricing = lookupCandidate(candidate, registry);
      if (pricing) return pricing;
    }

    for (const candidate of candidates) {
      const pricing = fuzzyLookup(candidate, registry);
      if (pricing) return pricing;
    }

    return null;
  },
};
