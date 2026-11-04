import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "@codesesh/contract";
import { createAgentCatalog } from "../../lib/agents";
import type { IndexedSession } from "../../lib/session-indexes";
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
  await import("../DetailLanding");
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
});
