import { describe, expect, it } from "vitest";
import type { AgentInfo } from "./api";
import { createAgentCatalog, findAgent } from "./agents";

const agents: AgentInfo[] = [
  {
    name: "claudecode",
    displayName: "Claude Code",
    icon: "/icon/agent/claudecode.svg",
    count: 2,
  },
  {
    name: "codex",
    displayName: "Codex",
    icon: "/icon/agent/codex.svg",
    count: 0,
  },
];

describe("agent catalog", () => {
  it("keeps registered identities while deriving active agents", () => {
    const catalog = createAgentCatalog(agents);

    expect(catalog.active).toEqual([agents[0]]);
    expect(findAgent(catalog, "CODEX")).toBe(agents[1]);
    expect(catalog.displayNameByKey.get("claudecode")).toBe("Claude Code");
  });
});
