import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/core/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, ApiProjectGroup, BookmarkView, ScanStatusEvent } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { ScanStatusProvider } from "../../hooks/useScanStatus";
import { buildSidebarSessionLookup } from "../../lib/session-indexes";
import { AppSidebar, type AppSidebarActions, type AppSidebarViewModel } from "./AppSidebar";

afterEach(cleanup);

const agents = [{ name: "codex", displayName: "Codex", count: 5 }] as AgentInfo[];

const projects = [
  {
    identityKind: "path",
    identityKey: "/repo/codesesh",
    displayName: "codesesh",
    sessionCount: 12,
  },
] as ApiProjectGroup[];

function createActions(overrides: Partial<AppSidebarActions> = {}): AppSidebarActions {
  return {
    onCollapse: vi.fn(),
    onMobileNavigationOpenChange: vi.fn(),
    onToggleBookmark: vi.fn(),
    onSelectFlatSidebarSession: vi.fn(),
    onToggleSidebarSessionBookmark: vi.fn(),
    onRenameSession: vi.fn(),
    onRenameBookmarkedSession: vi.fn(),
    onRetryProjects: vi.fn(),
    onRetryBookmarks: vi.fn(),
    ...overrides,
  };
}

function renderSidebar(
  model: Partial<AppSidebarViewModel> = {},
  actions: AppSidebarActions = createActions(),
  scanStatus: ScanStatusEvent = SAMPLE_SCAN_STATUS_EVENT,
) {
  return render(
    <ScanStatusProvider initialStatus={scanStatus}>
      <MemoryRouter>
        <AppSidebar
          model={{
            sidebarCollapsed: false,
            mobileNavigationOpen: false,
            viewState: { mode: "root", activeAgentKey: null, activeSessionId: null },
            agentCatalog: createAgentCatalog(agents),
            projects,
            projectCount: projects.length,
            projectsError: null,
            projectsLoading: false,
            selectedProjectNavigationId: null,
            bookmarkedSessions: [],
            bookmarksError: null,
            bookmarksLoading: false,
            sidebarSessions: [],
            sidebarSessionLookup: buildSidebarSessionLookup([]),
            bookmarkedSidebarSessionReferences: new Set(),
            isSearchMode: false,
            shortcutHelpOpen: false,
            dismissShortcutHint: vi.fn(),
            ...model,
          }}
          actions={actions}
        />
      </MemoryRouter>
    </ScanStatusProvider>,
  );
}

describe("AppSidebar", () => {
  it("renders navigation in a mobile drawer without the desktop collapse control", () => {
    const onMobileNavigationOpenChange = vi.fn();
    renderSidebar({ mobileNavigationOpen: true }, createActions({ onMobileNavigationOpenChange }));

    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onMobileNavigationOpenChange.mock.calls[0]?.[0]).toBe(false);
  });

  it("lists projects under the global dashboard entry", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeTruthy();
    const projectLink = screen.getByRole("link", { name: /codesesh/ });
    expect(projectLink.getAttribute("href")).toBe("/projects/path/%2Frepo%2Fcodesesh");
    expect(projectLink.textContent).toContain("12");
  });

  it("bounds project links while keeping the active project reachable", () => {
    const manyProjects = Array.from({ length: 200 }, (_, index) => ({
      ...projects[0]!,
      identityKey: `/repo/${index}`,
      displayName: `project-${index}`,
    }));
    renderSidebar({
      projects: manyProjects,
      projectCount: manyProjects.length,
      selectedProjectNavigationId: "path:/repo/199",
    });

    expect(screen.getByRole("link", { name: /^Projects 200$/ })).toBeTruthy();
    expect(
      screen.getAllByRole("link").filter((link) => link.textContent?.includes("project-")),
    ).toHaveLength(51);
    expect(screen.getByRole("link", { name: /project-199/ })).toBeTruthy();
  });

  it("marks the dashboard entry active only on the root route", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: /Dashboard/ }).dataset.active).toBe("true");

    cleanup();
    renderSidebar({
      viewState: {
        mode: "project",
        activeProjectKind: "path",
        activeProjectKey: "/repo/codesesh",
        activeAgentKey: null,
        activeSessionId: null,
      },
    });
    expect(screen.getByRole("link", { name: /Dashboard/ }).dataset.active).toBeUndefined();
  });

  it("renders its collapse control beside the dashboard link", () => {
    const onCollapse = vi.fn();
    renderSidebar({}, createActions({ onCollapse }));

    const dashboardLink = screen.getByRole("link", { name: /Dashboard/ });
    const collapseButton = screen.getByRole("button", { name: "Collapse sidebar" });

    expect(collapseButton.closest("li")).toBe(dashboardLink.closest("li"));
    fireEvent.click(collapseButton);

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("reports scanning while no projects have been discovered yet", () => {
    renderSidebar({ projects: [] }, createActions(), {
      ...SAMPLE_SCAN_STATUS_EVENT,
      active: true,
      phase: "scanning",
    });

    expect(screen.getByText("Scanning projects...")).toBeTruthy();
  });

  it("shows an empty state only after projects load successfully", () => {
    renderSidebar({ projects: [] });

    expect(screen.getByText("No projects found")).toBeTruthy();

    cleanup();
    renderSidebar({ projects: [], projectsLoading: true });

    expect(screen.queryByText("No projects found")).toBeNull();
  });

  it("keeps project failures local and retryable", () => {
    const onRetryProjects = vi.fn();
    renderSidebar(
      { projects: [], projectsError: "projects unavailable" },
      createActions({ onRetryProjects }),
    );

    expect(screen.getByRole("alert").textContent).toContain("Couldn't load projects.");
    expect(screen.getByText("projects unavailable")).toBeTruthy();
    expect(screen.queryByText("No projects found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryProjects).toHaveBeenCalledTimes(1);
  });

  it("distinguishes bookmark failures from an empty list", () => {
    const onRetryBookmarks = vi.fn();
    renderSidebar(
      { bookmarkedSessions: [], bookmarksError: "bookmarks unavailable" },
      createActions({ onRetryBookmarks }),
    );

    expect(screen.getByRole("alert").textContent).toContain("Couldn't load bookmarks.");
    expect(screen.getByText("bookmarks unavailable")).toBeTruthy();
    expect(screen.queryByText("No bookmarks yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryBookmarks).toHaveBeenCalledOnce();
  });

  it("does not show an empty bookmark state while loading", () => {
    renderSidebar({ bookmarkedSessions: [], bookmarksLoading: true });

    expect(screen.getByText("Loading bookmarks...")).toBeTruthy();
    expect(screen.queryByText("No bookmarks yet")).toBeNull();
  });

  it("omits the sessions section until a project is selected", () => {
    renderSidebar();

    expect(screen.queryByRole("heading", { name: /SESSIONS/ })).toBeNull();
  });

  it("renders unavailable bookmark facts without navigable stale session links", () => {
    const bookmarkedSessions: BookmarkView[] = [
      {
        reference: { agentName: "codex", sessionId: "gone" },
        bookmarkedAt: 2,
        availability: "session-unavailable",
        display_title: "Lost alias",
      },
      {
        reference: { agentName: "removed-agent", sessionId: "orphan" },
        bookmarkedAt: 1,
        availability: "agent-unavailable",
      },
    ];

    renderSidebar({ bookmarkedSessions });

    expect(screen.getByText("Lost alias")).toBeTruthy();
    expect(screen.getByText("Codex · gone · Session unavailable")).toBeTruthy();
    expect(screen.getByText("removed-agent · Agent unavailable")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Lost alias/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /orphan/ })).toBeNull();
  });
});
