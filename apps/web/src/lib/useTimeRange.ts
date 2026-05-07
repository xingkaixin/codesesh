import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { AppConfig, TimeRange } from "./api";

const PRESET_DAYS = new Set([1, 3, 7, 14, 30, 90]);

export function isValidIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  // Round-trip check: JS silently normalizes 2026-02-31 → 2026-03-03 etc., so
  // a malformed URL like ?from=2026-02-31 would otherwise pass and query the
  // wrong calendar day. Reject any string whose parsed components don't
  // round-trip back to themselves.
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(year, month - 1, day);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getFullYear() === year &&
    d.getMonth() === month - 1 &&
    d.getDate() === day
  );
}

export function parseRangeParam(value: string | null): TimeRange | null {
  if (!value) return null;
  if (value === "all") return { kind: "all" };
  if (value === "yesterday") return { kind: "yesterday" };
  const m = /^(\d+)d$/.exec(value);
  if (!m) return null;
  const days = parseInt(m[1]!, 10);
  if (!Number.isFinite(days) || days <= 0) return null;
  return { kind: "preset", days };
}

export function rangeFromAppConfig(config: AppConfig | null): TimeRange | null {
  if (!config) return null;
  const { from, to, days } = config.window;
  if (from == null && to == null && days == null) return null;
  if (days != null && days > 0 && to == null) return { kind: "preset", days };
  if (from != null) {
    const fromIso = formatLocalIsoDate(from);
    const toIso = to != null ? formatLocalIsoDate(to) : undefined;
    return { kind: "custom", from: fromIso, to: toIso };
  }
  return null;
}

export function formatLocalIsoDate(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function formatRangeLabel(range: TimeRange | null): string {
  if (!range) return "All time";
  if (range.kind === "all") return "All time";
  if (range.kind === "yesterday") return "Yesterday";
  if (range.kind === "preset") {
    if (PRESET_DAYS.has(range.days)) return `Last ${range.days}d`;
    return `Last ${range.days}d`;
  }
  if (range.to) return `${range.from} → ${range.to}`;
  return `From ${range.from}`;
}

export interface UseTimeRangeResult {
  /** Effective range: URL state > CLI fallback. `null` ⇒ no filter (show everything). */
  range: TimeRange | null;
  /** Whether the current range came from the URL (vs fallback). */
  fromUrl: boolean;
  /** Update URL search params; pass null to clear (revert to fallback). */
  setRange: (next: TimeRange | null) => void;
}

/**
 * URL search-param backed time range, with CLI flag fallback.
 *
 * Encoding:
 *   ?range=7d|30d|90d|all     preset / all-time
 *   ?from=YYYY-MM-DD[&to=...] custom window
 * If neither is present, falls back to `cliFallback` (config.window).
 */
export function useTimeRange(cliFallback: TimeRange | null): UseTimeRangeResult {
  const [searchParams, setSearchParams] = useSearchParams();

  const range = useMemo<TimeRange | null>(() => {
    const from = searchParams.get("from");
    const to = searchParams.get("to") ?? undefined;
    if (from && isValidIsoDate(from) && (!to || isValidIsoDate(to))) {
      return { kind: "custom", from, to };
    }
    const preset = parseRangeParam(searchParams.get("range"));
    if (preset) return preset;
    return cliFallback;
  }, [searchParams, cliFallback]);

  const fromUrl = useMemo(
    () => searchParams.has("range") || searchParams.has("from"),
    [searchParams],
  );

  const setRange = useCallback(
    (next: TimeRange | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete("range");
          params.delete("from");
          params.delete("to");
          if (next) {
            if (next.kind === "preset") params.set("range", `${next.days}d`);
            else if (next.kind === "all") params.set("range", "all");
            else if (next.kind === "yesterday") params.set("range", "yesterday");
            else {
              params.set("from", next.from);
              if (next.to) params.set("to", next.to);
            }
          }
          return params;
        },
        { replace: false },
      );
    },
    [setSearchParams],
  );

  return { range, fromUrl, setRange };
}
