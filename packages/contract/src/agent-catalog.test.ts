import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, getAgentCatalogEntry } from "./agent-catalog.js";

describe("agent catalog", () => {
  it("has unique runtime and display identities", () => {
    const names = AGENT_CATALOG.map(({ name }) => name);
    const displayNames = AGENT_CATALOG.map(({ displayName }) => displayName);

    expect(AGENT_CATALOG.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(getAgentCatalogEntry("kimi").displayName).toBe("Kimi-Cli");
  });
});
