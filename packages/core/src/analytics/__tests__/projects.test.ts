import { describe, expect, it } from "vitest";
import {
  attachProjectMetrics,
  attachProjectMetricsFromTree,
  summarizeProjects,
} from "../projects.js";
import type { ApiProjectGroup } from "../../contract/index.js";
import type { ProjectGroup, SessionHead } from "../../types/index.js";
import { buildSessionTree } from "../../contract/session-tree.js";
import type { DashboardCostFacts } from "../cost-facts.js";
import { createSessionIdentity } from "../../contract/session-reference.js";

const EMPTY_MESSAGE_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
};

const EMPTY_SESSION_USAGE = {
  messageCount: 0,
  untimedMessageCount: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheCreateTokens: 0,
  untimedInputTokens: 0,
  untimedOutputTokens: 0,
  untimedReasoningTokens: 0,
  untimedCacheReadTokens: 0,
  untimedCacheCreateTokens: 0,
};

function makeSession(id: string, overrides?: Partial<SessionHead>): SessionHead {
  const identity = createSessionIdentity(
    overrides?.reference ?? { agentName: "claudecode", sessionId: id },
  );
  return {
    ...identity,
    title: id,
    directory: "/home/user/project",
    time_created: 1_000_000_000_000,
    time_updated: 1_000_000_000_000,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    project_identity: { kind: "git_remote", key: "repo-a", displayName: "Repo A" },
    ...overrides,
    ...identity,
  };
}

function makeGroup(identityKey: string, overrides?: Partial<ProjectGroup>): ProjectGroup {
  return {
    identityKind: "git_remote",
    identityKey,
    displayName: identityKey,
    sources: ["claudecode"],
    sessionCount: 0,
    lastActivity: null,
    ...overrides,
  };
}

describe("summarizeProjects", () => {
  it("folds catalogs larger than the JavaScript argument limit", () => {
    const project = {
      ...makeGroup("repo-a", { sessionCount: 2, lastActivity: 100 }),
      messages: 3,
      tokens: 5,
      cost: 0.25,
      agentStats: [],
    } satisfies ApiProjectGroup;

    expect(summarizeProjects(Array(200_000).fill(project))).toEqual({
      projects: 200_000,
      sessions: 400_000,
      tokens: 1_000_000,
      cost: 50_000,
      latestActivity: 100,
    });
  });
});

