import type { CostSource, SessionReference } from "../contract/index.js";

export interface MessageCostFact {
  reference: SessionReference;
  time: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  cost: number;
  costSource?: CostSource;
}

export interface SessionModelCostFact {
  model: string;
  cost: number;
  costRecorded: number;
}

export interface SessionCostSummary {
  reference: SessionReference;
  messageCount: number;
  untimedMessageCount: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  untimedInputTokens: number;
  untimedOutputTokens: number;
  untimedReasoningTokens: number;
  untimedCacheReadTokens: number;
  untimedCacheCreateTokens: number;
  messageCost: number;
  untimedMessageCost: number;
  modelCosts: SessionModelCostFact[];
}

export interface DashboardCostFacts {
  messages: MessageCostFact[];
  sessions: SessionCostSummary[];
}
