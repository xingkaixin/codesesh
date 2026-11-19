import { describe, expect, it } from "vitest";
import type { SessionDetail, SessionHead } from "@codesesh/contract";
import { buildRouteHeaderModel } from "./build-route-header-model";

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    reference: { agentName: "codex", sessionId: "child-1" },
    title: "Child session title",
    directory: "/repo",
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_005_000,
    stats: { message_count: 2, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    messages: [],
    ...overrides,
  };
}

function makeParentHead(overrides: Partial<SessionHead> = {}): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: "parent-1" },
    title: "Parent session title",
    directory: "/repo",
    time_created: 1_700_000_000_000,
    time_updated: 1_700_000_001_000,
    stats: { message_count: 5, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    ...overrides,
  };
}

describe("buildRouteHeaderModel", () => {
  it("links a child session header breadcrumb directly to its parent session", () => {
    const child = makeSession({
      parent_reference: { agentName: "codex", sessionId: "parent-1" },
    });
    const model = buildRouteHeaderModel({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "child-1",
      },
      isSearchMode: false,
      searchResultCount: null,
      projectCount: 1,
      activeProject: null,
      activeAgent: {
        name: "codex",
        displayName: "Codex",
        count: 2,
        resumeCommandPrefix: "codex resume",
      },
      sidebarSessionCount: 2,
      session: child,
      parentSession: makeParentHead({ display_title: "Main investigation" }),
      sessionError: null,
      sessionSourceLabel: null,
      selectedProjectIdentity: { kind: "path", key: "/repo" },
      selectedProject: null,
    });

    expect(model.breadcrumbs).toEqual([
      { label: "Dashboard", to: "/" },
      { label: "/repo", to: "/projects/path/%2Frepo", mono: true },
      { label: "Main investigation", to: "/codex/parent-1" },
      { label: "Child session title" },
    ]);
  });

  it("falls back to a Parent session link built from parent_reference when parent metadata is absent", () => {
    const child = makeSession({
      reference: { sourceNodeId: "worker-a", agentName: "codex", sessionId: "child-1" },
      parent_reference: { sourceNodeId: "worker-a", agentName: "codex", sessionId: "parent-1" },
    });
    const model = buildRouteHeaderModel({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "child-1",
        sourceNodeId: "worker-a",
      },
      isSearchMode: false,
      searchResultCount: null,
      projectCount: 1,
      activeProject: null,
      activeAgent: {
        name: "codex",
        displayName: "Codex",
        count: 1,
        resumeCommandPrefix: "codex resume",
      },
      sidebarSessionCount: 1,
      session: child,
      parentSession: null,
      sessionError: null,
      sessionSourceLabel: "Worker A",
      selectedProjectIdentity: null,
      selectedProject: null,
    });

    expect(model.breadcrumbs).toEqual([
      { label: "Dashboard", to: "/" },
      { label: "Codex", to: "/codex" },
      { label: "Parent session", to: "/nodes/worker-a/codex/parent-1" },
      { label: "Child session title" },
    ]);
  });

  it("omits the parent session breadcrumb for root sessions", () => {
    const root = makeSession({
      reference: { agentName: "codex", sessionId: "root-1" },
      title: "Root session",
    });
    const model = buildRouteHeaderModel({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "root-1",
      },
      isSearchMode: false,
      searchResultCount: null,
      projectCount: 1,
      activeProject: null,
      activeAgent: {
        name: "codex",
        displayName: "Codex",
        count: 1,
        resumeCommandPrefix: "codex resume",
      },
      sidebarSessionCount: 1,
      session: root,
      parentSession: null,
      sessionError: null,
      sessionSourceLabel: null,
      selectedProjectIdentity: null,
      selectedProject: null,
    });

    expect(model.breadcrumbs).toEqual([
      { label: "Dashboard", to: "/" },
      { label: "Codex", to: "/codex" },
      { label: "Root session" },
    ]);
  });
});
