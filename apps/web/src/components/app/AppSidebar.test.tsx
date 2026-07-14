import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, ScanStatusEvent } from "../../lib/api";
import { AppSidebar, type AppSidebarActions } from "./AppSidebar";

afterEach(cleanup);

const actions: AppSidebarActions = {
  onChangeBrowseBy: vi.fn(),
  onSelectProject: vi.fn(),
  onToggleBookmark: vi.fn(),
  onSelectFlatSidebarSession: vi.fn(),
  onToggleSidebarSessionBookmark: vi.fn(),
  onRenameSession: vi.fn(),
  onRenameBookmarkedSession: vi.fn(),
  onSelectTreeSidebarSession: vi.fn(),
};

describe("AppSidebar agent counts", () => {
  it("uses the filtered API count after scanning completes", () => {
    const agents = [{ name: "codex", displayName: "Codex", count: 5 }] as AgentInfo[];
    const scanStatus = {
      active: false,
      agentStatuses: {
        codex: { status: "complete", sessions: 1856 },
      },
    } as unknown as ScanStatusEvent;

    render(
      <MemoryRouter>
        <AppSidebar
          model={{
            sidebarCollapsed: false,
            browseBy: "agents",
            isScanActive: false,
            viewState: { mode: "root", activeAgentKey: null, activeSessionSlug: null },
            agents,
            activeAgentKey: null,
            scanStatus,
            projects: [],
            selectedProjectNavigationId: null,
            loading: false,
            bookmarkedSessions: [],
            sidebarSessions: [],
            selectedSidebarSessionId: null,
            bookmarkedSidebarSessionIds: new Set(),
          }}
          actions={actions}
        />
      </MemoryRouter>,
    );

    const codexLink = screen.getByRole("link", { name: /Codex/ });
    expect(codexLink.textContent).toContain("5");
    expect(codexLink.textContent).not.toContain("1856");
  });
});
