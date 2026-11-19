import { describe, expect, it } from "vitest";
import { createSessionIdentity, type SearchResult, type SessionHead } from "@codesesh/contract";
import type { SearchProjectOption } from "../components/app/types";
import { buildSessionIndexes, getSessionAgentKey, type SessionIndexes } from "./session-indexes";
import { getProjectIdentityKey } from "./projects";
import {
  buildLocalRecentResults,
  buildSearchProjectOptions,
  readSearchUrlState,
  usesServerSearch,
  writeSearchUrlState,
} from "./search";

describe("usesServerSearch", () => {
  it("becomes true once a tool filter is set, even with no query text", () => {
    expect(usesServerSearch("", { tool: "bash" })).toBe(true);
  });

  it("becomes true once a fileKind filter is set, even with no query text", () => {
    expect(usesServerSearch("", { fileKind: "edit" })).toBe(true);
  });
});

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
    const reference = overrides.reference ?? { agentName: "claudecode", sessionId: id };
    return {
      title: `Session ${id}`,
      directory: `/repo/${id}`,
      time_created: 0,
      time_updated: 0,
      stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
      ...overrides,
      ...createSessionIdentity(reference),
    };
  }

  function buildIndexes(sessions: SessionHead[]): SessionIndexes {
    const byAgent = new Map<string, SessionHead[]>();
    const byProjectIdentityKey = new Map<string, SessionHead[]>();
    for (const session of sessions) {
      const agentKey = getSessionAgentKey(session);
      byAgent.set(agentKey, [...(byAgent.get(agentKey) ?? []), session]);
      if (session.project_identity) {
        const key = getProjectIdentityKey(session.project_identity);
        byProjectIdentityKey.set(key, [...(byProjectIdentityKey.get(key) ?? []), session]);
      }
    }
    return {
      ...buildSessionIndexes(sessions, []),
      byAgent,
      byProjectIdentityKey,
      projectOptions: [],
      sessionsByActivity: sessions,
    };
  }

  const sBugfixApp = makeSession("s-bugfix-app", {
    smart_tags: ["bugfix"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0.5 },
  });
  const sFeatureApp = makeSession("s-feature-app", {
    smart_tags: ["feature-dev"],
    project_identity: projectApp,
    stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 2 },
  });
  const sBugfixOther = makeSession("s-bugfix-other", {
    reference: { agentName: "codex", sessionId: "s-bugfix-other" },
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
        reference: {
          agentName: "claudecode",
          sessionId: sBugfixApp.reference.sessionId,
        },
        session: sBugfixApp,
        snippet: `Recent session · ${sBugfixApp.directory}`,
        snippetHighlights: [],
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

    expect(results.map((r) => r.session.reference.sessionId)).toEqual(["s-bugfix-other"]);
  });

  it("filters by costMin (>= costMin, not strictly greater)", () => {
    const indexes = buildIndexes([sBugfixApp, sFeatureApp, sBugfixOther]);

    // one_plus = costMin 1; sBugfixApp (0.5) is excluded, the other two (2, 5) pass.
    const results = buildLocalRecentResults(indexes, {}, 1);

    expect(results.map((r) => r.session.reference.sessionId).sort()).toEqual(
      ["s-feature-app", "s-bugfix-other"].sort(),
    );
  });

  it("includes a parent when descendant cost reaches costMin", () => {
    const parent = makeSession("parent");
    const child = makeSession("child", {
      parent_reference: { agentName: "claudecode", sessionId: parent.reference.sessionId },
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 2,
      },
    });
    const results = buildLocalRecentResults(buildIndexes([parent, child]), {}, 1);

    expect(results.map((result) => result.session.reference.sessionId)).toEqual([
      "parent",
      "child",
    ]);
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
      reference: { agentName: "codex", sessionId: id },
      snippet: "match",
      snippetHighlights: [],
      matchType: "title",
      session: {
        ...createSessionIdentity({ agentName: "codex", sessionId: id }),
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

  it("prefers ProjectGroup displayName and upgrades tail fallbacks in search facets", () => {
    const options = buildSearchProjectOptions({
      usesServerSearch: true,
      isLoading: false,
      results: [
        makeResult("r1", "github.com/xingkaixin/codesesh", "codesesh"),
        makeResult("r2", "github.com/other/repo", "repo"),
        makeResult("r3", "github.com/other/repo", "repo-monorepo"),
      ],
      selectedProject: undefined,
      recentProjectOptions,
      projectDisplayNames: new Map([
        ["git_remote:github.com/xingkaixin/codesesh", "codesesh-monorepo"],
      ]),
    });

    expect(
      options.find((option) => option.identityKey === "github.com/xingkaixin/codesesh")?.label,
    ).toBe("codesesh-monorepo");
    expect(options.find((option) => option.identityKey === "github.com/other/repo")?.label).toBe(
      "repo-monorepo",
    );
  });

  it("preserves project options while loading and when one project is selected", () => {
    const projectOptions: SearchProjectOption[] = [
      {
        key: "git_remote:github.com/acme/app",
        identityKind: "git_remote",
        identityKey: "github.com/acme/app",
        label: "acme/app",
        count: 5,
        showCount: false,
      },
      {
        key: "git_remote:github.com/acme/other",
        identityKind: "git_remote",
        identityKey: "github.com/acme/other",
        label: "acme/other",
        count: 2,
        showCount: false,
      },
    ];

    const loadingOptions = buildSearchProjectOptions({
      usesServerSearch: true,
      isLoading: true,
      results: [],
      selectedProject: undefined,
      recentProjectOptions,
      preservedProjectOptions: projectOptions,
    });
    expect(loadingOptions.map((option) => option.key)).toEqual([
      "git_remote:github.com/acme/app",
      "git_remote:github.com/acme/other",
    ]);

    const filteredOptions = buildSearchProjectOptions({
      usesServerSearch: true,
      isLoading: false,
      results: [makeResult("app-1", "github.com/acme/app", "acme/app")],
      selectedProject: { kind: "git_remote", key: "github.com/acme/app" },
      recentProjectOptions,
      preservedProjectOptions: projectOptions,
    });
    expect(filteredOptions.map((option) => option.key)).toEqual([
      "git_remote:github.com/acme/app",
      "git_remote:github.com/acme/other",
    ]);
  });

  it("falls back to recent project options when loading without a prior server facet set", () => {
    const loadingOptions = buildSearchProjectOptions({
      usesServerSearch: true,
      isLoading: true,
      results: [],
      selectedProject: undefined,
      recentProjectOptions,
    });

    expect(loadingOptions.map((option) => option.key)).toEqual(["git_remote:github.com/acme/app"]);
    expect(loadingOptions[0]?.showCount).toBe(false);
  });
});

