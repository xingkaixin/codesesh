import { describe, expect, it } from "vitest";
import { SMART_TAGS } from "../../contract/index.js";
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

  it("replaces a prior comparison mode with a later range or exact cost", () => {
    expect(parseSearchQuery("cost:>1 cost:<5 cost:2..3").filters).toEqual({
      costMin: 2,
      costMax: 3,
    });
    expect(parseSearchQuery("cost:>1 cost:<5 cost:2").filters).toEqual({
      costMin: 2,
      costMax: 2,
    });
  });

  it("recognizes every tag in the public catalog", () => {
    const query = SMART_TAGS.map((tag) => `tag:${tag}`).join(" ");

    expect(parseSearchQuery(query)).toEqual({
      text: "",
      filters: { tags: SMART_TAGS },
      hasQualifiers: true,
    });
  });
});
