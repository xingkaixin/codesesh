import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "./search-query-parser.js";

describe("parseSearchQuery", () => {
  it("parses lightweight structured search qualifiers", () => {
    expect(
      parseSearchQuery(
        'agent:codex project:"code sesh" projectkind:git_remote projectkey:github.com/acme/app tag:feature-dev tool:apply_patch file:"src/App File.tsx" cost:>1 needle',
      ),
    ).toEqual({
      text: "needle",
      filters: {
        agent: "codex",
        project: "code sesh",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
        tags: ["feature-dev"],
        tools: ["apply_patch"],
        file: "src/App File.tsx",
        costMin: 1,
        costMinExclusive: true,
      },
      hasQualifiers: true,
    });
  });
});
