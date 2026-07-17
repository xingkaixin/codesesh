import type { AgentInfo } from "./api";

export interface AgentCatalog {
  active: AgentInfo[];
  byKey: ReadonlyMap<string, AgentInfo>;
  displayNameByKey: ReadonlyMap<string, string>;
}

export function createAgentCatalog(agents: AgentInfo[]): AgentCatalog {
  const byKey = new Map<string, AgentInfo>();
  const displayNameByKey = new Map<string, string>();

  for (const agent of agents) {
    const key = agent.name.toLowerCase();
    byKey.set(key, agent);
    displayNameByKey.set(key, agent.displayName);
  }

  return {
    active: agents.filter((agent) => agent.count > 0),
    byKey,
    displayNameByKey,
  };
}

export function findAgent(catalog: AgentCatalog, name: string): AgentInfo | undefined {
  return catalog.byKey.get(name.toLowerCase());
}
