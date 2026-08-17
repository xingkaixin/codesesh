import type { CostSource, SessionHead } from "../types/session.js";
import type { SessionTree, SessionTreeNode } from "../contract/index.js";
import { getSessionRouteKey } from "../contract/index.js";
import type {
  DashboardCostFacts,
  MessageCostFact,
  SessionCostSummary,
  SessionModelCostFact,
} from "./cost-facts.js";

const COST_ABSOLUTE_TOLERANCE = 1e-8;
const COST_RELATIVE_TOLERANCE = 1e-6;

interface MetricFactIndex {
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

export interface AttributedUsage {
  entry: SessionTreeNode;
  time: number;
  messages: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export type UsageAttributionOptions = CostAttributionOptions;

function costFactKey(agentName: string, sessionId: string): string {
  return getSessionRouteKey(agentName, sessionId);
}

function indexFacts(facts: DashboardCostFacts | null | undefined): MetricFactIndex {
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

function nonNegative(value: number | undefined): number {
  return Math.max(0, Number(value ?? 0));
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

function hasDetailedMessages(
  session: SessionHead,
  summary: SessionCostSummary | undefined,
): boolean {
  return (
    summary != null &&
    summary.untimedMessageCount === 0 &&
    summary.messageCount === nonNegative(session.stats.message_count)
  );
}

// Provider payloads disagree on whether reasoning is already included in output.
function detailedOutputIncludesReasoning(
  session: SessionHead,
  summary: SessionCostSummary | undefined,
): boolean | null {
  if (!summary) return null;
  const stats = session.stats;
  const sessionInput = nonNegative(stats.total_input_tokens);
  const sessionOutput = nonNegative(stats.total_output_tokens);
  const sessionCacheRead = nonNegative(stats.total_cache_read_tokens);
  const sessionCacheCreate = nonNegative(stats.total_cache_create_tokens);
  const sessionTotal = nonNegative(stats.total_tokens ?? sessionInput + sessionOutput);
  const outputIncludesReasoning = summary.outputTokens + summary.reasoningTokens;
  const outputMatches = summary.outputTokens === sessionOutput;
  const outputWithReasoningMatches = outputIncludesReasoning === sessionOutput;
  const effectiveOutput = outputMatches
    ? summary.outputTokens
    : outputWithReasoningMatches
      ? outputIncludesReasoning
      : null;

  if (
    effectiveOutput == null ||
    summary.inputTokens !== sessionInput ||
    summary.cacheReadTokens !== sessionCacheRead ||
    summary.cacheCreateTokens !== sessionCacheCreate ||
    summary.inputTokens + effectiveOutput !== sessionTotal ||
    summary.untimedInputTokens > 0 ||
    summary.untimedOutputTokens > 0 ||
    summary.untimedReasoningTokens > 0 ||
    summary.untimedCacheReadTokens > 0 ||
    summary.untimedCacheCreateTokens > 0
  ) {
    return null;
  }
  return !outputMatches && outputWithReasoningMatches;
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
  const factIndex = indexFacts(options.facts);
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
      const key = costFactKey(session.reference.agentName, session.reference.sessionId);
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

export function visitAttributedUsage(
  tree: SessionTree,
  options: UsageAttributionOptions,
  visit: (attributed: AttributedUsage) => void,
): void {
  const factIndex = indexFacts(options.facts);
  const factsAvailable = options.facts != null;

  for (const entry of tree.entries) {
    if (options.matchesEntry && !options.matchesEntry(entry.session)) continue;
    const fallbackTime = entry.session.time_updated ?? entry.session.time_created;
    const pending = [entry];

    while (pending.length > 0) {
      const node = pending.pop()!;
      for (const child of node.children) pending.push(child);

      const session = node.session;
      const key = costFactKey(session.reference.agentName, session.reference.sessionId);
      const summary = factIndex.summariesBySession.get(key);
      const detailedMessages = factsAvailable && hasDetailedMessages(session, summary);
      const outputIncludesReasoning = factsAvailable
        ? detailedOutputIncludesReasoning(session, summary)
        : null;
      const detailedTokens = outputIncludesReasoning != null;

      if (detailedMessages || detailedTokens) {
        for (const message of factIndex.messagesBySession.get(key) ?? []) {
          if (!isInWindow(message.time, options.from, options.to)) continue;
          const outputTokens = detailedTokens
            ? message.outputTokens + (outputIncludesReasoning ? message.reasoningTokens : 0)
            : 0;
          visit({
            entry,
            time: message.time,
            messages: detailedMessages ? 1 : 0,
            totalTokens: detailedTokens ? message.inputTokens + outputTokens : 0,
            inputTokens: detailedTokens ? message.inputTokens : 0,
            outputTokens,
            cacheReadTokens: detailedTokens ? message.cacheReadTokens : 0,
            cacheCreateTokens: detailedTokens ? message.cacheCreateTokens : 0,
          });
        }
      }

      if (!isInWindow(fallbackTime, options.from, options.to)) continue;
      if (!detailedMessages) {
        visit({
          entry,
          time: fallbackTime,
          messages: nonNegative(session.stats.message_count),
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        });
      }
      if (!detailedTokens) {
        const inputTokens = nonNegative(session.stats.total_input_tokens);
        const outputTokens = nonNegative(session.stats.total_output_tokens);
        visit({
          entry,
          time: fallbackTime,
          messages: 0,
          totalTokens: nonNegative(session.stats.total_tokens ?? inputTokens + outputTokens),
          inputTokens,
          outputTokens,
          cacheReadTokens: nonNegative(session.stats.total_cache_read_tokens),
          cacheCreateTokens: nonNegative(session.stats.total_cache_create_tokens),
        });
      }
    }
  }
}
