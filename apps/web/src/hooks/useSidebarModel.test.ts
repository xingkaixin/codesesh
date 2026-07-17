import { SAMPLE_SESSION_HEAD } from "@codesesh/core/contract";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ProjectGroup, SessionHead } from "../lib/api";
import { buildSessionIndexes } from "../lib/session-indexes";
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
] as ProjectGroup[];
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
  activeSessionSlug: null,
} satisfies ViewState;
const projectView = {
  mode: "project",
  activeAgentKey: null,
  activeSessionSlug: null,
  activeProjectKind: projectIdentity.kind,
  activeProjectKey: projectIdentity.key,
} satisfies ViewState;
const sessionView = {
  mode: "session",
  activeAgentKey: "codex",
  activeSessionSlug: codexSession.id,
} satisfies ViewState;

afterEach(cleanup);

function renderModel(initialViewState: ViewState = rootView) {
  const isSessionBookmarked = vi.fn((agentKey, sessionId) => {
    return agentKey === "codex" && sessionId === codexSession.id;
  });
  return renderHook(
    ({ viewState, selectedProjectAgent }) =>
      useSidebarModel({
        viewState,
        sessionIndexes,
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
  it("derives agent navigation from an agent route", () => {
    const agentView = {
      mode: "agent",
      activeAgentKey: "codex",
      activeSessionSlug: null,
    } satisfies ViewState;
    const { result } = renderModel(agentView);

    expect(result.current.browseBy).toBe("agents");
    expect(result.current.activeAgent?.displayName).toBe("Codex");
    expect(result.current.sidebarSessions).toEqual([codexSession]);
  });

  it("preserves project browsing when a project opens a session", async () => {
    const { result, rerender } = renderModel(projectView);
    expect(result.current.browseBy).toBe("projects");
    await waitFor(() => expect(result.current.browseBy).toBe("projects"));

    rerender({ viewState: sessionView, selectedProjectAgent: undefined });

    expect(result.current.browseBy).toBe("projects");
    expect(result.current.selectedProjectNavigation?.identity).toEqual(projectIdentity);
    expect(result.current.sidebarSessions).toEqual([codexSession, claudeSession]);
  });

  it("remembers an explicit browsing choice on ambiguous routes", () => {
    const { result } = renderModel();
    expect(result.current.browseBy).toBe("agents");

    act(() => result.current.selectBrowseBy("projects"));

    expect(result.current.browseBy).toBe("projects");
  });

  it("filters project sessions by the selected agent", async () => {
    const { result, rerender } = renderModel(projectView);
    await waitFor(() => expect(result.current.browseBy).toBe("projects"));

    rerender({ viewState: projectView, selectedProjectAgent: "codex" });

    expect(result.current.sidebarSessions).toEqual([codexSession]);
    expect(result.current.bookmarkedSidebarSessionIds).toEqual(new Set([codexSession.id]));
    expect(result.current.sidebarSessionLookup.byId.get(codexSession.id)).toBe(codexSession);
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
