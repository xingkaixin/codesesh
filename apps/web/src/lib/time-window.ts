import {
  addCalendarDays,
  countCalendarDays,
  parseCalendarDayBoundary,
  startOfCalendarDay,
  toCalendarDayKey,
} from "@codesesh/core/contract";
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

function endOfLocalDay(timestamp: number): number {
  return addCalendarDays(timestamp, 1) - 1;
}

function presetFromDefault(window: TimeWindow, now: number): TimeWindowPreset {
  if (window.days === 0 || window.from == null) return "all";
  if (
    (window.days === 7 || window.days === 14 || window.days === 30 || window.days === 90) &&
    countCalendarDays(window.from, window.to ?? now) === window.days
  ) {
    return `${window.days}d`;
  }
  return "custom";
}

function presetWindow(preset: Exclude<TimeWindowPreset, "custom">, now: number): TimeWindow {
  if (preset === "all") return { from: 0, days: 0 };
  const days = PRESET_DAYS[preset];
  return {
    from: addCalendarDays(startOfCalendarDay(now), -(days - 1)),
    to: endOfLocalDay(now),
    days,
  };
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
    const from = parseCalendarDayBoundary(customFrom, "start");
    const to = parseCalendarDayBoundary(customTo, "end");
    if (from != null && to != null && from <= to) {
      return { preset: range, window: { from, to }, customFrom, customTo };
    }
  }
  const fallbackPreset = presetFromDefault(fallback, now);
  if (fallbackPreset !== "custom") {
    return { preset: fallbackPreset, window: presetWindow(fallbackPreset, now) };
  }
  return {
    preset: fallbackPreset,
    window: fallback,
    customFrom: fallback.from == null ? undefined : toCalendarDayKey(fallback.from),
    customTo: toCalendarDayKey(fallback.to ?? now),
  };
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
