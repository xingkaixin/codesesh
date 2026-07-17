import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup } from "../../lib/api";
import { AppRouteContent } from "./AppRouteContent";

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
} satisfies ProjectGroup;

function makeProps(): Parameters<typeof AppRouteContent>[0] {
  return {
    loading: false,
    error: null,
    viewState: {
      mode: "root",
      activeAgentKey: null,
      activeSessionSlug: null,
    },
    detailHighlightQuery: "",
    agents: [],
    agentNameMap: new Map(),
    projects: [project],
    landingSessions: [],
    sessionsByAgent: new Map(),
    activeProject: null,
    activeProjectSessions: [],
    dashboard: null,
    sessionDetail: { session: null, loading: false, error: null },
    projectDashboard: {
      dashboard: null,
      loading: false,
      error: null,
      onChangeAgent: vi.fn(),
    },
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
      sessions: [],
      isBookmarked: vi.fn(() => false),
      toggleBookmark: vi.fn(),
      toggleSessionBookmark: vi.fn(),
    },
  };
}

afterEach(cleanup);

describe("AppRouteContent", () => {
  it("renders a project from the resolved project model", () => {
    const props = makeProps();
    props.viewState = {
      mode: "project",
      activeAgentKey: null,
      activeSessionSlug: null,
      activeProjectKind: "git_remote",
      activeProjectKey: project.identityKey,
    };
    props.activeProject = project;

    render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "acme/app" })).toBeTruthy();
  });

  it("renders search content from the explicit search contract", () => {
    const props = makeProps();
    props.search.active = true;

    render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { name: "No recent sessions" })).toBeTruthy();
  });
});
