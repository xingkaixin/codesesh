export type AgentSourceKind = "filesystem" | "sqlite";

export type AgentToolStrategy = "custom" | "default";

export interface AgentCatalogEntry {
  name: string;
  displayName: string;
  icon: string;
  /** Brand-colored icons render as-is instead of inheriting the current text color. */
  iconColored?: boolean;
  sourceKind: AgentSourceKind;
  resumeCommandPrefix: string | null;
  toolStrategy: AgentToolStrategy;
}

export const AGENT_CATALOG = [
  {
    name: "claudecode",
    displayName: "Claude Code",
    icon: "/icon/agent/claudecode.svg",
    iconColored: true,
    sourceKind: "filesystem",
    resumeCommandPrefix: "claude --resume",
    toolStrategy: "custom",
  },
  {
    name: "cursor",
    displayName: "Cursor",
    icon: "/icon/agent/cursor.svg",
    sourceKind: "sqlite",
    resumeCommandPrefix: null,
    toolStrategy: "custom",
  },
  {
    name: "kimi",
    displayName: "Kimi-Cli",
    icon: "/icon/agent/kimi.svg",
    sourceKind: "filesystem",
    resumeCommandPrefix: "kimi -r",
    toolStrategy: "custom",
  },
  {
    name: "kimi-code",
    displayName: "Kimi-Code",
    icon: "/icon/agent/kimi.svg",
    sourceKind: "filesystem",
    resumeCommandPrefix: "kimi -r",
    toolStrategy: "custom",
  },
  {
    name: "codex",
    displayName: "Codex",
    icon: "/icon/agent/codex.svg",
    sourceKind: "filesystem",
    resumeCommandPrefix: "codex resume",
    toolStrategy: "custom",
  },
  {
    name: "grok",
    displayName: "Grok",
    icon: "/icon/agent/grok.svg",
    sourceKind: "filesystem",
    resumeCommandPrefix: "grok --resume",
    toolStrategy: "custom",
  },
  {
    name: "pi",
    displayName: "Pi",
    icon: "/icon/agent/pi.svg",
    sourceKind: "filesystem",
    resumeCommandPrefix: "pi --session",
    toolStrategy: "custom",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    icon: "/icon/agent/opencode.svg",
    sourceKind: "sqlite",
    resumeCommandPrefix: "opencode -s",
    toolStrategy: "custom",
  },
  {
    name: "zcode",
    displayName: "ZCode",
    icon: "/icon/agent/zcode.svg",
    sourceKind: "sqlite",
    resumeCommandPrefix: null,
    toolStrategy: "custom",
  },
  {
    name: "dsh",
    displayName: "DSH",
    icon: "/icon/agent/dsh.svg",
    iconColored: true,
    sourceKind: "filesystem",
    // DSH delegates launch arguments to installation-specific profiles.
    resumeCommandPrefix: null,
    toolStrategy: "custom",
  },
] as const satisfies readonly AgentCatalogEntry[];

export type AgentName = (typeof AGENT_CATALOG)[number]["name"];

export function getAgentCatalogEntry(name: AgentName): AgentCatalogEntry {
  const entry = AGENT_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown agent catalog entry: ${name}`);
  return entry;
}
