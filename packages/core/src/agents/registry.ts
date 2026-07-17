import type { BaseAgent } from "./base.js";
import type { AgentInfo } from "../types/index.js";

export interface AgentRegistration {
  create: () => BaseAgent;
  icon: string;
}

let registrations: AgentRegistration[] = [];

export function registerAgent(reg: AgentRegistration): void {
  registrations.push(reg);
}

export function createRegisteredAgents(): BaseAgent[] {
  return registrations.map((r) => r.create());
}

export function getRegisteredAgents(): readonly AgentRegistration[] {
  return registrations;
}

export function getAgentInfoMap(sessionsByAgent: Record<string, number>): AgentInfo[] {
  return registrations.map((registration) => {
    const agent = registration.create();
    return {
      name: agent.name,
      displayName: agent.displayName,
      icon: registration.icon,
      count: sessionsByAgent[agent.name] ?? 0,
    };
  });
}

export function getAgentByName(name: string): AgentRegistration | undefined {
  return registrations.find((registration) => registration.create().name === name);
}
