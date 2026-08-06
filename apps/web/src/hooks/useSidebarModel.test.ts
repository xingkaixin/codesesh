import { SAMPLE_SESSION_HEAD } from "@codesesh/core/contract";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ApiProjectGroup, SessionHead } from "../lib/api";
import { buildSessionIndexes, getSessionReferenceKey } from "../lib/session-indexes";
import type { ViewState } from "../lib/view-state";
import { useSidebarModel } from "./useSidebarModel";

const projectIdentity = {
  kind: "git_remote" as const,
  key: "github.com/acme/app",
  displayName: "acme/app",
};
const agents = [
  { name: "codex", displayName: "Codex", count: 2 },
  { name: "claudecode", displayName: "Claude Code", count: 1 },
] as AgentInfo[];
const projects = [
  {
    identityKind: projectIdentity.kind,
    identityKey: projectIdentity.key,
    displayName: projectIdentity.displayName,
    sources: ["/repo"],
    sessionCount: 2,
    lastActivity: 2,
    messages: 2,
    tokens: 2,
    cost: 0,
    agentStats: [],
  },
] as ApiProjectGroup[];
const codexSession = {
  ...SAMPLE_SESSION_HEAD,
  id: "codex-session",
  slug: "codex/codex-session",
  project_identity: projectIdentity,
} satisfies SessionHead;
const claudeSession = {
  ...SAMPLE_SESSION_HEAD,
  id: "claude-session",
  slug: "claudecode/claude-session",
  project_identity: projectIdentity,
} satisfies SessionHead;
const sessionIndexes = buildSessionIndexes([codexSession, claudeSession], agents);

const rootView = {
  mode: "root",
  activeAgentKey: null,
  activeSessionId: null,
} satisfies ViewState;
const projectView = {
  mode: "project",
  activeAgentKey: null,
  activeSessionId: null,
  activeProjectKind: projectIdentity.kind,
  activeProjectKey: projectIdentity.key,
} satisfies ViewState;
const sessionView = {
  mode: "session",
  activeAgentKey: "codex",
  activeSessionId: codexSession.id,
} satisfies ViewState;

afterEach(cleanup);

function renderModel(initialViewState: ViewState = rootView, indexes = sessionIndexes) {
  const isSessionBookmarked = vi.fn((agentKey, sessionId) => {
    return agentKey === "codex" && sessionId === codexSession.id;
  });
  return renderHook(
    ({ viewState, selectedProjectAgent }) =>
      useSidebarModel({
        viewState,
        sessionIndexes: indexes,
        session: null,
        agents,
        projects,
        selectedProjectAgent,
        isSessionBookmarked,
      }),
    {
      initialProps: {
        viewState: initialViewState,
        selectedProjectAgent: undefined as string | undefined,
      },
    },
  );
}

describe("useSidebarModel", () => {
  it("resolves the agent behind an agent route without listing its sessions", () => {
    const agentView = {
      mode: "agent",
      activeAgentKey: "codex",
      activeSessionId: null,
    } satisfies ViewState;
    const { result } = renderModel(agentView);

    expect(result.current.activeAgent?.displayName).toBe("Codex");
    expect(result.current.sidebarSessions).toEqual([]);
  });

  it("keeps the opened session's project selected in the sidebar", () => {
    const { result, rerender } = renderModel(projectView);

    rerender({ viewState: sessionView, selectedProjectAgent: undefined });

    expect(result.current.selectedProjectNavigation?.identity).toEqual(projectIdentity);
    expect(result.current.sidebarSessions).toEqual([codexSession, claudeSession]);
  });

  it("filters project sessions by the selected agent", () => {
    const { result, rerender } = renderModel(projectView);

    rerender({ viewState: projectView, selectedProjectAgent: "codex" });

    expect(result.current.sidebarSessions).toEqual([codexSession]);
    const reference = getSessionReferenceKey(codexSession);
    expect(result.current.bookmarkedSidebarSessionReferences).toEqual(new Set([reference]));
    expect(result.current.sidebarSessionLookup.byReference.get(reference)).toBe(codexSession);
  });

  it("keeps bookmark and lookup identity separate across agents with the same session id", () => {
    const sameIdClaude = {
      ...claudeSession,
      id: codexSession.id,
      slug: `claudecode/${codexSession.id}`,
    };
    const indexes = buildSessionIndexes([codexSession, sameIdClaude], agents);
    const { result } = renderModel(projectView, indexes);
    const codexReference = getSessionReferenceKey(codexSession);
    const claudeReference = getSessionReferenceKey(sameIdClaude);

    expect(result.current.bookmarkedSidebarSessionReferences).toEqual(new Set([codexReference]));
    expect(result.current.sidebarSessionLookup.byReference.get(codexReference)).toBe(codexSession);
    expect(result.current.sidebarSessionLookup.byReference.get(claudeReference)).toBe(sameIdClaude);
  });

  it("resolves the active project once for route consumers", () => {
    const { result } = renderModel(projectView);

    expect(result.current.activeProject).toEqual({
      identity: { kind: projectIdentity.kind, key: projectIdentity.key },
      identityKey: "git_remote:github.com/acme/app",
      project: projects[0],
    });
    expect(result.current.activeProjectSessions).toHaveLength(2);
  });
});
