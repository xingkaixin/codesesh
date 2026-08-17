import { AGENT_CATALOG, type AgentSourceKind } from "./contract/agent-catalog.js";
import { CACHE_SCHEMA_VERSION } from "./discovery/cache/version.js";

export type { AgentSourceKind } from "./contract/agent-catalog.js";

export interface RepositoryAgentFact {
  name: string;
  displayName: string;
  sourceKind: AgentSourceKind;
}

export interface CoreRepositoryFacts {
  cacheSchemaVersion: number;
  agents: RepositoryAgentFact[];
}

export function getCoreRepositoryFacts(): CoreRepositoryFacts {
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    agents: AGENT_CATALOG.map(({ name, displayName, sourceKind }) => ({
      name,
      displayName,
      sourceKind,
    })),
  };
}
