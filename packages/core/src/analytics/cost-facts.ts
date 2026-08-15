import type { CostSource, SessionReference } from "../contract/index.js";

export interface MessageCostFact {
  reference: SessionReference;
  time: number;
  model?: string;
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
  messageCost: number;
  untimedMessageCost: number;
  modelCosts: SessionModelCostFact[];
}

export interface DashboardCostFacts {
  messages: MessageCostFact[];
  sessions: SessionCostSummary[];
}
