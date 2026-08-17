import { AGENT_CATALOG, type AgentName } from "../contract/agent-catalog.js";
import { registerAgent, type AgentRegistration } from "./registry.js";
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

for (const catalogEntry of AGENT_CATALOG) {
  registerAgent({ ...catalogEntry, ...RUNTIME_REGISTRATIONS[catalogEntry.name] });
}
