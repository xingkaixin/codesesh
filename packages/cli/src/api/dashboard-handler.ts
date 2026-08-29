import {
  addCalendarDays,
  startOfCalendarDay,
  toPublicReferencedSessionHead,
} from "@codesesh/core/contract";
import { getAgentInfoMap } from "@codesesh/core/runtime/agents";
import {
  buildDashboard,
  type DashboardData,
  type DashboardScope,
} from "@codesesh/core/runtime/analytics";
import { getAnalyticsRevision } from "@codesesh/core/runtime/discovery";
import type { Context } from "hono";
import { resolveTimeWindow } from "../time-window-resolution.js";
import { parseDateWindowRequest } from "./handler-support.js";
import {
  optionalQueryValue,
  parseProjectIdentityFilter,
  type SessionListDefaults,
} from "./query-params.js";
import type { ScanResultSource } from "./scan-sources.js";
import { decorateFileActivity, loadAliasView } from "./session-aliases-view.js";
import {
  getDashboardCostFacts,
  getDashboardStorageAggregation,
  getSnapshotAggregation,
} from "./snapshot-aggregation.js";

export function handleGetDashboard(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const dateWindow = parseDateWindowRequest(c, "dashboard", defaults);
  if (dateWindow.kind === "rejected") return dateWindow.response;
  const { from, to, days } = resolveTimeWindow({
    mode: "dashboard",
    window: dateWindow,
    days: c.req.query("days"),
    defaultDays: defaults.days,
  });
  const scope: DashboardScope = {
    agent: optionalQueryValue(c.req.query("agent"))?.toLowerCase(),
    projectKind: projectIdentity?.kind,
    projectKey: projectIdentity?.key,
  };

  const compare = from == null ? undefined : { from: addCalendarDays(from, -days), to: from - 1 };
  const fixedTo = dateWindow.to;
  const cacheTo = fixedTo ?? startOfCalendarDay(to);
  const analyticsRevision = getAnalyticsRevision();
  const costFacts = getDashboardCostFacts(
    scanSource,
    scanResult.sessions,
    compare?.from ?? from,
    to,
    cacheTo,
    analyticsRevision,
  );
  const aggregate = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    [
      "dashboard",
      scope.agent,
      scope.projectKind,
      scope.projectKey,
      from,
      cacheTo,
      compare?.from,
      compare?.to,
      analyticsRevision,
    ],
    () => {
      const agentInfo = getAgentInfoMap({});
      const agentInfoMap = new Map(agentInfo.map((agent) => [agent.name, agent]));
      return buildDashboard(scanResult.sessions, {
        byAgentNames: Object.keys(scanResult.byAgent),
        scope,
        from,
        to,
        agentInfoMap,
        compare,
        costFacts,
      });
    },
  );

  const storageAggregation = getDashboardStorageAggregation(
    scanSource,
    scanResult.sessions,
    scope,
    from,
    to,
    cacheTo,
    analyticsRevision,
  );
  const data: DashboardData = {
    ...aggregate,
    ...storageAggregation,
    window: { from, to, days, compareFrom: compare?.from, compareTo: compare?.to },
  };

  const aliases = loadAliasView();
  return c.json({
    ...data,
    recentSessions: data.recentSessions.map((item) =>
      toPublicReferencedSessionHead({
        ...item,
        session: aliases.decorate(item.session, item.reference),
      }),
    ),
    recentFileActivities: data.recentFileActivities.map((activity) =>
      toPublicReferencedSessionHead(decorateFileActivity(activity, aliases)),
    ),
  });
}
