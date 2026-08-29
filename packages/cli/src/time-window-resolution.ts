import {
  addCalendarDays,
  countCalendarDays,
  parseCalendarDayBoundary,
  startOfCalendarDay,
} from "@codesesh/core/contract";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_DAYS = 30;

export interface TimeWindow {
  from?: number;
  to?: number;
  /** Original relative window value used by the UI label. */
  days?: number;
}

interface RawCliTimeWindow {
  from?: string;
  to?: string;
  days?: string;
}

interface CliTimeWindowRequest extends RawCliTimeWindow {
  mode: "cli";
  now?: number;
}

interface DashboardTimeWindowRequest {
  mode: "dashboard";
  window: {
    from?: number;
    to?: number;
    hasExplicitFrom: boolean;
  };
  days?: string;
  defaultDays?: number;
  now?: number;
}

interface DashboardTimeWindow extends TimeWindow {
  to: number;
  days: number;
}

type TimeWindowRequest = CliTimeWindowRequest | DashboardTimeWindowRequest;

export function resolveTimeWindow(request: CliTimeWindowRequest): TimeWindow;
export function resolveTimeWindow(request: DashboardTimeWindowRequest): DashboardTimeWindow;
export function resolveTimeWindow(request: TimeWindowRequest): TimeWindow {
  return request.mode === "cli" ? resolveCliWindow(request) : resolveDashboardWindow(request);
}

function resolveCliWindow(request: CliTimeWindowRequest): TimeWindow {
  const now = request.now ?? Date.now();
  const from = parseRequiredDate(request.from, "start");
  const to = parseRequiredDate(request.to, "end");
  if (from != null && to != null && from > to) {
    throw new Error("Invalid time window: from must not be after to");
  }
  if (from != null) return { from, to };

  const days = parseDays(request.days);
  if (days === 0) return { to, days };
  if (days == null || days < 0) return { to };

  const calendarFrom = addCalendarDays(startOfCalendarDay(to ?? now), -(days - 1));
  return Number.isFinite(calendarFrom) ? { from: calendarFrom, to, days } : { to };
}

function resolveDashboardWindow(request: DashboardTimeWindowRequest): DashboardTimeWindow {
  const now = request.now ?? Date.now();
  const to = request.window.to ?? now;
  const hasQueryDays = Boolean(request.days?.trim());
  const parsedDays = hasQueryDays ? parseDays(request.days) : undefined;

  if (request.window.hasExplicitFrom && request.window.from != null) {
    return { from: request.window.from, to, days: countCalendarDays(request.window.from, to) };
  }

  const days = parsedDays ?? request.defaultDays;
  if (days === 0) {
    return { to, days: 0 };
  }

  if (days != null && days > 0) {
    return {
      from: addCalendarDays(startOfCalendarDay(to), -(days - 1)),
      to,
      days,
    };
  }

  if (request.window.from != null) {
    return { from: request.window.from, to, days: countCalendarDays(request.window.from, to) };
  }

  return {
    from: addCalendarDays(startOfCalendarDay(to), -(DEFAULT_DASHBOARD_DAYS - 1)),
    to,
    days: DEFAULT_DASHBOARD_DAYS,
  };
}

function parseRequiredDate(
  value: string | undefined,
  boundary: "start" | "end",
): number | undefined {
  if (!value) return undefined;
  const calendarBoundary = parseCalendarDayBoundary(value, boundary);
  if (calendarBoundary === null) throw new Error(`Invalid date: ${value}`);
  if (calendarBoundary != null) return calendarBoundary;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new Error(`Invalid date: ${value}`);
  return timestamp;
}

function parseDays(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) return undefined;
  const days = Number(normalized);
  return Number.isSafeInteger(days) && Number.isSafeInteger(days * DAY_MS) ? days : undefined;
}
