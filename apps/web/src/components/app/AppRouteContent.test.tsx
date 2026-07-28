import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { AppRouteContent } from "./AppRouteContent";

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
  // The route surfaces load on demand, so these assertions wait for the chunk.
  // The default 1s query timeout is tight when the suite runs under load.
  it("renders a project from the resolved project model", async () => {
    const props = makeProps();
    props.viewState = {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
      activeProjectKind: "git_remote",
      activeProjectKey: project.identityKey,
    };
    props.activeProject = project;

    render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "acme/app" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();
  });

  it("renders search content from the explicit search contract", async () => {
    const props = makeProps();
    props.search.active = true;

    render(
      <MemoryRouter>
        <AppRouteContent {...props} />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "No recent sessions" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();
  });
});