describe("search URL state", () => {
  it("round-trips search query and filters while preserving non-search params", () => {
    const base = new URLSearchParams("range=14d");
    const written = writeSearchUrlState(base, {
      active: true,
      query: "  panic handler  ",
      filters: {
        sourceNodeId: "worker-1",
        agent: "codex",
        project: { kind: "git_remote", key: "github.com/acme/app" },
        tag: "bugfix",
        tool: "bash",
        fileKind: "edit",
        costRange: "one_plus",
      },
    });

    expect(written.get("range")).toBe("14d");
    expect(written.get("search")).toBeNull();
    expect(readSearchUrlState(written)).toEqual({
      active: true,
      query: "panic handler",
      filters: {
        sourceNodeId: "worker-1",
        agent: "codex",
        project: { kind: "git_remote", key: "github.com/acme/app" },
        tag: "bugfix",
        tool: "bash",
        fileKind: "edit",
        costRange: "one_plus",
      },
    });

    const cleared = writeSearchUrlState(written, { active: false, query: "", filters: {} });
    expect(cleared.toString()).toBe("range=14d");
    expect(readSearchUrlState(cleared)).toEqual({ active: false, query: "", filters: {} });
  });

  it("uses search=1 for an open empty search and ignores invalid enum params", () => {
    const emptyOpen = writeSearchUrlState(new URLSearchParams(), {
      active: true,
      query: "",
      filters: {},
    });
    expect(emptyOpen.toString()).toBe("search=1");
    expect(readSearchUrlState(emptyOpen)).toEqual({ active: true, query: "", filters: {} });

    const invalid = new URLSearchParams(
      "search=1&tag=not-a-tag&fileKind=rename&cost=free&projectKind=unknown&projectKey=abc",
    );
    expect(readSearchUrlState(invalid)).toEqual({ active: true, query: "", filters: {} });
  });
});
