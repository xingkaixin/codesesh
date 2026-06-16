export const ModelConfig = {
  agents: {
    opencode: {
      name: "OpenCode",
      icon: "/icon/agent/opencode.svg",
    },
    codex: {
      name: "Codex",
      icon: "/icon/agent/codex.svg",
    },
    pi: {
      name: "Pi",
      icon: "/icon/agent/pi.svg",
    },
    cursor: {
      name: "Cursor",
      icon: "/icon/agent/cursor.svg",
    },
    kimi: {
      name: "Kimi-Cli",
      icon: "/icon/agent/kimi.svg",
    },
    claudecode: {
      name: "Claude Code",
      icon: "/icon/agent/claudecode.svg",
    },
    kilo: {
      name: "Kilo Code",
      icon: "/icon/agent/kilocode.svg",
    },
    antigravity: {
      name: "Antigravity",
      icon: "/icon/agent/antigravity.svg",
    },
  } as Record<string, { name: string; icon: string }>,

  getDefaultAgentKey() {
    const keys = Object.keys(this.agents);
    return keys.length > 0 ? keys[0] : null;
  },

  getAgentName(agentName: string) {
    let agent = this.agents[agentName];
    if (!agent) {
      agent = this.agents[agentName.toLowerCase()];
    }
    return agent ? agent.name : agentName;
  },
};
