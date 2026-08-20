import type { BaseAgent } from "./base.js";
import type { AgentInfo } from "../types/index.js";
import type { AgentCatalogEntry } from "../contract/agent-catalog.js";
import { AGENT_REGISTRATIONS } from "./register.js";

export type { AgentToolStrategy } from "../contract/agent-catalog.js";

export interface AgentRegistration extends AgentCatalogEntry {
  create: () => BaseAgent;
  resolveDataRoot: () => string | null;
}

export type AgentRoots = Readonly<Record<string, string | null>>;

export function createRegisteredAgents(): BaseAgent[] {
  return AGENT_REGISTRATIONS.map((registration) => registration.create());
}

export function getRegisteredAgents(): readonly AgentRegistration[] {
  return AGENT_REGISTRATIONS;
}

export function resolveAgentRoots(): AgentRoots {
  return Object.fromEntries(
    AGENT_REGISTRATIONS.map((registration) => [registration.name, registration.resolveDataRoot()]),
  );
}

export function getAgentInfoMap(sessionsByAgent: Record<string, number>): AgentInfo[] {
  return AGENT_REGISTRATIONS.map((registration) => ({
    name: registration.name,
    displayName: registration.displayName,
    icon: registration.icon,
    iconColored: registration.iconColored,
    resumeCommandPrefix: registration.resumeCommandPrefix,
    count: sessionsByAgent[registration.name] ?? 0,
  }));
}
