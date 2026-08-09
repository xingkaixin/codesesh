import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ApiProjectGroup, SessionDetail } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { createQueryWrapper } from "../../test/query-wrapper";
import type { LandingSession } from "../DetailLanding";
import { AppRouteContent } from "./AppRouteContent";

vi.mock("../SessionDetail", () => ({
  SessionDetail: ({ session }: { session: SessionDetail }) => (
    <div data-testid="session-detail">{session.id}</div>
  ),
}));

const LAZY_SURFACE_TIMEOUT_MS = 5_000;

const project = {
  identityKind: "git_remote",
  identityKey: "github.com/acme/app",
  displayName: "acme/app",
  sources: ["/repo"],
  sessionCount: 0,
  lastActivity: 0,
  messages: 0,
  tokens: 0,
  cost: 0,
  agentStats: [],
} satisfies ApiProjectGroup;

const routeAgents = [
  {
    name: "claudecode",
    displayName: "Claude Code",
    count: 2,
    resumeCommandPrefix: "claude --resume",
  },
  {
    name: "codex",
    displayName: "Codex",
    count: 1,
    resumeCommandPrefix: "codex resume",
  },
] satisfies AgentInfo[];

function makeProps(): Parameters<typeof AppRouteContent>[0] {
  return {
    loading: false,
    error: null,
    viewState: {
      mode: "root",
      activeAgentKey: null,
      activeSessionId: null,
    },
    detailHighlightQuery: "",
    agents: [],
    agentCatalog: createAgentCatalog([]),
    agentNameMap: new Map(),
    projects: [project],
    landingSessions: [],
    sessionsByAgent: new Map(),
    activeProject: null,
    activeProjectSessions: [],
    // A null window keeps the overview's dashboard query idle, so these
    // assertions never depend on the network.
    overview: {
      window: null,
      rangePreset: "30d",
      onRangeChange: vi.fn(),
      onSelectCustom: vi.fn(),
    },
    sessionDetail: { session: null, loading: false, error: null },
    projectAgentFilter: { onChangeAgent: vi.fn() },
    search: {
      active: false,
      query: "",
      state: { status: "idle" },
      projectOptions: [],
      filters: {},
      onChangeFilters: vi.fn(),
      onClose: vi.fn(),
      onRetry: vi.fn(),
      selectedIndex: 0,
      registerResultRef: vi.fn(),
    },
    bookmarks: {
      isBookmarked: vi.fn(() => false),
      toggleSessionBookmark: vi.fn(),
    },
  };
}

