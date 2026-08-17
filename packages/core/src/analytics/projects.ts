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
import type {
  ApiProjectAgentStat,
  ApiProjectGroup,
  ApiProjectSummary,
  SessionTree,
  SessionTreeNode,
} from "../contract/index.js";
import { getProjectIdentityKey } from "../contract/project-identity.js";
import {
  buildSessionTree,
  filterSessionTreeEntriesByActivityWindow,
} from "../contract/session-tree.js";
import { getSessionAgentName } from "./dashboard.js";
import type { DashboardCostFacts } from "./cost-facts.js";
import { visitAttributedCosts, visitAttributedUsage } from "./cost-attribution.js";

interface ProjectMetrics {
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
  hasEstimatedCost: boolean;
  agentStats: Map<string, ApiProjectAgentStat>;
}

export function summarizeProjects(projects: readonly ApiProjectGroup[]): ApiProjectSummary {
  const summary: ApiProjectSummary = {
    projects: projects.length,
    sessions: 0,
    tokens: 0,
    cost: 0,
    latestActivity: null,
  };

  for (const project of projects) {
    summary.sessions += project.sessionCount;
    summary.tokens += project.tokens;
    summary.cost += project.cost;
    if (project.lastActivity != null) {
      summary.latestActivity =
        summary.latestActivity == null
          ? project.lastActivity
          : Math.max(summary.latestActivity, project.lastActivity);
    }
  }

  return summary;
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
  const tree = buildSessionTree(sessions);
  return attachProjectMetricsToEntries(projects, tree, tree.entries);
}

export function attachProjectMetricsFromTree(
  projects: ProjectGroup[],
  tree: SessionTree,
  from?: number,
  to?: number,
  costFacts?: DashboardCostFacts | null,
): ApiProjectGroup[] {
  return attachProjectMetricsToEntries(
    projects,
    tree,
    filterSessionTreeEntriesByActivityWindow(tree, from, to),
    from,
    to,
    costFacts,
  );
}

function attachProjectMetricsToEntries(
  projects: ProjectGroup[],
  tree: SessionTree,
  entries: SessionTreeNode[],
  from?: number,
  to?: number,
  costFacts?: DashboardCostFacts | null,
): ApiProjectGroup[] {
  const metrics = new Map<string, ProjectMetrics>();

  for (const node of entries) {
    const identity = node.session.project_identity;
    if (!identity) continue;

    const key = getProjectIdentityKey(identity);
    let current = metrics.get(key);
    if (!current) {
      current = emptyMetrics();
      metrics.set(key, current);
    }

    current.sessions += 1;

    const agentName = getSessionAgentName(node.session);
    const agent = current.agentStats.get(agentName);
    if (agent) {
      agent.sessions += 1;
    } else {
      current.agentStats.set(agentName, {
        name: agentName,
        sessions: 1,
        messages: 0,
        tokens: 0,
        cost: 0,
      });
    }
  }

  visitAttributedUsage(
    tree,
    { from, to: to ?? Number.POSITIVE_INFINITY, facts: costFacts },
    ({ entry, messages, totalTokens }) => {
      const identity = entry.session.project_identity;
      if (!identity) return;
      const key = getProjectIdentityKey(identity);
      let current = metrics.get(key);
      if (!current) {
        current = emptyMetrics();
        metrics.set(key, current);
      }
      current.messages += messages;
      current.tokens += totalTokens;

      const agentName = getSessionAgentName(entry.session);
      const agent = current.agentStats.get(agentName);
      if (agent) {
        agent.messages += messages;
        agent.tokens += totalTokens;
      } else {
        current.agentStats.set(agentName, {
          name: agentName,
          sessions: 0,
          messages,
          tokens: totalTokens,
          cost: 0,
        });
      }
    },
  );

  visitAttributedCosts(
    tree,
    { from, to: to ?? Number.POSITIVE_INFINITY, facts: costFacts },
    ({ entry, cost, source }) => {
      const identity = entry.session.project_identity;
      if (!identity) return;
      const key = getProjectIdentityKey(identity);
      let current = metrics.get(key);
      if (!current) {
        current = emptyMetrics();
        metrics.set(key, current);
      }
      current.cost += cost;
      if (source === "estimated") current.hasEstimatedCost = true;

      const agentName = getSessionAgentName(entry.session);
      const agent = current.agentStats.get(agentName);
      if (agent) agent.cost += cost;
      else {
        current.agentStats.set(agentName, {
          name: agentName,
          sessions: 0,
          messages: 0,
          tokens: 0,
          cost,
        });
      }
    },
  );

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
