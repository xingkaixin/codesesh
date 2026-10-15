import type { DashboardDailyBucket } from "./api";

export type TokenKind = "input" | "output" | "cache_create" | "cache_read";

/** Bottom to top in every stack: fresh tokens first, the cache read band on top. */
export const TOKEN_KINDS: readonly { key: TokenKind; label: string; swatch: string }[] = [
  { key: "input", label: "Input", swatch: "bg-[var(--token-input)]" },
  { key: "output", label: "Output", swatch: "bg-[var(--token-output)]" },
  { key: "cache_create", label: "Cache write", swatch: "bg-[var(--token-cache-write)]" },
  { key: "cache_read", label: "Cache read", swatch: "token-stripes" },
];

export function bucketTokens(bucket: DashboardDailyBucket, includeCacheRead = true): number {
  return (
    bucket.input + bucket.output + bucket.cache_create + (includeCacheRead ? bucket.cache_read : 0)
  );
}

export function sumTokenKinds(daily: readonly DashboardDailyBucket[]): Record<TokenKind, number> {
  const totals: Record<TokenKind, number> = { input: 0, output: 0, cache_create: 0, cache_read: 0 };
  for (const bucket of daily) {
    for (const { key } of TOKEN_KINDS) totals[key] += bucket[key];
  }
  return totals;
}
