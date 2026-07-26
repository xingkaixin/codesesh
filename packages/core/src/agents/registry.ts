import type { BaseAgent } from "./base.js";
import type { AgentInfo } from "../types/index.js";

export type AgentToolStrategy = "custom" | "default";

export interface AgentRegistration {
  create: () => BaseAgent;
  icon: string;
  /** Icon uses brand colors that work on both themes; render it as-is instead of tinting with currentColor. */
  iconColored?: boolean;
  resolveDataRoot: () => string | null;
  resumeCommandPrefix: string | null;
  toolStrategy: AgentToolStrategy;
}

export type AgentRoots = Readonly<Record<string, string | null>>;

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

export function resolveAgentRoots(): AgentRoots {
  return Object.fromEntries(
    registrations.map((registration) => [
      registration.create().name,
      registration.resolveDataRoot(),
    ]),
  );
}

export function getAgentInfoMap(sessionsByAgent: Record<string, number>): AgentInfo[] {
  return registrations.map((registration) => {
    const agent = registration.create();
    return {
      name: agent.name,
      displayName: agent.displayName,
      icon: registration.icon,
      iconColored: registration.iconColored,
      resumeCommandPrefix: registration.resumeCommandPrefix,
      count: sessionsByAgent[agent.name] ?? 0,
    };
  });
}
