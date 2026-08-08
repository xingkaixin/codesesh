import "./agents/register.js";
import { DatabaseSessionSource, FileSystemSessionSource, type BaseAgent } from "./agents/base.js";
import { createRegisteredAgents } from "./agents/registry.js";
import { CACHE_SCHEMA_VERSION } from "./discovery/cache/version.js";

export type AgentSourceKind = "filesystem" | "sqlite";

export interface RepositoryAgentFact {
  name: string;
  displayName: string;
  sourceKind: AgentSourceKind;
}

export interface CoreRepositoryFacts {
  cacheSchemaVersion: number;
  agents: RepositoryAgentFact[];
}

function getAgentSourceKind(agent: BaseAgent): AgentSourceKind {
  if (agent instanceof DatabaseSessionSource) return "sqlite";
  if (agent instanceof FileSystemSessionSource) return "filesystem";
  throw new Error(`Registered agent ${agent.name} has no documented source kind`);
}

export function getCoreRepositoryFacts(): CoreRepositoryFacts {
  return {
    cacheSchemaVersion: CACHE_SCHEMA_VERSION,
    agents: createRegisteredAgents().map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      sourceKind: getAgentSourceKind(agent),
    })),
  };
}