function makeSession(id: string): SessionDetail {
  return {
    reference: { agentName: "claudecode", sessionId: id },
    id,
    slug: `claudecode/${id}`,
    title: `Session ${id}`,
    directory: "/repo",
    time_created: 1,
    stats: {
      message_count: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
    messages: [],
  };
}

function makeLandingSession(agentKey: string, sessionId: string, title: string): LandingSession {
  return {
    id: sessionId,
    sessionId,
    agentKey,
    reference: `${agentKey}/${sessionId}`,
    slug: `${agentKey}/${sessionId}`,
    title,
    directory: "/repo",
    time_created: 1,
    time_updated: 2,
    stats: {
      message_count: 3,
      total_input_tokens: 5,
      total_output_tokens: 8,
      total_cost: 0.1,
    },
  };
}

function addRouteAgents(props: ReturnType<typeof makeProps>): void {
  props.agents = routeAgents;
  props.agentCatalog = createAgentCatalog(routeAgents);
  props.agentNameMap = props.agentCatalog.displayNameByKey;
}

afterEach(cleanup);

function renderContent(props: Parameters<typeof AppRouteContent>[0]) {
  const { Wrapper } = createQueryWrapper();
  return render(
    <Wrapper>
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>
    </Wrapper>,
  );
}

describe("AppRouteContent", () => {
  it("renders the overview on the root route", async () => {
    renderContent(makeProps());

    expect(
      await screen.findByTestId("dashboard", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Filter by agent" })).toBeTruthy();
  });

  // The route surfaces load on demand, so these assertions wait for the chunk.
  // The default 1s query timeout is tight when the suite runs under load.
  it("renders a project from the resolved project model", async () => {
    const props = makeProps();
    const activeProject = {
      ...project,
      agentStats: [{ name: "claudecode", sessions: 1, messages: 2, tokens: 3, cost: 0.1 }],
    } satisfies ApiProjectGroup;
    props.viewState = {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
      activeProjectKind: "git_remote",
      activeProjectKey: project.identityKey,
    };
    props.activeProject = activeProject;

    renderContent(props);

    const heading = await screen.findByRole(
      "heading",
      { name: "acme/app" },
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );

    expect(heading.closest("section")?.textContent).not.toContain("claudecode · 1");
    expect(screen.getByRole("button", { name: "claudecode · 1" })).toBeTruthy();
  });

  it("renders search content from the explicit search contract", async () => {
    const props = makeProps();
    props.search.active = true;

    renderContent(props);

    expect(
      await screen.findByRole(
        "heading",
        { name: "No recent sessions" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();
  });

  it("remounts session-scoped UI when the route changes to another session", async () => {
    const props = makeProps();
    props.viewState = {
      mode: "session",
      activeAgentKey: "claudecode",
      activeSessionId: "session-a",
    };
    props.sessionDetail.session = makeSession("session-a");
    const view = renderContent(props);
    const firstDetail = await screen.findByTestId(
      "session-detail",
      {},
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );

    props.viewState = {
      mode: "session",
      activeAgentKey: "claudecode",
      activeSessionId: "session-b",
    };
    props.sessionDetail.session = makeSession("session-b");
    view.rerender(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("session-detail")).not.toBe(firstDetail);
  });

  it("renders an agent landing with encoded session links and full-reference bookmark actions", () => {
    const props = makeProps();
    addRouteAgents(props);
    const sessionId = "shared/id?x#y%";
    const claudeSession = makeLandingSession("claudecode", sessionId, "Claude opaque session");
    const codexSession = makeLandingSession("codex", sessionId, "Codex twin session");
    props.viewState = {
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionId: null,
    };
    props.sessionsByAgent = new Map([
      ["claudecode", [claudeSession]],
      ["codex", [codexSession]],
    ]);

    renderContent(props);

    expect(screen.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    const sessionLink = screen.getByRole("link", { name: /Claude opaque session/ });
    expect(sessionLink.getAttribute("href")).toBe("/claudecode/shared%2Fid%3Fx%23y%25");
    expect(screen.queryByText("Codex twin session")).toBeNull();
    expect(props.bookmarks.isBookmarked).toHaveBeenCalledWith("claudecode", sessionId);

    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(props.bookmarks.toggleSessionBookmark).toHaveBeenCalledWith(claudeSession, "claudecode");
  });

  it("renders a missing session with agent-scoped recovery links", () => {
    const props = makeProps();
    addRouteAgents(props);
    const attemptedSessionId = "missing/id?#%";
    const recoverySessionId = "recovery/id?#%";
    const claudeSession = makeLandingSession(
      "claudecode",
      recoverySessionId,
      "Claude recovery session",
    );
    const codexSession = makeLandingSession("codex", recoverySessionId, "Codex recovery session");
    props.viewState = {
      mode: "session",
      activeAgentKey: "claudecode",
      activeSessionId: attemptedSessionId,
    };
    props.sessionDetail = { session: null, loading: false, error: "not found" };
    props.sessionsByAgent = new Map([
      ["claudecode", [claudeSession]],
      ["codex", [codexSession]],
    ]);

    renderContent(props);

    expect(screen.getByRole("heading", { name: "This session isn't in the index." })).toBeTruthy();
    expect(screen.getByText(attemptedSessionId)).toBeTruthy();
    const recoveryLink = screen.getByRole("link", { name: /Claude recovery session/ });
    expect(recoveryLink.getAttribute("href")).toBe("/claudecode/recovery%2Fid%3F%23%25");
    expect(screen.queryByText("Codex recovery session")).toBeNull();
    expect(props.bookmarks.isBookmarked).toHaveBeenCalledWith("claudecode", recoverySessionId);

    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(props.bookmarks.toggleSessionBookmark).toHaveBeenCalledWith(claudeSession, "claudecode");
  });

  it("renders a missing agent with diagnostics and canonical recovery links", () => {
    const props = makeProps();
    addRouteAgents(props);
    props.viewState = {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionId: null,
      attemptedKey: "ghost-agent",
    };

    renderContent(props);

    expect(screen.getByRole("heading", { name: "This agent isn't on the roster." })).toBeTruthy();
    expect(screen.getByText("ghost-agent")).toBeTruthy();
    expect(screen.getByText("/ghost-agent")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Claude Code/ }).getAttribute("href")).toBe(
      "/claudecode",
    );
    expect(screen.getByRole("link", { name: /Codex/ }).getAttribute("href")).toBe("/codex");
    expect(screen.queryByRole("button", { name: /bookmark/i })).toBeNull();
  });
});
