/**
 * Project analytics — pure aggregation over SessionHead[], the project-level
 * counterpart to dashboard.ts. No HTTP, no DB: the caller supplies the groups
 * and the sessions, this module owns the arithmetic.
 *
 * Metrics are inclusive of sub-sessions and `sessionCount` is recomputed from
 * the sessions actually handed in, so a windowed caller gets windowed counts
 * instead of the cache-wide count carried by ProjectGroup.
 */
import type { ProjectGroup, SessionHead } from "../types/index.js";
import type { ApiProjectAgentStat, ApiProjectGroup } from "../contract/index.js";
import { getProjectIdentityKey } from "../contract/project-identity.js";
import { buildSessionTree } from "../contract/session-tree.js";
import { getSessionAgentName } from "./dashboard.js";

interface ProjectMetrics {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  hasEstimatedCost: boolean;
  agentStats: Map<string, ApiProjectAgentStat>;
}

function emptyMetrics(): ProjectMetrics {
  return {
    sessions: 0,
    messages: 0,
    tokens: 0,
    cost: 0,
    hasEstimatedCost: false,
    agentStats: new Map(),
  };
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

  for (const node of buildSessionTree(sessions).entries) {
    const identity = node.session.project_identity;
    if (!identity) continue;

    const key = getProjectIdentityKey(identity);
    let current = metrics.get(key);
    if (!current) {
      current = emptyMetrics();
      metrics.set(key, current);
    }

    const stats = node.inclusiveStats;
    current.sessions += 1;
    current.messages += stats.messageCount;
    current.tokens += stats.totalTokens;
    current.cost += stats.cost;
    if (stats.costSource === "estimated") current.hasEstimatedCost = true;

    const agentName = getSessionAgentName(node.session);
    const agent = current.agentStats.get(agentName);
    if (agent) {
      agent.sessions += 1;
      agent.messages += stats.messageCount;
      agent.tokens += stats.totalTokens;
      agent.cost += stats.cost;
    } else {
      current.agentStats.set(agentName, {
        name: agentName,
        sessions: 1,
        messages: stats.messageCount,
        tokens: stats.totalTokens,
        cost: stats.cost,
      });
    }
  }

  return projects.map((project) => {
    const metric = metrics.get(
      getProjectIdentityKey({ kind: project.identityKind, key: project.identityKey }),
    );
    return {
      ...project,
      sessionCount: metric?.sessions ?? 0,
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
