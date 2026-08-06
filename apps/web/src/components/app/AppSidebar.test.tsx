import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, ApiProjectGroup, ScanStatusEvent } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
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
    onSelectProject: vi.fn(),
    onToggleBookmark: vi.fn(),
    onSelectFlatSidebarSession: vi.fn(),
    onToggleSidebarSessionBookmark: vi.fn(),
    onRenameSession: vi.fn(),
    onRenameBookmarkedSession: vi.fn(),
    ...overrides,
  };
}

function renderSidebar(
  model: Partial<AppSidebarViewModel> = {},
  actions: AppSidebarActions = createActions(),
) {
  return render(
    <MemoryRouter>
      <AppSidebar
        model={{
          sidebarCollapsed: false,
          isScanActive: false,
          viewState: { mode: "root", activeAgentKey: null, activeSessionId: null },
          agentCatalog: createAgentCatalog(agents),
          scanStatus: null,
          projects,
          selectedProjectNavigationId: null,
          loading: false,
          bookmarkedSessions: [],
          sidebarSessions: [],
          selectedSidebarSessionReference: null,
          bookmarkedSidebarSessionReferences: new Set(),
          ...model,
        }}
        actions={actions}
      />
    </MemoryRouter>,
  );
}

describe("AppSidebar", () => {
  it("lists projects under the global dashboard entry", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: /Dashboard/ })).toBeTruthy();
    const projectLink = screen.getByRole("link", { name: /codesesh/ });
    expect(projectLink.getAttribute("href")).toBe("/projects/path/%2Frepo%2Fcodesesh");
    expect(projectLink.textContent).toContain("12");
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

  it("collapses from its own control rather than the app header", () => {
    const onCollapse = vi.fn();
    renderSidebar({}, createActions({ onCollapse }));

    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it("reports scanning while no projects have been discovered yet", () => {
    renderSidebar({
      projects: [],
      isScanActive: true,
      scanStatus: { active: true } as ScanStatusEvent,
    });

    expect(screen.getByText("Scanning projects...")).toBeTruthy();
  });

  it("asks for a project before it can list sessions", () => {
    renderSidebar();

    expect(screen.getByText("Select a project")).toBeTruthy();
  });
});
