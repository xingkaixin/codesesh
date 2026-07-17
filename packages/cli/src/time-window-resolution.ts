import { startOfLocalDay } from "@codesesh/core";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DASHBOARD_DAYS = 30;

export interface TimeWindow {
  from?: number;
  to?: number;
  /** Original relative window value used by the UI label. */
  days?: number;
}

interface RawTimeWindow {
  from?: string;
  to?: string;
  days?: string;
}

interface CliTimeWindowRequest extends RawTimeWindow {
  mode: "cli";
  now?: number;
}

interface DashboardTimeWindowRequest {
  mode: "dashboard";
  query: RawTimeWindow;
  defaults?: TimeWindow;
  now?: number;
}

interface DashboardTimeWindow extends TimeWindow {
  to: number;
}

type TimeWindowRequest = CliTimeWindowRequest | DashboardTimeWindowRequest;

export function resolveTimeWindow(request: CliTimeWindowRequest): TimeWindow;
export function resolveTimeWindow(request: DashboardTimeWindowRequest): DashboardTimeWindow;
export function resolveTimeWindow(request: TimeWindowRequest): TimeWindow {
  return request.mode === "cli" ? resolveCliWindow(request) : resolveDashboardWindow(request);
}

function resolveCliWindow(request: CliTimeWindowRequest): TimeWindow {
  const now = request.now ?? Date.now();
  const from = parseRequiredDate(request.from);
  const to = parseRequiredDate(request.to);
  if (from != null) return { from, to };

  const days = parseDays(request.days);
  if (days === 0) return { to, days };
  if (days == null || days < 0) return { to };

  const rollingFrom = now - days * DAY_MS;
  return Number.isFinite(rollingFrom) ? { from: rollingFrom, to, days } : { to };
}

function resolveDashboardWindow(request: DashboardTimeWindowRequest): DashboardTimeWindow {
  const now = request.now ?? Date.now();
  const defaults = request.defaults ?? {};
  const to = parseOptionalDate(request.query.to) ?? defaults.to ?? now;
  const hasQueryDays = Boolean(request.query.days?.trim());
  const parsedDays = hasQueryDays ? parseDays(request.query.days) : undefined;
  let days = parsedDays != null && parsedDays > 0 ? parsedDays : defaults.days;

  const queryFrom = parseOptionalDate(request.query.from);
  if (queryFrom != null) {
    days ??= elapsedDays(queryFrom, to);
    return { from: queryFrom, to, days };
  }

  if (parsedDays === 0 || (!hasQueryDays && defaults.days === 0)) {
    return { to, days: 0 };
  }

  if (defaults.from != null) {
    days ??= elapsedDays(defaults.from, to);
    return { from: defaults.from, to, days };
  }

  const resolvedDays = days != null && days > 0 ? days : DEFAULT_DASHBOARD_DAYS;
  return {
    from: startOfLocalDay(to) - (resolvedDays - 1) * DAY_MS,
    to,
    days: resolvedDays,
  };
}

function parseRequiredDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) throw new Error(`Invalid date: ${value}`);
  return timestamp;
}

function parseOptionalDate(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function parseDays(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const days = Number.parseInt(value, 10);
  return Number.isSafeInteger(days) && Number.isSafeInteger(days * DAY_MS) ? days : undefined;
}

function elapsedDays(from: number, to: number): number {
  return Math.max(1, Math.ceil((to - from) / DAY_MS));
}
