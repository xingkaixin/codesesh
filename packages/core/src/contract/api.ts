import type { CostSource, ProjectGroup } from "./session.js";

export const CODESESH_REQUEST_ID_HEADER = "X-CodeSesh-Request-ID";
export const CODESESH_OPERATION_ID_HEADER = "X-CodeSesh-Operation-ID";

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

export interface ApiProjectSummary {
  projects: number;
  sessions: number;
  tokens: number;
  cost: number;
  latestActivity: number | null;
}

export interface ApiProjectPage {
  projects: ApiProjectGroup[];
  summary: ApiProjectSummary;
  nextCursor?: string;
}
