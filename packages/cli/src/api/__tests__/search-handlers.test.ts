import { describe, expect, it } from "vitest";
import type { SearchResult } from "@codesesh/core/contract";
import type { ScanResultSource } from "../scan-sources.js";
import {
  coreMocks,
  makeAlias,
  makeMockContext,
  makeProjectIdentityResolver,
  makeScanResult,
  makeScanSource,
  makeSession,
} from "./handler-test-fixtures.js";

const { handleGetFileActivity, handleSearchSessions } = await import("../search-handlers.js");

describe("handleSearchSessions", () => {
  it("maps HTTP query params into a query string, SearchOptions, and the scan snapshot, then returns the module's results", () => {
    const scanSource = makeScanSource();
    const sentinelResults = [
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        session: makeSession("s1"),
      },
    ];
    coreMocks.executeSessionSearch.mockReturnValue(sentinelResults);

    const c = makeMockContext({
      query: {
        q: " needle ",
        agent: "ClaudeCode",
        tag: "bugfix",
        limit: "5",
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      },
    });
    handleSearchSessions(c, scanSource);

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({
        agent: "claudecode",
        tags: ["bugfix"],
        limit: 5,
        projectKind: "git_remote",
        projectKey: "github.com/acme/app",
      }),
      scanSource.getSnapshot(),
      { queryScope: undefined },
    );
    expect(c.json).toHaveBeenCalledWith({ results: sentinelResults });
  });

  it("resolves a cwd qualifier before delegating the search", async () => {
    const scanSource = makeScanSource();
    const c = makeMockContext({ query: { q: "cwd:/home/user/project needle" } });
    const resolver = makeProjectIdentityResolver();

    await handleSearchSessions(c, scanSource, {}, resolver);

    expect(resolver.resolve).toHaveBeenCalledWith("/home/user/project", expect.any(AbortSignal));
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "cwd:/home/user/project needle",
      expect.objectContaining({
        projectScope: {
          identity: { kind: "path", key: "/home/user/project" },
          path: "/home/user/project",
        },
      }),
      scanSource.getSnapshot(),
      { queryScope: undefined },
    );
  });

  it("keeps ranked search hits when alias matches fill the limit", () => {
    const rankedSessions = ["ranked-1", "ranked-2", "ranked-3"].map((id) =>
      makeSession(id, { reference: { agentName: "claudecode", sessionId: id } }),
    );
    const aliasSessions = ["alias-1", "alias-2", "alias-3"].map((id, index) =>
      makeSession(id, {
        reference: { agentName: "claudecode", sessionId: id },
        time_updated: 3_000 - index,
      }),
    );
    coreMocks.executeSessionSearch.mockReturnValue(
      rankedSessions.map((session) => ({
        reference: { agentName: "claudecode", sessionId: session.reference.sessionId },
        session,
      })),
    );
    coreMocks.listSessionAliases.mockReturnValue(
      aliasSessions.map((session) =>
        makeAlias(
          "claudecode",
          session.reference.sessionId,
          `Needle ${session.reference.sessionId}`,
        ),
      ),
    );
    const sessions = [...rankedSessions, ...aliasSessions];
    const c = makeMockContext({ query: { q: "needle", limit: "3" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    expect(
      c.json.mock.calls[0]![0].results.map(
        (result: SearchResult) => result.session.reference.sessionId,
      ),
    ).toEqual(["ranked-1", "ranked-2", "alias-1"]);
  });

  it("keeps ranked order and value when an alias hit overlaps", () => {
    const rankedSessions = ["ranked-1", "ranked-2", "ranked-3"].map((id) =>
      makeSession(id, { reference: { agentName: "claudecode", sessionId: id } }),
    );
    const aliasOnly = makeSession("alias-1", {
      reference: { agentName: "claudecode", sessionId: "alias-1" },
      time_updated: 1,
    });
    coreMocks.executeSessionSearch.mockReturnValue(
      rankedSessions.map((session) => ({
        reference: { agentName: "claudecode", sessionId: session.reference.sessionId },
        session,
        snippet: "Ranked match",
        snippetHighlights: [],
        matchType: "assistant_reply" as const,
      })),
    );
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "ranked-2", "Needle overlap"),
      makeAlias("claudecode", "alias-1", "Needle alias"),
    ]);
    const sessions = [...rankedSessions, aliasOnly];
    const c = makeMockContext({ query: { q: "needle", limit: "3" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    const results = c.json.mock.calls[0]![0].results as SearchResult[];
    expect(results.map((result) => result.session.reference.sessionId)).toEqual([
      "ranked-1",
      "ranked-2",
      "alias-1",
    ]);
    expect(results[1]?.matchType).toBe("assistant_reply");
  });

  it("rejects incomplete project identity filters without calling the search module", () => {
    const c = makeMockContext({ query: { q: "", projectKey: "github.com/acme/app" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) }),
      400,
    );
    expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
  });

  it.each(["1.5", "0", "-1", "", "Infinity", "invalid"])(
    "rejects invalid search limit %j before executing search",
    (limit) => {
      const c = makeMockContext({ query: { q: "needle", limit } });

      handleSearchSessions(c, makeScanSource());

      expect(c.json).toHaveBeenCalledWith({ error: "limit must be a positive integer" }, 400);
      expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
    },
  );

  it("caps an oversized integer search limit", () => {
    const c = makeMockContext({ query: { q: "needle", limit: "999999999999999999999" } });

    handleSearchSessions(c, makeScanSource());

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "needle",
      expect.objectContaining({ limit: 100 }),
      expect.anything(),
      { queryScope: undefined },
    );
  });

  it("returns no search results for an unknown agent without executing search", () => {
    const c = makeMockContext({ query: { q: "needle", agent: "nonexistent" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json).toHaveBeenCalledWith({ results: [] });
    expect(coreMocks.executeSessionSearch).not.toHaveBeenCalled();
  });

  it("matches aliases while preserving an agent: qualifier embedded in q, calling the search module only once", () => {
    const cursorSession = makeSession("c1", {
      reference: { agentName: "cursor", sessionId: "c1" },
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
      makeAlias("cursor", "c1", "Custom cache from cursor"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "agent:claudecode custom cache" } });

    handleSearchSessions(
      c,
      makeScanSource({
        sessions: [
          makeSession("s1", {
            reference: { agentName: "claudecode", sessionId: "s1" },
          }),
          cursorSession,
        ],
        byAgent: {
          claudecode: [
            makeSession("s1", {
              reference: { agentName: "claudecode", sessionId: "s1" },
            }),
          ],
          cursor: [cursorSession],
        },
      }),
    );

    expect(coreMocks.executeSessionSearch).toHaveBeenCalledTimes(1);
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "agent:claudecode custom cache",
      expect.anything(),
      expect.anything(),
      { queryScope: undefined },
    );
    const results = c.json.mock.calls[0]![0].results;
    expect(results).toHaveLength(1);
    expect(results[0].session.display_title).toBe("Custom cache title");
    expect(results[0].matchType).toBe("title");
  });

  it("finds alias matches by scanning the alias map, not the full session list", () => {
    const sessions = Array.from({ length: 1001 }, (_, index) =>
      makeSession(`s${index}`, {
        reference: { agentName: "claudecode", sessionId: `s${index}` },
      }),
    );
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "s1000", "Old alias")]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "old alias" } });

    handleSearchSessions(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    // Only one search call regardless of how many sessions exist -- alias
    // matching no longer re-runs executeSessionSearch with limit = session count.
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledTimes(1);
    expect(coreMocks.executeSessionSearch).toHaveBeenCalledWith(
      "old alias",
      expect.objectContaining({ limit: 50 }),
      expect.anything(),
      { queryScope: undefined },
    );
    expect(c.json.mock.calls[0]![0].results[0].session.reference.sessionId).toBe("s1000");
  });

  it("excludes alias hits outside the requested time window", () => {
    const now = Date.now();
    const oldSession = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      time_created: now - 30 * 86400000,
      time_updated: now - 30 * 86400000,
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({
      query: {
        q: "custom cache",
        from: new Date(now - 86400000).toISOString(),
        to: new Date(now).toISOString(),
      },
    });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [oldSession], byAgent: { claudecode: [oldSession] } }),
    );

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("excludes alias hits from an agent other than the requested agent filter", () => {
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({ query: { q: "custom cache", agent: "cursor" } });

    handleSearchSessions(c, makeScanSource());

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("excludes alias hits outside the requested project identity", () => {
    const session = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
    });
    coreMocks.listSessionAliases.mockReturnValue([
      makeAlias("claudecode", "s1", "Custom cache title"),
    ]);
    coreMocks.executeSessionSearch.mockReturnValue([]);
    const c = makeMockContext({
      query: {
        q: "custom cache",
        projectKind: "git_remote",
        projectKey: "github.com/other/app",
      },
    });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [session], byAgent: { claudecode: [session] } }),
    );

    expect(c.json.mock.calls[0]![0].results).toHaveLength(0);
  });

  it("attaches the parent title to a sub-session hit and omits it when the parent is missing", () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    const mounted = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
    });
    const orphan = makeSession("c2", {
      reference: { agentName: "claudecode", sessionId: "c2" },
      parent_reference: { agentName: "claudecode", sessionId: "gone" },
    });
    coreMocks.executeSessionSearch.mockReturnValue([
      { reference: { agentName: "claudecode", sessionId: "c1" }, session: mounted },
      { reference: { agentName: "claudecode", sessionId: "c2" }, session: orphan },
    ]);
    const c = makeMockContext({ query: { q: "needle" } });

    handleSearchSessions(
      c,
      makeScanSource({
        sessions: [parent, mounted, orphan],
        byAgent: { claudecode: [parent, mounted, orphan] },
      }),
    );

    const results = c.json.mock.calls[0]![0].results;
    expect(results[0].parent).toEqual({
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    expect(results[1]).not.toHaveProperty("parent");
  });

  it("uses the parent's alias as its parent-context title", () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      title: "Parent session",
    });
    const child = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
    });
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "p1", "Renamed parent")]);
    coreMocks.executeSessionSearch.mockReturnValue([
      { reference: { agentName: "claudecode", sessionId: "c1" }, session: child },
    ]);
    const c = makeMockContext({ query: { q: "needle" } });

    handleSearchSessions(
      c,
      makeScanSource({ sessions: [parent, child], byAgent: { claudecode: [parent, child] } }),
    );

    expect(c.json.mock.calls[0]![0].results[0].parent.title).toBe("Renamed parent");
  });

  it("reuses one snapshot tree for cost, alias, and parent context", async () => {
    const parent = makeSession("p1", {
      reference: { agentName: "claudecode", sessionId: "p1" },
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    });
    const child = makeSession("c1", {
      reference: { agentName: "claudecode", sessionId: "c1" },
      parent_reference: { agentName: "claudecode", sessionId: "p1" },
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 2,
      },
    });
    const sessions = [parent, child];
    let snapshot = makeScanResult({
      sessions,
      byAgent: { claudecode: sessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "p1", "Needle parent")]);
    coreMocks.executeSessionSearch.mockImplementation((_query, _options, _scanResult, context) => {
      expect((context as { sessionTree?: unknown } | undefined)?.sessionTree).toBeDefined();
      return [{ reference: { agentName: "claudecode", sessionId: "c1" }, session: child }];
    });

    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);
    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);

    expect(coreMocks.buildSessionTree).toHaveBeenCalledTimes(1);
    const searchContext = coreMocks.executeSessionSearch.mock.calls[0]![3] as {
      sessionTree: unknown;
    };
    expect(coreMocks.filterSessionSearchCandidates).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        sessionSnapshot: sessions,
        sessionTree: searchContext.sessionTree,
      }),
    );

    const replacementSessions = [...sessions];
    snapshot = makeScanResult({
      sessions: replacementSessions,
      byAgent: { claudecode: replacementSessions },
    });
    await handleSearchSessions(makeMockContext({ query: { q: "needle cost:>1" } }), source);

    expect(coreMocks.buildSessionTree).toHaveBeenCalledTimes(2);
  });
});

describe("handleGetFileActivity", () => {
  it("projects aliases onto nested sessions", () => {
    const session = makeSession("s1", {
      reference: { agentName: "claudecode", sessionId: "s1" },
      model_usage: { "gpt-5.5": 5 },
      smart_tags_source_updated_at: 2,
    });
    coreMocks.listSessionAliases.mockReturnValue([makeAlias("claudecode", "s1", "Activity alias")]);
    coreMocks.listFileActivity.mockReturnValue([
      {
        reference: { agentName: "claudecode", sessionId: "s1" },
        projectIdentityKey: "path:/tmp",
        path: "src/index.ts",
        kind: "edit",
        count: 1,
        latestTime: 1,
        session,
      },
    ]);
    const c = makeMockContext();

    handleGetFileActivity(c, makeScanSource());

    const responseSession = c.json.mock.calls[0]![0].activity[0].session;
    expect(responseSession.display_title).toBe("Activity alias");
    expect(responseSession).not.toHaveProperty("model_usage");
    expect(responseSession).not.toHaveProperty("smart_tags_source_updated_at");
  });
});
