import { toPublicReferencedSessionHead, type SessionTree } from "@codesesh/core/contract";
import {
  getSearchProjectDirectory,
  listFileActivity,
  mergeSearchQueryOptions,
} from "@codesesh/core/runtime/discovery";
import type { ProjectScopeMatcher } from "@codesesh/core/runtime/projects";
import { executeSessionSearch } from "@codesesh/core/runtime/search";
import type { Context } from "hono";
import type { ProjectIdentityResolver } from "../project-identity-resolver.js";
import {
  KNOWN_AGENT_NAMES,
  parseDateWindowRequest,
  projectScopeResolutionFailureResponse,
  reportInvalidQueryParameter,
  resolveProjectScope,
} from "./handler-support.js";
import {
  FILE_ACTIVITY_LIMIT_POLICY,
  optionalQueryValue,
  parseFileActivityKind,
  parseProjectIdentityFilter,
  parseSearchOptions,
  parseSessionQuery,
  SEARCH_LIMIT_POLICY,
  searchParams,
  type SessionListDefaults,
} from "./query-params.js";
import type { ScanResultSource } from "./scan-sources.js";
import { mergeAliasSearchResults, withParentContext } from "./search-result-merge.js";
import {
  decorateFileActivity,
  findAliasSearchResults,
  loadAliasView,
} from "./session-aliases-view.js";
import { getSnapshotSessionTree } from "./snapshot-aggregation.js";

export async function handleSearchSessions(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
) {
  const query = c.req.query("q")?.trim() ?? "";
  const scanResult = scanSource.getSnapshot();
  const sessionQuery = parseSessionQuery(searchParams(c), KNOWN_AGENT_NAMES, SEARCH_LIMIT_POLICY);
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("search", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "search", defaults);
  if (window.kind === "rejected") return window.response;
  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("search", "agent", "empty_result");
    return c.json({ results: [] });
  }
  const searchRequestOptions = parseSearchOptions(
    c,
    window,
    {
      agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
      limit: sessionQuery.limit.value,
    },
    projectIdentity,
  );
  const cwd = getSearchProjectDirectory(query, searchRequestOptions);
  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd) {
    try {
      projectScope = await resolveProjectScope(
        cwd,
        scanResult.sessions,
        resolver,
        c.req.raw.signal,
      );
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "search", error);
    }
  }
  const { cwd: _cwd, ...searchOptions } = searchRequestOptions;
  const resolvedSearchOptions = projectScope ? { ...searchOptions, projectScope } : searchOptions;
  const aliases = loadAliasView();
  let sessionTree: SessionTree | undefined;
  const getSessionTree = () =>
    (sessionTree ??= getSnapshotSessionTree(scanSource, scanResult.sessions));
  const effectiveSearchOptions = mergeSearchQueryOptions(query, resolvedSearchOptions).options;
  const searchContext = {
    queryScope: scanSource.queryScope,
    ...(effectiveSearchOptions.costMin != null || effectiveSearchOptions.costMax != null
      ? { sessionTree: getSessionTree() }
      : {}),
  };
  const searchResults = executeSessionSearch(
    query,
    resolvedSearchOptions,
    scanResult,
    searchContext,
  );
  const results = searchResults.map((result) => ({
    ...result,
    session: aliases.decorate(result.session, result.reference),
  }));
  const aliasResults = findAliasSearchResults(
    query,
    resolvedSearchOptions,
    scanResult,
    aliases,
    searchContext,
  );
  const mergedResults = mergeAliasSearchResults(
    results,
    aliasResults,
    resolvedSearchOptions.limit ?? 50,
  );
  return c.json({
    results: withParentContext(mergedResults, getSessionTree, aliases).map(
      toPublicReferencedSessionHead,
    ),
  });
}

export async function handleGetFileActivity(
  c: Context,
  scanSource: ScanResultSource,
  defaults: SessionListDefaults = {},
  resolver?: ProjectIdentityResolver,
) {
  const sessionQuery = parseSessionQuery(
    searchParams(c),
    KNOWN_AGENT_NAMES,
    FILE_ACTIVITY_LIMIT_POLICY,
  );
  if (sessionQuery.limit.kind === "invalid") {
    reportInvalidQueryParameter("file-activity", "limit", "rejected");
    return c.json({ error: sessionQuery.limit.error }, 400);
  }
  const projectIdentity = parseProjectIdentityFilter(
    c.req.query("projectKind"),
    c.req.query("projectKey"),
  );
  if (projectIdentity === null) {
    return c.json({ error: "projectKind and projectKey must form a valid project identity" }, 400);
  }
  const window = parseDateWindowRequest(c, "file-activity", defaults);
  if (window.kind === "rejected") return window.response;
  if (sessionQuery.agent.kind === "unknown") {
    reportInvalidQueryParameter("file-activity", "agent", "empty_result");
    return c.json({ activity: [] });
  }

  const cwd = optionalQueryValue(c.req.query("cwd"));
  let projectScope: ProjectScopeMatcher | undefined;
  if (cwd) {
    try {
      projectScope = await resolveProjectScope(cwd, [], resolver, c.req.raw.signal);
    } catch (error) {
      return projectScopeResolutionFailureResponse(c, "file-activity", error);
    }
  }

  const aliases = loadAliasView();
  return c.json({
    activity: listFileActivity(
      {
        agent: sessionQuery.agent.kind === "known" ? sessionQuery.agent.agentName : undefined,
        sessionId: optionalQueryValue(c.req.query("sessionId")),
        projectKind: projectIdentity?.kind,
        projectKey: projectIdentity?.key,
        project: optionalQueryValue(c.req.query("project")),
        projectScope,
        path: optionalQueryValue(c.req.query("path")),
        kind: parseFileActivityKind(optionalQueryValue(c.req.query("kind"))),
        from: window.from,
        to: window.to,
        limit: sessionQuery.limit.value,
      },
      scanSource.queryScope,
    ).map((activity) => toPublicReferencedSessionHead(decorateFileActivity(activity, aliases))),
  });
}
