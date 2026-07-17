import { describe, expect, it } from "vitest";
import type { SearchResult, SessionHead } from "./api";
import type { SearchProjectOption } from "../components/app/types";
import type { SessionIndexes } from "./session-indexes";
import { getProjectIdentityKey } from "./projects";
import { buildLocalRecentResults, buildSearchProjectOptions, usesServerSearch } from "./search";

describe("usesServerSearch", () => {
  it("stays false with no text and only agent/tag/cost filters", () => {
    expect(usesServerSearch("", { agent: "claudecode", tag: "bugfix" })).toBe(false);
  });

  it("becomes true once a tool filter is set, even with no query text", () => {
    expect(usesServerSearch("", { tool: "bash" })).toBe(true);
  });

  it("becomes true once a fileKind filter is set, even with no query text", () => {
    expect(usesServerSearch("", { fileKind: "edit" })).toBe(true);
  });
});

// Characterization: pins the CURRENT local ("recent") search path -- the
// third re-implementation of recent-session filtering, alongside
// packages/cli/src/api/handlers.ts's recentSearchSessions and core's
// searchSessions("", ...) empty-query branch. Not a spec: asserts what this
// function does today.
describe("buildLocalRecentResults", () => {
  const projectApp = {
    kind: "git_remote" as const,
    key: "github.com/acme/app",
    displayName: "app",
  };
  const projectOther = {
    kind: "git_remote" as const,
    key: "github.com/acme/other",
    displayName: "other",
  };

  function makeSession(id: string, overrides: Partial<SessionHead> = {}): SessionHead {
    return {
      id,
      slug: `claudecode/${id}`,
      title: `Session ${id}`,
      directory: `/repo/${id}`,
      time_created: 0,
      time_updated: 0,
      stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
      ...overrides,
    } as SessionHead;
  }

  function buildIndexes(sessions: SessionHead[]): SessionIndexes {
    const byAgent = new Map<string, SessionHead[]>();
    const byProjectIdentityKey = new Map<string, SessionHead[]>();
    for (const session of sessions) {
      const agentKey = session.slug.split("/")[0]!.toLowerCase();
      byAgent.set(agentKey, [...(byAgent.get(agentKey) ?? []), session]);
      if (session.project_identity) {
        const key = getProjectIdentityKey(session.project_identity);
        byProjectIdentityKey.set(key, [...(byProjectIdentityKey.get(key) ?? []), session]);
      }
    }
    return {
      byAgent,
      byProjectIdentityKey,
      projectOptions: [],
      sessionsByActivity: sessions,
    } as unknown as SessionIndexes;
  }

  const sBugfixApp = makeSession("s-bugfix-app", {
    slug: "claudecode/s-bugfix-app",
    smart_tags: ["bugfix"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0.5 },
  });
  const sFeatureApp = makeSession("s-feature-app", {
    slug: "claudecode/s-feature-app",
    smart_tags: ["feature-dev"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 2 },
  });
  const sBugfixOther = makeSession("s-bugfix-other", {
    slug: "codex/s-bugfix-other",
    smart_tags: ["bugfix"],
    project_identity: projectOther,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 5 },
  });

  it("filters by agent + tag, shaping snippets as 'Recent session · <directory>'", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);

    const results = buildLocalRecentResults(
      indexes,
      { agent: "claudecode", tag: "bugfix" },
      undefined,
    );

    expect(results).toEqual([
      {
        agentName: "claudecode",
        session: sBugfixApp,
        snippet: `Recent session · ${sBugfixApp.directory}`,
        matchType: "recent",
      },
    ]);
  });

  it("filters by project identity", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);

    const results = buildLocalRecentResults(
      indexes,
      { project: { kind: projectOther.kind, key: projectOther.key } },
      undefined,
    );

    expect(results.map((r) => r.session.id)).toEqual(["s-bugfix-other"]);
  });

  it("filters by costMin (>= costMin, not strictly greater)", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);

    // one_plus = costMin 1; sBugfixApp (0.5) is excluded, the other two (2, 5) pass.
    const results = buildLocalRecentResults(indexes, {}, 1);

    expect(results.map((r) => r.session.id).sort()).toEqual(
      ["s-feature-app", "s-bugfix-other"].sort(),
    );
  });

  it("caps results at 50", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      makeSession(`s-many-${index}`, {
        slug: `claudecode/s-many-${index}`,
        smart_tags: ["bugfix"],
      }),
    );
    const indexes = buildIndexes(many);

    const results = buildLocalRecentResults(indexes, { tag: "bugfix" }, undefined);

    expect(results).toHaveLength(50);
  });
});

describe("buildSearchProjectOptions", () => {
  const recentProjectOptions: SearchProjectOption[] = [
    {
      key: "git_remote:github.com/acme/app",
      identityKind: "git_remote",
      identityKey: "github.com/acme/app",
      label: "acme/app",
      count: 12,
      showCount: true,
    },
  ];

  function makeResult(id: string, projectKey: string, displayName: string): SearchResult {
    return {
      agentName: "codex",
      snippet: "match",
      matchType: "title",
      session: {
        id,
        slug: `codex/${id}`,
        title: id,
        directory: `/repo/${id}`,
        time_created: 0,
        time_updated: 0,
        stats: {
          message_count: 1,
          total_input_tokens: 0,
          total_output_tokens: 0,
          total_cost: 0,
        },
        project_identity: {
          kind: "git_remote",
          key: projectKey,
          displayName,
        },
      } as SessionHead,
    };
  }

  it("reuses recent project options for local search", () => {
    expect(
      buildSearchProjectOptions({
        usesServerSearch: false,
        isLoading: false,
        results: [],
        selectedProject: undefined,
        recentProjectOptions,
      }),
    ).toBe(recentProjectOptions);
  });

  it("builds and sorts project facets from server results", () => {
    const options = buildSearchProjectOptions({
      usesServerSearch: true,
      isLoading: false,
      results: [
        makeResult("other", "github.com/acme/other", "acme/other"),
        makeResult("app-1", "github.com/acme/app", "acme/app"),
        makeResult("app-2", "github.com/acme/app", "acme/app"),
      ],
      selectedProject: undefined,
      recentProjectOptions,
    });

    expect(options.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: "git_remote:github.com/acme/app", count: 2 },
      { key: "git_remote:github.com/acme/other", count: 1 },
    ]);
  });

  it("retains the selected project while server facets are loading", () => {
    expect(
      buildSearchProjectOptions({
        usesServerSearch: true,
        isLoading: true,
        results: [makeResult("app", "github.com/acme/app", "acme/app")],
        selectedProject: { kind: "git_remote", key: "github.com/acme/app" },
        recentProjectOptions,
      }),
    ).toEqual([{ ...recentProjectOptions[0], count: 0, showCount: false }]);
  });
});
