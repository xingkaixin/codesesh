import type { DashboardActiveHours } from "../../contract/dashboard.js";
import type { DashboardScope } from "../../analytics/dashboard.js";
import type { SessionQueryScope } from "../session-scope.js";
import { hasCacheStorage } from "./db.js";
import { withCacheDbReadOnly } from "./connection.js";
import { buildSessionQueryScopeFilters } from "./session-scope.js";

export interface ActiveHoursOptions extends DashboardScope {
  from?: number;
  to: number;
  timeZone: string;
}

export function listDashboardActiveHours(
  options: ActiveHoursOptions,
  queryScope?: SessionQueryScope,
): DashboardActiveHours | null {
  if (!hasCacheStorage()) return null;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const { clauses, params } = buildSessionQueryScopeFilters(queryScope);
  clauses.push(
    "s.publication_id IS NULL",
    "s.parent_agent_name IS NULL AND s.parent_session_id IS NULL",
    "m.role = 'user' AND m.automated = 0 AND m.time_created > 0",
    "m.time_created <= ?",
  );
  params.push(options.to);
  if (options.from != null) {
    clauses.push("m.time_created >= ?");
    params.push(options.from);
  }
  if (options.agent) {
    clauses.push("s.agent_name = ?");
    params.push(options.agent);
  }
  if (options.projectKind != null || options.projectKey != null) {
    clauses.push("s.project_identity_kind = ? AND s.project_identity_key = ?");
    params.push(options.projectKind ?? null, options.projectKey ?? null);
  }
  const read = withCacheDbReadOnly((db) => {
    const counts = Array<number>(84).fill(0);
    const rows = db
      .prepare(`
      SELECT m.time_created FROM messages m
      JOIN sessions s ON s.agent_name = m.agent_name AND s.session_id = m.session_id
      WHERE ${clauses.join(" AND ")}
    `)
      .iterate(...params);
    for (const row of rows) {
      const time = Number(row.time_created);
      if (Number.isNaN(new Date(time).getTime())) continue;
      const parts = formatter.formatToParts(time);
      const weekday = weekdays.indexOf(parts.find((part) => part.type === "weekday")!.value);
      const hour = Number(parts.find((part) => part.type === "hour")!.value);
      counts[weekday * 12 + Math.floor(hour / 2)]! += 1;
    }
    return { timeZone: options.timeZone, counts };
  });
  return read.status === "success" ? read.value : null;
}
