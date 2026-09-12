import type { ModelDistributionEntry } from "./api";
import { t } from "../i18n/translate";
import { formatCompact } from "./format";

export interface ModelBreakdownEntry {
  key: string;
  label: string;
  value: number;
  color: string;
  display: string;
}

export function modelColor(model: string): string {
  // FNV-1a binds color to the model ID, independent of rankings and filters.
  let hash = 2166136261;
  for (const character of model) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `oklch(0.65 0.16 ${(hash >>> 0) % 360})`;
}

export function tokenBreakdown(
  models: ModelDistributionEntry[],
  totalTokens: number,
): ModelBreakdownEntry[] {
  const ranked = models.filter((entry) => entry.tokens > 0).toSorted((a, b) => b.tokens - a.tokens);
  const entries = ranked.slice(0, 5).map((entry) => ({
    key: entry.model,
    label: entry.model,
    value: entry.tokens,
    color: modelColor(entry.model),
    display: formatCompact(entry.tokens),
  }));
  const otherTokens = ranked.slice(5).reduce((sum, entry) => sum + entry.tokens, 0);
  if (otherTokens > 0) {
    entries.push({
      key: "__other",
      label: t("Other"),
      value: otherTokens,
      color: "var(--console-border-strong)",
      display: formatCompact(otherTokens),
    });
  }
  const unknownTokens = totalTokens - ranked.reduce((sum, entry) => sum + entry.tokens, 0);
  if (unknownTokens > 0) {
    entries.push({
      key: "__unknown",
      label: t("Unknown model"),
      value: unknownTokens,
      color: "var(--console-muted)",
      display: formatCompact(unknownTokens),
    });
  }
  return entries;
}
