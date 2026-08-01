/**
 * Project analytics — pure aggregation over SessionHead[], the project-level
 * counterpart to dashboard.ts. No HTTP, no DB: the caller supplies the groups
 * and the sessions, this module owns the arithmetic.
 */
import type { ProjectGroup, SessionHead } from "../types/index.js";
import type { ApiProjectAgentStat, ApiProjectGroup } from "../contract/index.js";
import { getProjectIdentityKey } from "../contract/project-identity.js";
import { isChildSession } from "../contract/session-tree.js";
import { getSessionAgentName, getTotalTokens } from "./dashboard.js";

interface ProjectMetrics {
  messages: number;
  tokens: number;
  cost: number;
  hasEstimatedCost: boolean;
  agentStats: Map<string, ApiProjectAgentStat>;
}

function emptyMetrics(): ProjectMetrics {
  return { messages: 0, tokens: 0, cost: 0, hasEstimatedCost: false, agentStats: new Map() };
}

/**
 * Fold per-session totals into the project groups they belong to. Sessions with
 * no resolved project identity contribute to nothing.
 */
export function attachProjectMetrics(
  projects: ProjectGroup[],
  sessions: SessionHead[],
): ApiProjectGroup[] {
  const metrics = new Map<string, ProjectMetrics>();

  for (const session of sessions) {
    if (isChildSession(session)) continue;
    const identity = session.project_identity;
    if (!identity) continue;

    const key = getProjectIdentityKey(identity);
    let current = metrics.get(key);
    if (!current) {
      current = emptyMetrics();
      metrics.set(key, current);
    }

    const tokens = getTotalTokens(session.stats);
    const cost = session.stats.total_cost ?? 0;
    current.messages += session.stats.message_count;
    current.tokens += tokens;
    current.cost += cost;
    if (session.stats.cost_source === "estimated") current.hasEstimatedCost = true;

    const agentName = getSessionAgentName(session);
    const agent = current.agentStats.get(agentName);
    if (agent) {
      agent.sessions += 1;
      agent.messages += session.stats.message_count;
      agent.tokens += tokens;
      agent.cost += cost;
    } else {
      current.agentStats.set(agentName, {
        name: agentName,
        sessions: 1,
        messages: session.stats.message_count,
        tokens,
        cost,
      });
    }
  }

  return projects.map((project) => {
    const metric = metrics.get(
      getProjectIdentityKey({ kind: project.identityKind, key: project.identityKey }),
    );
    return {
      ...project,
      messages: metric?.messages ?? 0,
      tokens: metric?.tokens ?? 0,
      cost: metric?.cost ?? 0,
      cost_source:
        metric && metric.cost > 0
          ? metric.hasEstimatedCost
            ? "estimated"
            : "recorded"
          : undefined,
      agentStats: [...(metric?.agentStats.values() ?? [])].sort((a, b) => b.sessions - a.sessions),
    };
  });
}
