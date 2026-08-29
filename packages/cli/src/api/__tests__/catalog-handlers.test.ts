import { describe, expect, it } from "vitest";
import { AGENT_CATALOG } from "@codesesh/core/contract";
import type { ScanResultSource } from "../scan-sources.js";
import {
  coreMocks,
  makeMockContext,
  makeScanResult,
  makeScanSource,
  makeSession,
} from "./handler-test-fixtures.js";

const { handleGetAgents, handleGetConfig, handleGetProjects } =
  await import("../catalog-handlers.js");

describe("handleGetAgents", () => {
  it("returns agent info list", () => {
    const c = makeMockContext();
    handleGetAgents(c, makeScanSource());
    const response = c.json.mock.calls[0]![0];
    expect(Array.isArray(response)).toBe(true);
    expect(response.find((agent: { name: string }) => agent.name === "claudecode")).toMatchObject({
      resumeCommandPrefix: "claude --resume",
    });
    expect(response.find((agent: { name: string }) => agent.name === "cursor")).toMatchObject({
      resumeCommandPrefix: null,
    });
  });

  it("keeps the registered catalog while zeroing counts outside the current window", () => {
    const c = makeMockContext();
    const now = Date.now();
    const old = makeSession("old", {
      reference: { agentName: "codex", sessionId: "old" },
      time_created: now - 30 * 86400000,
      time_updated: now - 30 * 86400000,
    });
    const recent = makeSession("recent", {
      reference: { agentName: "claudecode", sessionId: "recent" },
      time_created: now - 86400000,
      time_updated: now - 86400000,
    });
    handleGetAgents(
      c,
      makeScanSource({
        sessions: [old, recent],
        byAgent: { codex: [old], claudecode: [recent] },
      }),
      { from: now - 7 * 86400000 },
    );
    const response = c.json.mock.calls[0]![0];
    expect(response.map((agent: { name: string }) => agent.name)).toEqual(
      AGENT_CATALOG.map(({ name }) => name),
    );
    expect(response.find((agent: { name: string }) => agent.name === "claudecode")?.count).toBe(1);
    expect(response.find((agent: { name: string }) => agent.name === "codex")?.count).toBe(0);
  });

  it("applies default time window to agent counts", () => {
    const c = makeMockContext();
    const from = Date.now() - 7 * 86400000;
    const sessions = [
      makeSession("old", {
        time_created: Date.now() - 30 * 86400000,
        time_updated: Date.now() - 30 * 86400000,
      }),
      makeSession("recent", {
        time_created: Date.now() - 30 * 86400000,
        time_updated: Date.now() - 1 * 86400000,
      }),
    ];
    handleGetAgents(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }), { from });
    const response = c.json.mock.calls[0]![0];
    const claudecode = response.find((a: { name: string }) => a.name === "claudecode");
    expect(claudecode.count).toBe(1);
  });

  it("lets request dates override the default time window", () => {
    const recent = makeSession("recent", { time_updated: 5000 });
    const old = makeSession("old", { time_updated: 1000 });
    const c = makeMockContext({ query: { from: new Date(0).toISOString() } });

    handleGetAgents(
      c,
      makeScanSource({ sessions: [recent, old], byAgent: { claudecode: [recent, old] } }),
      { from: 3000 },
    );

    expect(c.json.mock.calls[0]![0][0].count).toBe(2);
  });

  it("reuses agent counts for the same snapshot and window", () => {
    const source = makeScanSource();
    const first = makeMockContext();
    const second = makeMockContext();

    handleGetAgents(first, source);
    handleGetAgents(second, source);

    expect(second.json.mock.calls[0]![0]).toBe(first.json.mock.calls[0]![0]);
  });
});

describe("handleGetConfig", () => {
  it("echoes window defaults", () => {
    const c = makeMockContext();
    handleGetConfig(c, { from: 1000, to: 2000, days: 7 });
    const response = c.json.mock.calls[0]![0];
    expect(response.window).toEqual({ from: 1000, to: 2000, days: 7 });
  });
});

