import { normalizeProjectScopePath } from "../../projects/scope.js";
import type { SessionQueryScope } from "../session-scope.js";

export function buildSessionQueryScopeFilters(scope?: SessionQueryScope): {
  clauses: string[];
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope?.agents?.length) {
    clauses.push(`s.agent_name IN (${scope.agents.map(() => "?").join(", ")})`);
    params.push(...scope.agents);
  }
  if (scope?.projectScope) {
    const project = scope.projectScope;
    const path = normalizeProjectScopePath(project.path);
    const directory = "codesesh_project_scope_path(s.directory)";
    clauses.push(
      `((s.project_identity_kind = ? AND s.project_identity_key = ?) OR (s.directory <> '' AND (${directory} = ? OR instr(${directory}, ? || '/') = 1 OR instr(?, ${directory} || '/') = 1)))`,
    );
    params.push(project.identity.kind, project.identity.key, path, path, path);
  }
  return { clauses, params };
}
