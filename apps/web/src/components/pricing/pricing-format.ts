import type { ModelPriceOverrideView, PricingRatePerMillion } from "@codesesh/contract";

export function formatRatePerMillion(rate: number): string {
  if (!Number.isFinite(rate) || rate === 0) return "$0.00";
  const fixed = rate.toFixed(4);
  const trimmed = fixed.replace(/(\.\d{2,}?)0+$/, "$1");
  if (trimmed === "0.00" && rate > 0) return `$${rate.toPrecision(2)}`;
  return `$${trimmed}`;
}

function overrideAttentionPriority(item: ModelPriceOverrideView): number {
  if (item.officialPriceAvailable) return 0;
  if (item.targetMissing) return 1;
  return 2;
}

export function sortOverridesByAttention(
  overrides: readonly ModelPriceOverrideView[],
): ModelPriceOverrideView[] {
  return [...overrides].sort(
    (left, right) => overrideAttentionPriority(left) - overrideAttentionPriority(right),
  );
}

export function formatRateSummaryValues(rates: PricingRatePerMillion): {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
} {
  return {
    input: formatRatePerMillion(rates.input),
    output: formatRatePerMillion(rates.output),
    cacheRead: formatRatePerMillion(rates.cacheRead),
    cacheWrite: formatRatePerMillion(rates.cacheWrite),
  };
}