describe("handleGetProjects", () => {
  it("bounds every response and keeps catalog totals outside the page", () => {
    const sessions = Array.from({ length: 101 }, (_, index) =>
      makeSession(`project-${index}`, {
        time_updated: 1_000 - index,
        project_identity: {
          kind: "path",
          key: `/workspace/${index}`,
          displayName: `project-${index}`,
        },
      }),
    );
    const source = makeScanSource({ sessions, byAgent: { claudecode: sessions } });
    const firstContext = makeMockContext();

    handleGetProjects(firstContext, source);

    const firstPage = firstContext.json.mock.calls[0]![0];
    expect(firstPage.projects).toHaveLength(100);
    expect(firstPage.summary).toMatchObject({ projects: 101, sessions: 101 });
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const secondContext = makeMockContext({ query: { cursor: firstPage.nextCursor } });
    handleGetProjects(secondContext, source);

    expect(secondContext.json.mock.calls[0]![0]).toEqual({
      projects: [expect.objectContaining({ identityKey: "/workspace/100" })],
      summary: expect.objectContaining({ projects: 101, sessions: 101 }),
    });
  });

  it("rejects a project cursor after the scan snapshot changes", () => {
    const initialSessions = [
      makeSession("one", {
        project_identity: { kind: "path", key: "/workspace/one", displayName: "one" },
      }),
      makeSession("two", {
        project_identity: { kind: "path", key: "/workspace/two", displayName: "two" },
      }),
    ];
    let snapshot = makeScanResult({
      sessions: initialSessions,
      byAgent: { claudecode: initialSessions },
    });
    const source: ScanResultSource = { getSnapshot: () => snapshot };
    const firstContext = makeMockContext({ query: { limit: "1" } });
    handleGetProjects(firstContext, source);
    const cursor = firstContext.json.mock.calls[0]![0].nextCursor;

    const updatedSessions = [
      makeSession("new", {
        project_identity: { kind: "path", key: "/workspace/new", displayName: "new" },
      }),
      ...initialSessions,
    ];
    snapshot = makeScanResult({
      sessions: updatedSessions,
      byAgent: { claudecode: updatedSessions },
    });
    const nextContext = makeMockContext({ query: { limit: "1", cursor } });

    handleGetProjects(nextContext, source);

    expect(nextContext.json).toHaveBeenCalledWith(
      { error: "project snapshot changed; restart pagination" },
      409,
    );
  });

  it("looks up one project without expanding the catalog page", () => {
    const sessions = [
      makeSession("one", {
        project_identity: { kind: "path", key: "/workspace/one", displayName: "one" },
      }),
      makeSession("two", {
        project_identity: { kind: "path", key: "/workspace/two", displayName: "two" },
      }),
    ];
    const c = makeMockContext({
      query: { projectKind: "path", projectKey: "/workspace/two" },
    });

    handleGetProjects(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));

    expect(c.json.mock.calls[0]![0]).toEqual({
      projects: [expect.objectContaining({ identityKey: "/workspace/two" })],
      summary: expect.objectContaining({ projects: 1, sessions: 1 }),
    });
  });

  it("rejects invalid project pagination parameters", () => {
    const invalidLimit = makeMockContext({ query: { limit: "many" } });
    handleGetProjects(invalidLimit, makeScanSource());
    expect(invalidLimit.json).toHaveBeenCalledWith(
      { error: "limit must be a positive integer" },
      400,
    );

    const invalidCursor = makeMockContext({ query: { cursor: "not-a-cursor" } });
    handleGetProjects(invalidCursor, makeScanSource());
    expect(invalidCursor.json).toHaveBeenCalledWith(
      { error: "cursor is invalid for this request" },
      400,
    );
  });

  it("reuses project aggregation for the same snapshot and window", () => {
    const source = makeScanSource();

    handleGetProjects(makeMockContext(), source);
    handleGetProjects(makeMockContext(), source);

    expect(coreMocks.attachProjectMetrics).toHaveBeenCalledTimes(1);
  });

  it("retains a recently used aggregation when the cache reaches capacity", () => {
    const source = makeScanSource();
    const queryFor = (day: number) => ({
      from: new Date(0).toISOString(),
      to: new Date((day + 1) * 86400000).toISOString(),
    });

    for (let day = 0; day < 64; day += 1) {
      handleGetProjects(makeMockContext({ query: queryFor(day) }), source);
    }
    handleGetProjects(makeMockContext({ query: queryFor(0) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(64) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(0) }), source);
    handleGetProjects(makeMockContext({ query: queryFor(1) }), source);

    expect(coreMocks.attachProjectMetrics).toHaveBeenCalledTimes(66);
  });

  it("lets request dates override the default time window", () => {
    const old = makeSession("old", {
      time_updated: 1000,
      project_identity: { kind: "path", key: "/old", displayName: "old" },
    });
    const c = makeMockContext({ query: { from: new Date(0).toISOString() } });

    handleGetProjects(c, makeScanSource({ sessions: [old], byAgent: { claudecode: [old] } }), {
      from: 3000,
    });

    expect(c.json.mock.calls[0]![0].projects[0].displayName).toBe("old");
  });

  it("includes a project whose message cost falls inside the window", () => {
    const session = makeSession("long-lived", {
      time_created: 100,
      time_updated: 300,
      project_identity: { kind: "git_remote", key: "repo-a", displayName: "Repo A" },
      stats: {
        message_count: 1,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 2,
        cost_source: "estimated",
      },
    });
    coreMocks.listDashboardCostFacts.mockReturnValue({
      sessions: [
        {
          reference: { agentName: "agent", sessionId: session.reference.sessionId },
          messageCount: 1,
          untimedMessageCount: 0,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          untimedInputTokens: 0,
          untimedOutputTokens: 0,
          untimedReasoningTokens: 0,
          untimedCacheReadTokens: 0,
          untimedCacheCreateTokens: 0,
          messageCost: 2,
          untimedMessageCost: 0,
          modelCosts: [],
        },
      ],
      messages: [
        {
          reference: { agentName: "agent", sessionId: session.reference.sessionId },
          time: 150,
          inputTokens: 10,
          outputTokens: 5,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          cost: 2,
          costSource: "estimated",
        },
      ],
    });
    const c = makeMockContext({
      query: { from: new Date(100).toISOString(), to: new Date(200).toISOString() },
    });

    handleGetProjects(c, makeScanSource({ sessions: [session], byAgent: { agent: [session] } }));

    expect(c.json.mock.calls[0]![0].projects).toEqual([
      expect.objectContaining({
        identityKey: "repo-a",
        sessionCount: 0,
        messages: 1,
        tokens: 15,
        cost: 2,
      }),
    ]);
  });

  it("returns project groups sorted by recent activity", () => {
    const sessions = [
      makeSession("a", {
        reference: { agentName: "claudecode", sessionId: "a" },
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
        time_updated: 100,
        stats: {
          message_count: 2,
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_cost: 0.1,
        },
      }),
      makeSession("b", {
        reference: { agentName: "codex", sessionId: "b" },
        project_identity: { kind: "git_remote", key: "github.com/acme/app", displayName: "app" },
        time_updated: 200,
        stats: {
          message_count: 3,
          total_input_tokens: 1,
          total_output_tokens: 2,
          total_cost: 0.2,
          total_tokens: 20,
          cost_source: "estimated",
        },
      }),
    ];
    const c = makeMockContext();
    handleGetProjects(c, makeScanSource({ sessions, byAgent: { claudecode: sessions } }));
    const response = c.json.mock.calls[0]![0];
    expect(response.projects).toEqual([
      {
        identityKind: "git_remote",
        identityKey: "github.com/acme/app",
        displayName: "app",
        sources: ["claudecode", "codex"],
        sessionCount: 2,
        lastActivity: 200,
        messages: 5,
        tokens: 35,
        cost: 0.30000000000000004,
        cost_source: "estimated",
        agentStats: [
          {
            name: "claudecode",
            sessions: 1,
            messages: 2,
            tokens: 15,
            cost: 0.1,
          },
          {
            name: "codex",
            sessions: 1,
            messages: 3,
            tokens: 20,
            cost: 0.2,
          },
        ],
      },
    ]);
  });
});
