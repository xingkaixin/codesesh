import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, getAgentCatalogEntry } from "./agent-catalog.js";

describe("agent catalog", () => {
  it("has unique runtime and display identities", () => {
    const catalogSource = new URL(
      "../../../crates/codesesh-core/src/agents/catalog.json",
      import.meta.url,
    );
    expect(AGENT_CATALOG).toEqual(JSON.parse(readFileSync(catalogSource, "utf8")));
    const names = AGENT_CATALOG.map(({ name }) => name);
    const displayNames = AGENT_CATALOG.map(({ displayName }) => displayName);

    expect(AGENT_CATALOG.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(getAgentCatalogEntry("kimi").displayName).toBe("Kimi-Cli");
  });
});
