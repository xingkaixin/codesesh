import { describe, expect, it } from "vitest";
import { getCoreRepositoryFacts } from "./repository-facts.js";

describe("repository facts", () => {
  it("derives a complete, unambiguous agent snapshot from the runtime registry", () => {
    const facts = getCoreRepositoryFacts();
    const names = facts.agents.map(({ name }) => name);
    const displayNames = facts.agents.map(({ displayName }) => displayName);

    expect(facts.cacheSchemaVersion).toBeGreaterThan(0);
    expect(facts.agents.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(new Set(facts.agents.map(({ sourceKind }) => sourceKind))).toEqual(
      new Set(["filesystem", "sqlite"]),
    );
  });
});
