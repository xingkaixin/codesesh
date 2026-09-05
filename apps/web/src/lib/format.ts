import { getLocale } from "../i18n/language";
import { t } from "../i18n/translate";
/**
 * Shared display-formatting helpers.
 * Pure functions consumed across Dashboard, Projects, DetailLanding, and session-detail views.
 */

export function formatRelativeTime(timestamp?: number | null) {
  if (!timestamp) return t("unknown");
  const diff = Date.now() - timestamp;
  if (Number.isNaN(diff) || diff < 0) return t("just now");
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{0}m ago", [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{0}h ago", [hours]);
  return t("{0}d ago", [Math.floor(hours / 24)]);
}

export function formatNumber(value: number) {
  return value.toLocaleString(getLocale());
}

export function formatMoney(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatCostSource(source?: "recorded" | "estimated"): string | undefined {
  if (source === "recorded") return t("recorded");
  if (source === "estimated") return t("estimated");
  return undefined;
}

export function formatTokens(n: number) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString(getLocale());
}

export function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatInt(value);
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Money for a fixed slot — a ring's centre, a fixed-width column. Thousands and
 * up collapse to a suffix, keeping two significant decimals: `$12,878.91` is
 * wide enough to overrun the hole it sits in, `$12.88k` is not.
 */
export function formatUsdCompact(value: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (magnitude >= 1_000) return `$${(value / 1_000).toFixed(2)}k`;
  return formatUsd(value);
}

/** `null` means "no comparable baseline" — the caller omits the trend entirely. */
export function formatDelta(current: number, previous: number): string | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  const change = (current - previous) / previous;
  return `${change < 0 ? "▼" : "▲"} ${Math.round(Math.abs(change) * 100)}%`;
}

export function formatRelativeShort(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 60_000) return t("just now");
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t("{0}m ago", [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{0}h ago", [hours]);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const date = new Date(timestamp);
  if (isSameCalendarDay(date, yesterday)) return t("Yesterday");
  return formatMonthDay(date.getTime());
}

export function formatMonthDay(date: string | number): string {
  if (typeof date === "string") {
    // Read the day out of the string: "YYYY-MM-DD" parses as UTC midnight,
    // which renders as the previous day west of Greenwich.
    const isoDay = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
    if (isoDay) return `${isoDay[2]}-${isoDay[3]}`;
  }
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

export function formatClockTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function formatPercent(ratio: number): string {
  // 0 / 0 is a real input (a range with no tokens); report 0%, not NaN%.
  if (!Number.isFinite(ratio)) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatMessageTime(rawTime: number | string | null | undefined): string | null {
  if (rawTime == null) return null;
  if (typeof rawTime === "number" && (!Number.isFinite(rawTime) || rawTime <= 0)) return null;

  let date: Date | null = null;
  if (typeof rawTime === "number") {
    const normalized = rawTime < 10 ** 12 ? rawTime * 1000 : rawTime;
    date = new Date(normalized);
  } else if (typeof rawTime === "string") {
    if (rawTime.trim()) {
      const timestamp = Number(rawTime);
      if (Number.isFinite(timestamp) && timestamp > 0) {
        date = new Date(timestamp < 10 ** 12 ? timestamp * 1000 : timestamp);
      } else {
        date = Number.isFinite(timestamp) ? null : new Date(rawTime);
      }
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString(getLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: getLocale() === "en",
  });
}
