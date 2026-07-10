import type { CostSource, ProjectGroup } from "./session.js";

export interface AppConfig {
  window: {
    from?: number;
    to?: number;
    days?: number;
  };
}

export interface ApiProjectAgentStat {
  name: string;
  sessions: number;
  messages: number;
  tokens: number;
  cost: number;
}

export interface ApiProjectGroup extends ProjectGroup {
  messages: number;
  tokens: number;
  cost: number;
  cost_source?: CostSource;
  agentStats: ApiProjectAgentStat[];
}
