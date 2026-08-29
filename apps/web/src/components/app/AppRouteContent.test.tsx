import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo, ApiProjectGroup, SessionDetail } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { getSessionRouteKey, type IndexedSession } from "../../lib/session-indexes";
import { createQueryWrapper } from "../../test/query-wrapper";
import { AppRouteContent, type AppRouteModel } from "./AppRouteContent";

const sessionDetailRender = vi.hoisted(() => vi.fn());

vi.mock("../SessionDetail", () => ({
  SessionDetail: (props: { session: SessionDetail; childSessions: SessionDetail[] }) => {
    sessionDetailRender(props);
    return <div data-testid="session-detail">{props.session.reference.sessionId}</div>;
  },
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
  const agentCatalog = createAgentCatalog([]);
  return {
    load: { loading: false, error: null, retry: vi.fn() },
    route: {
      mode: "root",
      activeAgentKey: null,
      activeSessionId: null,
      agentCatalog,
      projectCount: 1,
      overview: makeOverview(),
    },
    search: {
      active: false,
      query: "",
      state: { status: "idle" },
      agentNameMap: agentCatalog.displayNameByKey,
      agents: [],
      projectOptions: [],
      filters: {},
      onChangeFilters: vi.fn(),
      onClose: vi.fn(),
      onRetry: vi.fn(),
      selectedIndex: 0,
      registerResultRef: vi.fn(),
    },
  };
}

function makeOverview() {
  return {
    window: null,
    rangePreset: "30d" as const,
    onRangeChange: vi.fn(),
    onSelectCustom: vi.fn(),
  };
}

function makeProjectPage(projects = [project]) {
  return {
    projects,
    summary: {
      projects: projects.length,
      sessions: 0,
      tokens: 0,
      cost: 0,
      latestActivity: null,
    },
  };
}

function makeBookmarks() {
  return {
    isBookmarked: vi.fn(() => false),
    toggleSessionBookmark: vi.fn(),
  };
}

function makeSessionRoute(
  activeSessionId: string,
  detail: Extract<AppRouteModel, { mode: "session" }>["detail"],
  sessions: IndexedSession[] = [],
): Extract<AppRouteModel, { mode: "session" }> {
  return {
    mode: "session",
    activeAgentKey: "claudecode",
    activeSessionId,
    agents: routeAgents,
    agentCatalog: createAgentCatalog(routeAgents),
    sessions,
    bookmarks: makeBookmarks(),
    detail,
    detailHighlightQuery: "",
    childSessionsByParentRouteKey: new Map(),
  };
}

function makeSession(id: string): SessionDetail {
  return {
    reference: { agentName: "claudecode", sessionId: id },
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

function makeLandingSession(agentKey: string, sessionId: string, title: string): IndexedSession {
  return {
    reference: { agentName: agentKey, sessionId },
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

afterEach(() => {
  cleanup();
  sessionDetailRender.mockClear();
});

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
  it("offers a retry action when the initial load fails", () => {
    const props = makeProps();
    props.load.error = "Failed to load configuration.";

    renderContent(props);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(screen.getByRole("alert").textContent).toContain(props.load.error);
    expect(props.load.retry).toHaveBeenCalledTimes(1);
  });

  it("renders the overview on the root route", async () => {
    renderContent(makeProps());

    expect(
      await screen.findByTestId("dashboard", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS }),
    ).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Filter by agent" })).toBeTruthy();
  });

  it("shows a retryable project failure instead of an empty state", async () => {
    const props = makeProps();
    const retry = vi.fn();
    props.route = {
      mode: "projects",
      activeAgentKey: null,
      activeSessionId: null,
      agentCatalog: createAgentCatalog([]),
      projectPage: makeProjectPage([]),
      projectsLoad: {
        loading: false,
        error: "projects unavailable",
        retry,
      },
      window: null,
    };
    renderContent(props);

    const alert = await screen.findByRole("alert", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS });
    expect(alert.textContent).toContain("Couldn't load projects.");
    expect(alert.textContent).toContain("projects unavailable");
    expect(screen.queryByText("No projects found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  // The route surfaces load on demand, so these assertions wait for the chunk.
  // The default 1s query timeout is tight when the suite runs under load.
  it("renders a project from the resolved project model", async () => {
    const props = makeProps();
    const activeProject = {
      ...project,
      agentStats: [{ name: "claudecode", sessions: 1, messages: 2, tokens: 3, cost: 0.1 }],
    } satisfies ApiProjectGroup;
    props.route = {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
      activeProjectKind: "git_remote",
      activeProjectKey: project.identityKey,
      agentCatalog: createAgentCatalog([]),
      project: activeProject,
      projectLoad: { loading: false, error: null, retry: vi.fn() },
      sessions: [],
      agentFilter: { onChangeAgent: vi.fn() },
      overview: makeOverview(),
    };

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
    props.route = makeSessionRoute("session-a", {
      session: makeSession("session-a"),
      loading: false,
      error: null,
      retry: vi.fn(),
    });
    const view = render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );
    const firstDetail = await screen.findByTestId(
      "session-detail",
      {},
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );

    props.route = makeSessionRoute("session-b", {
      session: makeSession("session-b"),
      loading: false,
      error: null,
      retry: vi.fn(),
    });
    view.rerender(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("session-detail")).not.toBe(firstDetail);
  });

  it("keeps child session identity stable across unrelated detail rerenders", async () => {
    const props = makeProps();
    const parent = makeSession("parent");
    const child = {
      ...makeSession("child"),
      parent_reference: parent.reference,
    };
    const route = makeSessionRoute(parent.reference.sessionId, {
      session: parent,
      loading: false,
      error: null,
      retry: vi.fn(),
    });
    route.childSessionsByParentRouteKey = new Map([
      [getSessionRouteKey("claudecode", "parent"), [child]],
    ]);
    props.route = route;
    const view = render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );
    await screen.findByTestId("session-detail", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS });
    const firstChildren = sessionDetailRender.mock.calls.at(-1)?.[0].childSessions;

    route.detailHighlightQuery = "unrelated";
    view.rerender(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(sessionDetailRender.mock.calls.at(-1)?.[0].childSessions).toBe(firstChildren);
  });

  it("renders an agent landing with encoded session links and full-reference bookmark actions", () => {
    const props = makeProps();
    const bookmarks = makeBookmarks();
    const sessionId = "shared/id?x#y%";
    const claudeSession = makeLandingSession("claudecode", sessionId, "Claude opaque session");
    props.route = {
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionId: null,
      agents: routeAgents,
      agentCatalog: createAgentCatalog(routeAgents),
      sessions: [claudeSession],
      bookmarks,
    };

    renderContent(props);

    expect(screen.getByRole("heading", { name: "Claude Code" })).toBeTruthy();
    const sessionLink = screen.getByRole("link", { name: /Claude opaque session/ });
    expect(sessionLink.getAttribute("href")).toBe("/claudecode/shared%2Fid%3Fx%23y%25");
    expect(screen.queryByText("Codex twin session")).toBeNull();
    expect(bookmarks.isBookmarked).toHaveBeenCalledWith("claudecode", sessionId);

    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(bookmarks.toggleSessionBookmark).toHaveBeenCalledWith(claudeSession, "claudecode");
  });

  it("renders a missing session with agent-scoped recovery links", () => {
    const props = makeProps();
    const attemptedSessionId = "missing/id?#%";
    const recoverySessionId = "recovery/id?#%";
    const claudeSession = makeLandingSession(
      "claudecode",
      recoverySessionId,
      "Claude recovery session",
    );
    const route = makeSessionRoute(attemptedSessionId, {
      session: null,
      loading: false,
      error: { kind: "missing" },
      retry: vi.fn(),
    });
    route.sessions = [claudeSession];
    props.route = route;

    renderContent(props);

    expect(screen.getByRole("heading", { name: "This session isn't in the index." })).toBeTruthy();
    expect(screen.getByText(attemptedSessionId)).toBeTruthy();
    const recoveryLink = screen.getByRole("link", { name: /Claude recovery session/ });
    expect(recoveryLink.getAttribute("href")).toBe("/claudecode/recovery%2Fid%3F%23%25");
    expect(screen.queryByText("Codex recovery session")).toBeNull();
    expect(route.bookmarks.isBookmarked).toHaveBeenCalledWith("claudecode", recoverySessionId);

    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(route.bookmarks.toggleSessionBookmark).toHaveBeenCalledWith(claudeSession, "claudecode");
  });

  it("renders a retryable load failure instead of a missing session", () => {
    const props = makeProps();
    const retry = vi.fn();
    props.route = makeSessionRoute("unavailable-session", {
      session: null,
      loading: false,
      error: { kind: "load-failed", message: "server unavailable" },
      retry,
    });

    renderContent(props);

    expect(screen.getByRole("heading", { name: "We couldn't load this session." })).toBeTruthy();
    expect(screen.getByText("server unavailable")).toBeTruthy();
    expect(screen.queryByText("This session isn't in the index.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("renders a missing agent with diagnostics and canonical recovery links", () => {
    const props = makeProps();
    props.route = {
      mode: "missingAgent",
      activeAgentKey: null,
      activeSessionId: null,
      attemptedKey: "ghost-agent",
      agents: routeAgents,
      agentCatalog: createAgentCatalog(routeAgents),
      sessions: [],
      bookmarks: makeBookmarks(),
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
