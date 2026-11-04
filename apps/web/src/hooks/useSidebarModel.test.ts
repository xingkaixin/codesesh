import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import {
  createSessionIdentity,
  type AgentInfo,
  type ApiProjectGroup,
  type SessionHead,
} from "@codesesh/contract";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  ...createSessionIdentity({ agentName: "codex", sessionId: "codex-session" }),
  project_identity: projectIdentity,
} satisfies SessionHead;
const claudeSession = {
  ...SAMPLE_SESSION_HEAD,
  ...createSessionIdentity({ agentName: "claudecode", sessionId: "claude-session" }),
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

afterEach(cleanup);

function renderModel(initialViewState: ViewState = rootView, indexes = sessionIndexes) {
  const isSessionBookmarked = vi.fn((agentKey, sessionId) => {
    return agentKey === "codex" && sessionId === codexSession.reference.sessionId;
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
      ...createSessionIdentity({
        agentName: "claudecode",
        sessionId: codexSession.reference.sessionId,
      }),
    };
    const indexes = buildSessionIndexes([codexSession, sameIdClaude], agents);
    const { result } = renderModel(projectView, indexes);
    const codexReference = getSessionReferenceKey(codexSession);
    const claudeReference = getSessionReferenceKey(sameIdClaude);

    expect(result.current.bookmarkedSidebarSessionReferences).toEqual(new Set([codexReference]));
    expect(result.current.sidebarSessionLookup.byReference.get(codexReference)).toBe(codexSession);
    expect(result.current.sidebarSessionLookup.byReference.get(claudeReference)).toBe(sameIdClaude);
  });
});
