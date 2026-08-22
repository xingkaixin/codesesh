import {
  AGENT_CATALOG,
  type AgentCatalogEntry,
  type AgentName,
} from "../contract/agent-catalog.js";
import type { BaseAgent } from "./base.js";
import { ClaudeCodeAgent, resolveClaudeCodeDataRoot } from "./claudecode.js";
import { OpenCodeAgent, resolveOpenCodeDataRoot } from "./opencode.js";
import { KimiAgent, resolveKimiDataRoot } from "./kimi.js";
import { KimiCodeAgent, resolveKimiCodeDataRoot } from "./kimi-code.js";
import { CodexAgent, resolveCodexDataRoot } from "./codex.js";
import { CursorAgent, resolveCursorDataRoot } from "./cursor.js";
import { PiAgent, resolvePiDataRoot } from "./pi.js";
import { ZCodeAgent, resolveZCodeDataRoot } from "./zcode.js";
import { GrokAgent, resolveGrokDataRoot } from "./grok.js";
import { DshAgent, resolveDshDataRoot } from "./dsh.js";

export interface AgentRegistration extends AgentCatalogEntry {
  create: () => BaseAgent;
  resolveDataRoot: () => string | null;
}

type AgentRuntimeRegistration = Pick<AgentRegistration, "create" | "resolveDataRoot">;

const RUNTIME_REGISTRATIONS = {
  claudecode: {
    create: () => new ClaudeCodeAgent(),
    resolveDataRoot: resolveClaudeCodeDataRoot,
  },
  cursor: {
    create: () => new CursorAgent(),
    resolveDataRoot: resolveCursorDataRoot,
  },
  kimi: {
    create: () => new KimiAgent(),
    resolveDataRoot: resolveKimiDataRoot,
  },
  "kimi-code": {
    create: () => new KimiCodeAgent(),
    resolveDataRoot: resolveKimiCodeDataRoot,
  },
  codex: {
    create: () => new CodexAgent(),
    resolveDataRoot: resolveCodexDataRoot,
  },
  grok: {
    create: () => new GrokAgent(),
    resolveDataRoot: resolveGrokDataRoot,
  },
  pi: {
    create: () => new PiAgent(),
    resolveDataRoot: resolvePiDataRoot,
  },
  opencode: {
    create: () => new OpenCodeAgent(),
    resolveDataRoot: resolveOpenCodeDataRoot,
  },
  zcode: {
    create: () => new ZCodeAgent(),
    resolveDataRoot: resolveZCodeDataRoot,
  },
  dsh: {
    create: () => new DshAgent(),
    resolveDataRoot: resolveDshDataRoot,
  },
} satisfies Record<AgentName, AgentRuntimeRegistration>;

export const AGENT_REGISTRATIONS: readonly AgentRegistration[] = Object.freeze(
  AGENT_CATALOG.map((catalogEntry) => {
    const runtime = RUNTIME_REGISTRATIONS[catalogEntry.name];
    return Object.freeze({
      ...catalogEntry,
      ...runtime,
      create: () => {
        const agent = runtime.create();
        const expectedSource =
          catalogEntry.sourceKind === "filesystem" ? "enumerated" : "aggregate";
        if (agent.sessionSourceAccess.kind !== expectedSource) {
          throw new Error(
            `Agent ${catalogEntry.name} declares ${catalogEntry.sourceKind} storage but provides ${agent.sessionSourceAccess.kind} source access`,
          );
        }
        return agent;
      },
    });
  }),
);
