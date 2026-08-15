import type { CostSource, SessionHead } from "../types/session.js";
import type { SessionTree, SessionTreeNode } from "../contract/index.js";
import { getSessionAgentKey, getSessionRouteKey } from "../contract/index.js";
import type {
  DashboardCostFacts,
  MessageCostFact,
  SessionCostSummary,
  SessionModelCostFact,
} from "./cost-facts.js";

const COST_ABSOLUTE_TOLERANCE = 1e-8;
const COST_RELATIVE_TOLERANCE = 1e-6;

interface CostFactIndex {
  messagesBySession: Map<string, MessageCostFact[]>;
  summariesBySession: Map<string, SessionCostSummary>;
}

export interface AttributedCost {
  entry: SessionTreeNode;
  time: number;
  cost: number;
  source: CostSource;
  modelCosts: SessionModelCostFact[];
}

export interface CostAttributionOptions {
  from?: number;
  to: number;
  facts?: DashboardCostFacts | null;
  matchesEntry?: (session: SessionHead) => boolean;
}

function costFactKey(agentName: string, sessionId: string): string {
  return getSessionRouteKey(agentName, sessionId);
}

function indexCostFacts(facts: DashboardCostFacts | null | undefined): CostFactIndex {
  const messagesBySession = new Map<string, MessageCostFact[]>();
  const summariesBySession = new Map<string, SessionCostSummary>();
  if (!facts) return { messagesBySession, summariesBySession };

  for (const summary of facts.sessions) {
    summariesBySession.set(
      costFactKey(summary.reference.agentName, summary.reference.sessionId),
      summary,
    );
  }
  for (const message of facts.messages) {
    const key = costFactKey(message.reference.agentName, message.reference.sessionId);
    const messages = messagesBySession.get(key);
    if (messages) messages.push(message);
    else messagesBySession.set(key, [message]);
  }
  return { messagesBySession, summariesBySession };
}

function costsReconcile(left: number, right: number): boolean {
  const tolerance = Math.max(
    COST_ABSOLUTE_TOLERANCE,
    Math.max(Math.abs(left), Math.abs(right)) * COST_RELATIVE_TOLERANCE,
  );
  return Math.abs(left - right) <= tolerance;
}

function hasDetailedCost(session: SessionHead, summary: SessionCostSummary | undefined): boolean {
  const totalCost = Math.max(0, session.stats.total_cost);
  return (
    totalCost > 0 &&
    summary != null &&
    summary.untimedMessageCost <= COST_ABSOLUTE_TOLERANCE &&
    costsReconcile(summary.messageCost, totalCost)
  );
}

function isInWindow(time: number, from: number | undefined, to: number): boolean {
  return (from == null || time >= from) && time <= to;
}

function resolvedCostSource(session: SessionHead, source?: CostSource): CostSource {
  return source ?? session.stats.cost_source ?? "recorded";
}

function fallbackModelCosts(
  summary: SessionCostSummary | undefined,
  totalCost: number,
): SessionModelCostFact[] {
  if (!summary) return [];
  const modelTotal = summary.modelCosts.reduce((sum, model) => sum + model.cost, 0);
  return modelTotal > totalCost && !costsReconcile(modelTotal, totalCost) ? [] : summary.modelCosts;
}

export function visitAttributedCosts(
  tree: SessionTree,
  options: CostAttributionOptions,
  visit: (attributed: AttributedCost) => void,
): void {
  const factIndex = indexCostFacts(options.facts);
  const factsAvailable = options.facts != null;

  for (const entry of tree.entries) {
    if (options.matchesEntry && !options.matchesEntry(entry.session)) continue;
    const fallbackTime = entry.session.time_updated ?? entry.session.time_created;
    const pending = [entry];

    while (pending.length > 0) {
      const node = pending.pop()!;
      for (const child of node.children) pending.push(child);

      const session = node.session;
      const totalCost = Math.max(0, session.stats.total_cost);
      if (totalCost <= 0) continue;
      const agentName = getSessionAgentKey(session);
      const key = costFactKey(agentName, session.id);
      const summary = factIndex.summariesBySession.get(key);

      if (factsAvailable && hasDetailedCost(session, summary)) {
        for (const message of factIndex.messagesBySession.get(key) ?? []) {
          if (!isInWindow(message.time, options.from, options.to) || message.cost <= 0) continue;
          const source = resolvedCostSource(session, message.costSource);
          visit({
            entry,
            time: message.time,
            cost: message.cost,
            source,
            modelCosts: message.model
              ? [
                  {
                    model: message.model,
                    cost: message.cost,
                    costRecorded: source === "recorded" ? message.cost : 0,
                  },
                ]
              : [],
          });
        }
        continue;
      }

      if (!isInWindow(fallbackTime, options.from, options.to)) continue;
      visit({
        entry,
        time: fallbackTime,
        cost: totalCost,
        source: resolvedCostSource(session),
        modelCosts: factsAvailable ? fallbackModelCosts(summary, totalCost) : [],
      });
    }
  }
}
