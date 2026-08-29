import { getAgentInfoMap } from "@codesesh/core/runtime/agents";
import type { IdentifiedSessionHead } from "@codesesh/core/runtime/discovery";
import {
  createProjectScopeMatcherFromIdentity,
  normalizeProjectDirectory,
  PROJECT_IDENTITY_RESOLVER_REVISION,
  type ProjectScopeMatcher,
} from "@codesesh/core/runtime/projects";
import type { Context } from "hono";
import { appLogger } from "../logging.js";
import {
  ProjectIdentityQueueFullError,
  ProjectIdentityRequestAbortedError,
  type ProjectIdentityResolver,
} from "../project-identity-resolver.js";
import { parseDateWindow, searchParams, type SessionListDefaults } from "./query-params.js";

export const KNOWN_AGENT_NAMES = getAgentInfoMap({}).map((agent) => agent.name);
export const KNOWN_AGENT_NAME_SET = new Set(KNOWN_AGENT_NAMES);

export async function resolveProjectScope(
  cwd: string,
  sessions: readonly IdentifiedSessionHead[],
  resolver: ProjectIdentityResolver | undefined,
  signal: AbortSignal,
): Promise<ProjectScopeMatcher> {
  const normalizedCwd = normalizeProjectDirectory(cwd);
  const matchingSession = sessions.find(
    (session) =>
      normalizeProjectDirectory(session.directory) === normalizedCwd &&
      session.project_identity_resolver_revision === PROJECT_IDENTITY_RESOLVER_REVISION &&
      Boolean(session.project_identity_input_signature),
  );
  if (matchingSession) {
    return createProjectScopeMatcherFromIdentity(cwd, matchingSession.project_identity);
  }
  if (!resolver) throw new Error("Project identity resolver is unavailable");

  const projection = await resolver.resolve(cwd, signal);
  return createProjectScopeMatcherFromIdentity(cwd, projection.identity);
}

export function projectScopeResolutionFailureResponse(
  c: Context,
  endpoint: string,
  error: unknown,
) {
  if (error instanceof ProjectIdentityRequestAbortedError) throw error;
  appLogger.warn("api.project_scope.unavailable", {
    endpoint,
    error: error instanceof Error ? error.message : String(error),
  });
  if (error instanceof ProjectIdentityQueueFullError) {
    return c.json({ error: "Project scope busy; retry later" }, 429);
  }
  return c.json({ error: "Project scope unavailable" }, 503);
}

export function reportInvalidQueryParameter(
  endpoint: string,
  parameter: "agent" | "cursor" | "limit" | "from" | "to",
  validationOutcome: "empty_result" | "rejected",
): void {
  appLogger.warn("api.query_parameter.invalid", {
    endpoint,
    parameter,
    validation_outcome: validationOutcome,
  });
}

export function parseDateWindowRequest(
  c: Context,
  endpoint: string,
  defaults: SessionListDefaults,
) {
  const outcome = parseDateWindow(searchParams(c), defaults);
  if (outcome.kind === "valid") return outcome;

  reportInvalidQueryParameter(endpoint, outcome.parameter, "rejected");
  return {
    kind: "rejected" as const,
    response: c.json({ error: `${outcome.parameter} ${outcome.error}` }, 400),
  };
}
