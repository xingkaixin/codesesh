import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "../../contract/agent-catalog.js";
import "../register.js";
import { getAgentInfoMap, getRegisteredAgents } from "../registry.js";

describe("agent registry", () => {
  it("projects public metadata from the catalog", () => {
    const counts: Record<string, number> = { claudecode: 2, codex: 1 };

    expect(getAgentInfoMap(counts)).toEqual(
      AGENT_CATALOG.map((entry) => ({
        name: entry.name,
        displayName: entry.displayName,
        icon: entry.icon,
        iconColored: "iconColored" in entry ? entry.iconColored : undefined,
        resumeCommandPrefix: entry.resumeCommandPrefix,
        count: counts[entry.name] ?? 0,
      })),
    );
  });

  it("keeps every factory identity aligned with its catalog entry", () => {
    expect(
      getRegisteredAgents().map((registration) => {
        const agent = registration.create();
        return { name: agent.name, displayName: agent.displayName };
      }),
    ).toEqual(AGENT_CATALOG.map(({ name, displayName }) => ({ name, displayName })));
  });

  it("keeps declared source kinds aligned with runtime implementations", () => {
    for (const registration of getRegisteredAgents()) {
      const expectedAccess = registration.sourceKind === "filesystem" ? "enumerated" : "aggregate";
      expect(registration.create().sessionSourceAccess.kind).toBe(expectedAccess);
    }
  });
});
