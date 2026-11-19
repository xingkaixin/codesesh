import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentInfo, SessionDetail, SessionHead } from "@codesesh/contract";
import { createAgentCatalog } from "../../lib/agents";
import { getSessionRouteKey, type IndexedSession } from "../../lib/session-indexes";
import { createQueryWrapper } from "../../test/query-wrapper";
import { AppRouteContent } from "./AppRouteContent";

const LAZY_SURFACE_TIMEOUT_MS = 5_000;

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
      controls: { current: null },
      onSubmit: vi.fn(),
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

function makeBookmarks() {
  return {
    isBookmarked: vi.fn(() => false),
    toggleSessionBookmark: vi.fn(),
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

beforeAll(async () => {
  // Keep cold module transforms out of the first landing test's timeout on CI.
  await Promise.all([import("../DetailLanding"), import("../SessionDetail")]);
});

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
  it("renders an agent landing with encoded session links and full-reference bookmark actions", async () => {
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

    expect(
      await screen.findByRole(
        "heading",
        { name: "Claude Code" },
        { timeout: LAZY_SURFACE_TIMEOUT_MS },
      ),
    ).toBeTruthy();
    const sessionLink = screen.getByRole("link", { name: /Claude opaque session/ });
    expect(sessionLink.getAttribute("href")).toBe("/claudecode/shared%2Fid%3Fx%23y%25");
    expect(screen.queryByText("Codex twin session")).toBeNull();
    expect(bookmarks.isBookmarked).toHaveBeenCalledWith("claudecode", sessionId, undefined);

    fireEvent.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(bookmarks.toggleSessionBookmark).toHaveBeenCalledWith(claudeSession, "claudecode");
  });

  it("exposes all agent sessions beyond the top 5 via pagination", async () => {
    const props = makeProps();
    const bookmarks = makeBookmarks();
    const sessions = Array.from({ length: 30 }, (_, index) => ({
      ...makeLandingSession("claudecode", `session-${index + 1}`, `Session #${index + 1}`),
      time_updated: 1_000 - index,
    }));
    props.route = {
      mode: "agent",
      activeAgentKey: "claudecode",
      activeSessionId: null,
      agents: routeAgents,
      agentCatalog: createAgentCatalog(routeAgents),
      sessions,
      bookmarks,
    };

    renderContent(props);

    expect(
      await screen.findByText("Session #1", {}, { timeout: LAZY_SURFACE_TIMEOUT_MS }),
    ).toBeTruthy();
    expect(screen.getByText("Session #6")).toBeTruthy();
    expect(screen.getByText("Session #25")).toBeTruthy();
    expect(screen.queryByText("Session #26")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show more (5 remaining)" }));

    expect(screen.getByText("Session #26")).toBeTruthy();
    expect(screen.getByText("Session #30")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
  });

  it("lists unlinked child sessions on a parent session and updates them when sourceNodeId changes", async () => {
    const bookmarks = makeBookmarks();
    const agentCatalog = createAgentCatalog(routeAgents);
    const localChild: SessionHead = {
      reference: { agentName: "codex", sessionId: "child-local" },
      parent_reference: { agentName: "codex", sessionId: "shared-parent" },
      title: "Local background sub-session",
      directory: "/repo",
      time_created: 10,
      time_updated: 20,
      stats: { message_count: 4, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    };
    const remoteChild: SessionHead = {
      reference: { sourceNodeId: "worker-a", agentName: "codex", sessionId: "child-remote" },
      parent_reference: {
        sourceNodeId: "worker-a",
        agentName: "codex",
        sessionId: "shared-parent",
      },
      title: "Remote background sub-session",
      directory: "/repo",
      time_created: 10,
      time_updated: 30,
      stats: { message_count: 7, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
    };

    const childSessionsByParentRouteKey = new Map<string, SessionHead[]>([
      [getSessionRouteKey("codex", "shared-parent"), [localChild]],
      [getSessionRouteKey("codex", "shared-parent", "worker-a"), [remoteChild]],
    ]);

    const makeParentDetail = (sourceNodeId?: string): SessionDetail => ({
      reference: { agentName: "codex", sessionId: "shared-parent", sourceNodeId },
      title: "Parent session",
      directory: "/repo",
      time_created: 1,
      time_updated: 5,
      stats: { message_count: 1, total_input_tokens: 0, total_output_tokens: 0, total_cost: 0 },
      messages: [
        {
          id: "m0",
          role: "user",
          time_created: 1,
          // No subagent_id on the message: child session must still be discoverable from the summary list.
          parts: [{ type: "text", text: "Kick off work" }],
        },
      ],
    });

    const buildSessionProps = (sourceNodeId?: string): Parameters<typeof AppRouteContent>[0] => ({
      ...makeProps(),
      route: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "shared-parent",
        sourceNodeId,
        agents: routeAgents,
        agentCatalog,
        sessions: [],
        bookmarks,
        detail: {
          phase: { kind: "ready", session: makeParentDetail(sourceNodeId) },
          retry: vi.fn(),
        },
        detailHighlightQuery: "",
        childSessionsByParentRouteKey,
      },
    });

    const { Wrapper } = createQueryWrapper();
    const view = render(
      <Wrapper>
        <MemoryRouter>
          <AppRouteContent {...buildSessionProps(undefined)} />
        </MemoryRouter>
      </Wrapper>,
    );

    const localLink = await screen.findByRole(
      "link",
      { name: /Local background sub-session/ },
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );
    expect(localLink.getAttribute("href")).toBe("/codex/child-local");
    expect(screen.queryByRole("link", { name: /Remote background sub-session/ })).toBeNull();

    view.rerender(
      <Wrapper>
        <MemoryRouter>
          <AppRouteContent {...buildSessionProps("worker-a")} />
        </MemoryRouter>
      </Wrapper>,
    );

    const remoteLink = await screen.findByRole(
      "link",
      { name: /Remote background sub-session/ },
      { timeout: LAZY_SURFACE_TIMEOUT_MS },
    );
    expect(remoteLink.getAttribute("href")).toBe("/nodes/worker-a/codex/child-remote");
    expect(screen.queryByRole("link", { name: /Local background sub-session/ })).toBeNull();
  });
});