describe("attachProjectMetrics", () => {
  it("sums messages, tokens and cost per project", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a")],
      [
        makeSession("a", {
          stats: {
            message_count: 3,
            total_input_tokens: 100,
            total_output_tokens: 20,
            total_cost: 0.5,
          },
        }),
        makeSession("b", {
          stats: {
            message_count: 2,
            total_input_tokens: 10,
            total_output_tokens: 5,
            total_cost: 0.25,
          },
        }),
      ],
    );

    expect(project).toMatchObject({ messages: 5, tokens: 135, cost: 0.75 });
  });

  it("prefers an explicit total_tokens over the input/output sum", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a")],
      [
        makeSession("a", {
          stats: {
            message_count: 1,
            total_input_tokens: 100,
            total_output_tokens: 20,
            total_tokens: 999,
            total_cost: 0,
          },
        }),
      ],
    );

    expect(project?.tokens).toBe(999);
  });

  it("rolls child rows into the parent without counting them as sessions", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a", { sessionCount: 99 })],
      [
        makeSession("parent", {
          stats: {
            message_count: 1,
            total_input_tokens: 50,
            total_output_tokens: 0,
            total_cost: 0,
          },
        }),
        makeSession("child", {
          parent_reference: { agentName: "claudecode", sessionId: "parent" },
          stats: {
            message_count: 1,
            total_input_tokens: 20,
            total_output_tokens: 0,
            total_cost: 0,
          },
        }),
      ],
    );

    expect(project).toMatchObject({ messages: 2, tokens: 70, sessionCount: 1 });
    expect(project?.agentStats).toEqual([
      { name: "claudecode", sessions: 1, messages: 2, tokens: 70, cost: 0 },
    ]);
  });

  it("reuses a tree when applying a project activity window", () => {
    const parent = makeSession("parent", { time_created: 100, time_updated: 100 });
    const child = makeSession("child", {
      time_created: 1,
      time_updated: 1,
      parent_reference: { agentName: "claudecode", sessionId: "parent" },
    });
    const outside = makeSession("outside", { time_created: 1, time_updated: 1 });

    const [project] = attachProjectMetricsFromTree(
      [makeGroup("repo-a")],
      buildSessionTree([parent, child, outside]),
      90,
      110,
    );

    expect(project).toMatchObject({ sessionCount: 1, messages: 2 });
  });

  it("attributes project cost and usage by message time outside the activity window", () => {
    const session = makeSession("long-lived", {
      time_created: 100,
      time_updated: 300,
      stats: {
        message_count: 1,
        total_input_tokens: 10,
        total_output_tokens: 5,
        total_cost: 2,
        cost_source: "estimated",
      },
    });
    const costFacts: DashboardCostFacts = {
      sessions: [
        {
          ...EMPTY_SESSION_USAGE,
          reference: { agentName: "claudecode", sessionId: session.id },
          messageCount: 1,
          inputTokens: 10,
          outputTokens: 5,
          messageCost: 2,
          untimedMessageCost: 0,
          modelCosts: [],
        },
      ],
      messages: [
        {
          ...EMPTY_MESSAGE_USAGE,
          reference: { agentName: "claudecode", sessionId: session.id },
          time: 150,
          inputTokens: 10,
          outputTokens: 5,
          cost: 2,
          costSource: "estimated",
        },
      ],
    };

    const [project] = attachProjectMetricsFromTree(
      [makeGroup("repo-a")],
      buildSessionTree([session]),
      100,
      200,
      costFacts,
    );

    expect(project).toMatchObject({
      sessionCount: 0,
      messages: 1,
      tokens: 15,
      cost: 2,
      cost_source: "estimated",
    });
    expect(project?.agentStats).toEqual([
      { name: "claudecode", sessions: 0, messages: 1, tokens: 15, cost: 2 },
    ]);
  });

  it("counts an orphaned sub-session as its own session", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a")],
      [
        makeSession("parent"),
        makeSession("orphan", {
          parent_reference: { agentName: "claudecode", sessionId: "missing" },
        }),
      ],
    );

    expect(project).toMatchObject({ sessionCount: 2, messages: 2 });
  });

  it("recomputes sessionCount from the sessions handed in, not the cached group", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a", { sessionCount: 42 })],
      [makeSession("a")],
    );

    expect(project?.sessionCount).toBe(1);
  });

  it("marks the project cost estimated when any session's cost is estimated", () => {
    const recorded = makeSession("a", {
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 1,
        cost_source: "recorded",
      },
    });
    const estimated = makeSession("b", {
      stats: {
        message_count: 1,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 1,
        cost_source: "estimated",
      },
    });

    expect(attachProjectMetrics([makeGroup("repo-a")], [recorded])[0]?.cost_source).toBe(
      "recorded",
    );
    expect(attachProjectMetrics([makeGroup("repo-a")], [recorded, estimated])[0]?.cost_source).toBe(
      "estimated",
    );
  });

  it("leaves cost_source undefined when a project has no cost", () => {
    const [project] = attachProjectMetrics([makeGroup("repo-a")], [makeSession("a")]);
    expect(project?.cost_source).toBeUndefined();
  });

  it("groups per agent and orders them by session count", () => {
    const [project] = attachProjectMetrics(
      [makeGroup("repo-a")],
      [
        makeSession("a", { reference: { agentName: "codex", sessionId: "a" } }),
        makeSession("b"),
        makeSession("c"),
      ],
    );

    expect(project?.agentStats.map((stat) => [stat.name, stat.sessions])).toEqual([
      ["claudecode", 2],
      ["codex", 1],
    ]);
  });

  it("zeroes projects with no matching sessions and ignores sessions with no identity", () => {
    const projects = attachProjectMetrics(
      [makeGroup("repo-a"), makeGroup("repo-b")],
      [makeSession("orphan", { project_identity: undefined })],
    );

    expect(projects.map((project) => project.messages)).toEqual([0, 0]);
    expect(projects.every((project) => project.agentStats.length === 0)).toBe(true);
  });

  it("keys metrics on kind and key together", () => {
    const projects = attachProjectMetrics(
      [makeGroup("shared"), makeGroup("shared", { identityKind: "path" })],
      [
        makeSession("a", {
          project_identity: { kind: "git_remote", key: "shared", displayName: "Shared" },
        }),
        makeSession("b", {
          project_identity: { kind: "path", key: "shared", displayName: "Shared" },
        }),
        makeSession("c", {
          project_identity: { kind: "path", key: "shared", displayName: "Shared" },
        }),
      ],
    );

    expect(projects.map((project) => project.messages)).toEqual([1, 2]);
  });
});
