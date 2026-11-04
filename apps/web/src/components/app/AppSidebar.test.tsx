import { cleanup, render, screen } from "@testing-library/react";
import { SAMPLE_SCAN_STATUS_EVENT } from "@codesesh/contract/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, ApiProjectGroup, BookmarkView, ScanStatusEvent } from "@codesesh/contract";
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
    onCopySessionAsMarkdown: vi.fn(),
    onToggleSidebarSessionBookmark: vi.fn(),
    onRenameSession: vi.fn(),
    onRenameBookmarkedSession: vi.fn(),
    onRetryProjects: vi.fn(),
    onRetryBookmarks: vi.fn(),
    onOpenSearch: vi.fn(),
    onChangeTheme: vi.fn(),
    onShowShortcuts: vi.fn(),
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
            hubEnabled: false,
            sessionCount: 0,
            theme: "system",
            ...model,
          }}
          actions={actions}
        />
      </MemoryRouter>
    </ScanStatusProvider>,
  );
}

describe("AppSidebar", () => {
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
