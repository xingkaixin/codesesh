import type { BaseAgent } from "./base.js";
import type { AgentInfo } from "../types/index.js";
import type { AgentCatalogEntry } from "../contract/agent-catalog.js";

export type { AgentToolStrategy } from "../contract/agent-catalog.js";

export interface AgentRegistration extends AgentCatalogEntry {
  create: () => BaseAgent;
  resolveDataRoot: () => string | null;
}

export type AgentRoots = Readonly<Record<string, string | null>>;

let registrations: AgentRegistration[] = [];

export function registerAgent(reg: AgentRegistration): void {
  const create = reg.create;
  registrations.push({
    ...reg,
    create: () => {
      const agent = create();
      const expectedSource = reg.sourceKind === "filesystem" ? "enumerated" : "aggregate";
      if (agent.sessionSourceAccess.kind !== expectedSource) {
        throw new Error(
          `Agent ${reg.name} declares ${reg.sourceKind} storage but provides ${agent.sessionSourceAccess.kind} source access`,
        );
      }
      return agent;
    },
  });
}

export function createRegisteredAgents(): BaseAgent[] {
  return registrations.map((r) => r.create());
}

export function getRegisteredAgents(): readonly AgentRegistration[] {
  return registrations;
}

export function resolveAgentRoots(): AgentRoots {
  return Object.fromEntries(
    registrations.map((registration) => [registration.name, registration.resolveDataRoot()]),
  );
}

export function getAgentInfoMap(sessionsByAgent: Record<string, number>): AgentInfo[] {
  return registrations.map((registration) => ({
    name: registration.name,
    displayName: registration.displayName,
    icon: registration.icon,
    iconColored: registration.iconColored,
    resumeCommandPrefix: registration.resumeCommandPrefix,
    count: sessionsByAgent[registration.name] ?? 0,
  }));
}
