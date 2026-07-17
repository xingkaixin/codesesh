import { describe, expect, it } from "vitest";
import "../register.js";
import { getAgentInfoMap } from "../registry.js";

describe("agent registry", () => {
  it("derives public agent metadata from registered agent instances", () => {
    expect(getAgentInfoMap({ claudecode: 2, codex: 1 })).toEqual([
      {
        name: "claudecode",
        displayName: "Claude Code",
        icon: "/icon/agent/claudecode.svg",
        count: 2,
      },
      {
        name: "opencode",
        displayName: "OpenCode",
        icon: "/icon/agent/opencode.svg",
        count: 0,
      },
      {
        name: "zcode",
        displayName: "ZCode",
        icon: "/icon/agent/zcode.svg",
        count: 0,
      },
      {
        name: "kimi",
        displayName: "Kimi-Cli",
        icon: "/icon/agent/kimi.svg",
        count: 0,
      },
      {
        name: "codex",
        displayName: "Codex",
        icon: "/icon/agent/codex.svg",
        count: 1,
      },
      {
        name: "pi",
        displayName: "Pi",
        icon: "/icon/agent/pi.svg",
        count: 0,
      },
      {
        name: "cursor",
        displayName: "Cursor",
        icon: "/icon/agent/cursor.svg",
        count: 0,
      },
    ]);
  });
});
