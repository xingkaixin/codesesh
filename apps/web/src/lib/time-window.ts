import type { AppConfig } from "./api";

export type TimeWindow = AppConfig["window"];
export type TimeWindowPreset = "7d" | "14d" | "30d" | "90d" | "all" | "custom";

export interface ResolvedTimeWindow {
  preset: TimeWindowPreset;
  window: TimeWindow;
  customFrom?: string;
  customTo?: string;
}

const PRESET_DAYS: Record<Exclude<TimeWindowPreset, "all" | "custom">, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfLocalDay(timestamp: number): number {
  const date = new Date(startOfLocalDay(timestamp));
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1;
}

function parseLocalDate(value: string, endOfDay: boolean): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = endOfDay ? new Date(year, month, day + 1, 0, 0, 0, -1) : new Date(year, month, day);
  const validation = new Date(year, month, day);
  if (
    validation.getFullYear() !== year ||
    validation.getMonth() !== month ||
    validation.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

function presetFromDefault(window: TimeWindow): TimeWindowPreset {
  if (window.days === 0 || window.from == null) return "all";
  if (window.days === 7 || window.days === 14 || window.days === 30 || window.days === 90) {
    return `${window.days}d`;
  }
  return "custom";
}

function presetWindow(preset: Exclude<TimeWindowPreset, "custom">, now: number): TimeWindow {
  const todayStart = startOfLocalDay(now);
  const todayEnd = endOfLocalDay(now);
  if (preset === "all") return { from: 0, days: 0 };
  const days = PRESET_DAYS[preset];
  const today = new Date(todayStart);
  const from = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - days + 1,
  ).getTime();
  return { from, to: todayEnd, days };
}

export function resolveTimeWindow(
  params: URLSearchParams,
  fallback: TimeWindow,
  now = Date.now(),
): ResolvedTimeWindow {
  const range = params.get("range") as TimeWindowPreset | null;
  if (range && range !== "custom" && range in PRESET_DAYS) {
    return { preset: range, window: presetWindow(range, now) };
  }
  if (range === "all") return { preset: range, window: presetWindow(range, now) };
  if (range === "custom") {
    const customFrom = params.get("from") ?? "";
    const customTo = params.get("to") ?? "";
    const from = parseLocalDate(customFrom, false);
    const to = parseLocalDate(customTo, true);
    if (from != null && to != null && from <= to) {
      return { preset: range, window: { from, to }, customFrom, customTo };
    }
  }
  const fallbackPreset = presetFromDefault(fallback);
  if (fallbackPreset !== "custom") {
    return { preset: fallbackPreset, window: presetWindow(fallbackPreset, now) };
  }
  return {
    preset: fallbackPreset,
    window: fallback,
    customFrom: fallback.from == null ? undefined : formatLocalDate(fallback.from),
    customTo: formatLocalDate(fallback.to ?? now),
  };
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function writeTimeWindowPreset(params: URLSearchParams, preset: TimeWindowPreset) {
  const next = new URLSearchParams(params);
  next.set("range", preset);
  next.delete("from");
  next.delete("to");
  return next;
}

export function writeCustomTimeWindow(params: URLSearchParams, from: string, to: string) {
  const next = new URLSearchParams(params);
  next.set("range", "custom");
  next.set("from", from);
  next.set("to", to);
  return next;
}
