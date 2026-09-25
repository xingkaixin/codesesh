import { AGENT_CATALOG } from "./generated/agent-catalog.js";
import type { WireAgentInfo } from "./generated/WireAgentInfo.js";

export { AGENT_CATALOG } from "./generated/agent-catalog.js";

export type AgentSourceKind = "filesystem" | "sqlite";

export type AgentToolStrategy = "custom" | "default";

export type AgentCatalogEntry = Omit<WireAgentInfo, "count" | "icon"> &
  Required<Pick<WireAgentInfo, "icon">> & {
    sourceKind: AgentSourceKind;
    toolStrategy: AgentToolStrategy;
  };

export type AgentName = (typeof AGENT_CATALOG)[number]["name"];

export function getAgentCatalogEntry(name: AgentName): AgentCatalogEntry {
  const entry = AGENT_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown agent catalog entry: ${name}`);
  return entry;
}
