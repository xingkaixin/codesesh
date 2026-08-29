import type { AppConfig } from "@codesesh/core/contract";
import { getAgentInfoMap } from "@codesesh/core/runtime/agents";
import {
  getAnalyticsRevision,
  listCachedProjectGroups,
  listDashboardCostFacts,
} from "@codesesh/core/runtime/discovery";
import { attachProjectMetricsFromTree, summarizeProjects } from "@codesesh/core/runtime/projects";
import type { Context } from "hono";
import { parseDateWindowRequest, reportInvalidQueryParameter } from "./handler-support.js";
import {
  filterSessionsByActivityWindow,
  parseLimit,
  parseProjectIdentityFilter,
  PROJECT_PAGE_LIMIT_POLICY,
  searchParams,
  type SessionListDefaults,
} from "./query-params.js";
import type { ScanResultSource, ScanStatusSource } from "./scan-sources.js";
import { paginateSnapshot } from "./snapshot-pagination.js";
import { getSnapshotAggregation, getSnapshotSessionTree } from "./snapshot-aggregation.js";

export function handleGetConfig(c: Context, defaults: SessionListDefaults) {
  const payload: AppConfig = {
    window: {
      from: defaults.from,
      to: defaults.to,
      days: defaults.days,
    },
  };
  return c.json(payload);
}

export function handleGetScanStatus(c: Context, scanSource: ScanStatusSource) {
  return c.json(scanSource.getScanStatus());
}

export function handleGetAgents(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const window = parseDateWindowRequest(c, "agents", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;
  const agents = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    ["agents", from, to],
    () => {
      const counts = Object.fromEntries(
        Object.entries(scanResult.byAgent).map(([agentName, sessions]) => [
          agentName,
          filterSessionsByActivityWindow(sessions, from, to).length,
        ]),
      );
      return getAgentInfoMap(counts);
    },
  );
  return c.json(agents);
}

export function handleGetProjects(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
) {
  const scanResult = scanSource.getSnapshot();
  const params = searchParams(c);
  const limit = parseLimit(params.get("limit"), PROJECT_PAGE_LIMIT_POLICY);
  if (limit.kind === "invalid") {
    reportInvalidQueryParameter("projects", "limit", "rejected");
    return c.json({ error: limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "projects", defaults);
  if (window.kind === "rejected") return window.response;
  const { from, to } = window;
  const analyticsRevision = getAnalyticsRevision();
  const catalog = getSnapshotAggregation(
    scanSource,
    scanResult.sessions,
    ["projects", from, to, analyticsRevision],
    () => {
      const tree = getSnapshotSessionTree(scanSource, scanResult.sessions);
      const costFacts = listDashboardCostFacts({ from, to, includeModelCosts: false });
      const projects = attachProjectMetricsFromTree(
        listCachedProjectGroups(scanResult.sessions),
        tree,
        from,
        to,
        costFacts,
      ).filter(
        (project) =>
          project.sessionCount > 0 ||
          project.messages > 0 ||
          project.tokens > 0 ||
          project.cost > 0,
      );
      return { projects, summary: summarizeProjects(projects) };
    },
  );
  const projects = projectIdentity
    ? catalog.projects.filter(
        (project) =>
          project.identityKind === projectIdentity.kind &&
          project.identityKey === projectIdentity.key,
      )
    : catalog.projects;
  const page = paginateSnapshot(projects, {
    cursor: params.get("cursor") ?? undefined,
    limit: limit.value,
    query: params,
    snapshotIdentity: scanResult.sessions,
    viewIdentity: catalog.projects,
  });
  if (page.kind === "invalid_cursor") {
    reportInvalidQueryParameter("projects", "cursor", "rejected");
    return c.json({ error: "cursor is invalid for this request" }, 400);
  }
  if (page.kind === "stale_snapshot") {
    return c.json({ error: "project snapshot changed; restart pagination" }, 409);
  }
  return c.json({
    projects: page.items,
    summary: projectIdentity ? summarizeProjects(projects) : catalog.summary,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  });
}
