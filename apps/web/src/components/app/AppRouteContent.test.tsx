import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiProjectGroup, SessionDetail } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { createQueryWrapper } from "../../test/query-wrapper";
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
    props.viewState = {
      mode: "project",
      activeAgentKey: null,
      activeSessionId: null,
      activeProjectKind: "git_remote",
      activeProjectKey: project.identityKey,
    };
    props.activeProject = project;

    renderContent(props);

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
});
