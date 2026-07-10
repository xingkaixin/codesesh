export type { AgentInfo } from "../contract/agent.js";

export interface FilterOptions {
  agent?: string;
  cwd?: string;
  from?: number;
  to?: number;
  q?: string;
}
