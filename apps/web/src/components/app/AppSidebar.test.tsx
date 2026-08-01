import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AgentInfo, ScanStatusEvent } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
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
            viewState: { mode: "root", activeAgentKey: null, activeSessionId: null },
            agents,
            agentCatalog: createAgentCatalog(agents),
            activeAgentKey: null,
            scanStatus,
            projects: [],
            selectedProjectNavigationId: null,
            loading: false,
            bookmarkedSessions: [],
            sidebarSessions: [],
            selectedSidebarSessionReference: null,
            bookmarkedSidebarSessionReferences: new Set(),
          }}
          actions={actions}
        />
      </MemoryRouter>,
    );

    const codexLink = screen.getByRole("link", { name: /Codex/ });
    expect(codexLink.textContent).toContain("5");
    expect(codexLink.textContent).not.toContain("1856");
  });

  it("uses indeterminate progress for indexing and determinate progress for known totals", () => {
    const agents = [
      { name: "codex", displayName: "Codex", count: 5 },
      { name: "claudecode", displayName: "Claude Code", count: 8 },
    ] as AgentInfo[];
    const scanStatus = {
      type: "scan-status",
      active: true,
      phase: "scanning",
      pendingAgents: [],
      scanningAgents: ["codex", "claudecode"],
      completedAgents: [],
      totalAgents: 2,
      updatedAt: 1,
      backfill: {
        active: false,
        pendingAgents: [],
        completedAgents: [],
        failedAgents: [],
      },
      agentStatuses: {
        codex: {
          agentName: "codex",
          status: "indexing",
          processed: 5,
          total: 5,
          updatedAt: 1,
        },
        claudecode: {
          agentName: "claudecode",
          status: "scanning",
          processed: 4,
          total: 10,
          updatedAt: 1,
        },
      },
    } satisfies ScanStatusEvent;

    render(
      <MemoryRouter>
        <AppSidebar
          model={{
            sidebarCollapsed: false,
            browseBy: "agents",
            isScanActive: true,
            viewState: { mode: "root", activeAgentKey: null, activeSessionId: null },
            agents,
            agentCatalog: createAgentCatalog(agents),
            activeAgentKey: null,
            scanStatus,
            projects: [],
            selectedProjectNavigationId: null,
            loading: false,
            bookmarkedSessions: [],
            sidebarSessions: [],
            selectedSidebarSessionReference: null,
            bookmarkedSidebarSessionReferences: new Set(),
          }}
          actions={actions}
        />
      </MemoryRouter>,
    );

    const codexLink = screen.getByRole("link", { name: /Codex/ });
    expect(codexLink.textContent).toContain("5");
    expect(codexLink.textContent).toContain("Indexing");
    expect(screen.getByText("Indexing")).toBeTruthy();
    const indexingProgress = screen.getByRole("progressbar", {
      name: "Codex indexing progress",
    });
    expect(indexingProgress.getAttribute("aria-valuenow")).toBeNull();
    expect(
      indexingProgress.firstElementChild?.classList.contains("scan-progress-indeterminate"),
    ).toBe(true);

    expect(screen.getByText("4/10")).toBeTruthy();
    const scanningProgress = screen.getByRole("progressbar", {
      name: "Claude Code scan progress",
    });
    expect(scanningProgress.getAttribute("aria-valuenow")).toBe("40");
    expect((scanningProgress.firstElementChild as HTMLElement).style.width).toBe("40%");
  });
});
