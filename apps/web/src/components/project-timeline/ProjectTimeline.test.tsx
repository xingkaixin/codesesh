import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core/contract";
import { createAgentCatalog } from "../../lib/agents";
import { TIMELINE_CHILD_PAGE_SIZE, TIMELINE_MAIN_PAGE_SIZE } from "../../lib/session-timeline";
import { ProjectTimeline } from "./ProjectTimeline";

const AGENT_CATALOG = createAgentCatalog([
  {
    name: "codex",
    displayName: "Codex",
    count: 3,
    icon: "/icon/agent/codex.svg",
    resumeCommandPrefix: null,
  },
]);

function at(day: number, hour: number): number {
  return new Date(2026, 7, day, hour).getTime();
}

function createSession(
  overrides: Partial<SessionHead> & { id: string; time_updated: number },
): SessionHead {
  return {
    slug: `codex/${overrides.id}`,
    title: overrides.id,
    directory: "/workspace/a",
    time_created: overrides.time_updated,
    stats: {
      message_count: 4,
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_tokens: 150,
      total_cost: 1,
    },
    ...overrides,
  };
}

const PARENT = createSession({ id: "root", title: "Refactor the scanner", time_updated: at(6, 9) });
const CHILD = createSession({
  id: "child",
  title: "Probe the cache",
  time_updated: at(6, 10),
  parent_reference: { agentName: "codex", sessionId: "root" },
});
const SOLO = createSession({ id: "solo", title: "Tidy the docs", time_updated: at(5, 9) });

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{location.pathname}</span>;
}

function renderTimeline(sessions: SessionHead[]) {
  const onOpenSession = vi.fn();
  render(
    <MemoryRouter initialEntries={["/projects/a"]}>
      <ProjectTimeline
        sessions={sessions}
        projectName="workspace-a"
        agentCatalog={AGENT_CATALOG}
        onOpenSession={onOpenSession}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
  return { onOpenSession };
}

afterEach(cleanup);

describe("ProjectTimeline", () => {
  it("renders one bounded page of main sessions", () => {
    const rootCount = 500;
    const roots = Array.from({ length: rootCount }, (_, index) =>
      createSession({ id: `large-root-${index}`, time_updated: at(5, 9) + index }),
    );

    renderTimeline(roots);

    expect(document.querySelectorAll("article")).toHaveLength(TIMELINE_MAIN_PAGE_SIZE);
    expect(screen.getByText(`Page 1 · ${TIMELINE_MAIN_PAGE_SIZE} shown`)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next timeline page" }));

    expect(document.querySelectorAll("article")).toHaveLength(TIMELINE_MAIN_PAGE_SIZE);
    expect(screen.getByText(`Page 2 · ${TIMELINE_MAIN_PAGE_SIZE} shown`)).not.toBeNull();
  });

  it("derives and renders one bounded page of sub-sessions after expansion", () => {
    const childCount = 120;
    const parent = createSession({ id: "large-parent", time_updated: at(6, 8) });
    const children = Array.from({ length: childCount }, (_, index) =>
      createSession({
        id: `large-child-${index}`,
        time_updated: at(6, 9) + index,
        parent_reference: { agentName: "codex", sessionId: parent.id },
      }),
    );

    renderTimeline([parent, ...children]);
    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));

    expect(screen.getAllByRole("button", { name: /large-child-/ })).toHaveLength(
      TIMELINE_CHILD_PAGE_SIZE,
    );
    expect(screen.getByRole("button", { name: /large-child-0\b/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next sub-session page" }));

    expect(screen.getAllByRole("button", { name: /large-child-/ })).toHaveLength(
      TIMELINE_CHILD_PAGE_SIZE,
    );
    expect(screen.queryByRole("button", { name: /large-child-0\b/ })).toBeNull();
    expect(screen.getByRole("button", { name: /large-child-40\b/ })).not.toBeNull();
  });

  it("summarises main and sub sessions in the header", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    expect(screen.getByText("2 sessions · 1 sub-sessions · 450 tokens")).not.toBeNull();
    expect(screen.getByRole("region", { name: "workspace-a timeline" })).not.toBeNull();
  });

  it("keeps a mounted child off the main axis and marks the parent as inclusive", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    const parent = screen.getByRole("button", { name: /Refactor the scanner/ });
    expect(parent.textContent).toContain("1 sub-sessions");
    expect(parent.textContent).toContain("8 msgs");
    expect(screen.getByText(/incl. sub/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
  });

  it("omits the incl. sub suffixes for a childless session", () => {
    renderTimeline([SOLO]);

    const row = screen.getByRole("button", { name: /Tidy the docs/ });
    expect(row.textContent).not.toContain("incl. sub");
    expect(screen.queryByText(/incl. sub/)).toBeNull();
  });

  it("expands one row at a time in Collapsed mode without navigating", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));

    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/projects/a");
  });

  it("expands every row in Expand all mode and restores per-row state when returning to Collapsed", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("radio", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Collapsed" }));
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
  });

  it("keeps a row opened in Collapsed mode open after a round trip through Expand all", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Expand all" }));
    fireEvent.click(screen.getByRole("radio", { name: "Collapsed" }));

    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();
  });

  it("hides the pill and panel in Hidden mode without changing the parent's numbers", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Hidden" }));

    expect(screen.queryByRole("button", { name: /⑂/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
    const parent = screen.getByRole("button", { name: /Refactor the scanner/ });
    expect(parent.textContent).toContain("1 sub-sessions");
    expect(parent.textContent).toContain("8 msgs");
  });

  it("opens a session through the callback", () => {
    const { onOpenSession } = renderTimeline([SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /Tidy the docs/ }));

    expect(onOpenSession).toHaveBeenCalledWith({ agentName: "codex", sessionId: "solo" });
  });

  it("surfaces orphans inline and notes them once", () => {
    renderTimeline([
      SOLO,
      createSession({
        id: "orphan",
        title: "Lost thread",
        time_updated: at(5, 10),
        parent_reference: { agentName: "codex", sessionId: "gone" },
      }),
    ]);

    expect(screen.getByRole("button", { name: /Lost thread/ })).not.toBeNull();
    expect(screen.getByText("Unmounted")).not.toBeNull();
    expect(screen.getByText("1 unmounted sub-sessions · parent file is gone")).not.toBeNull();
  });

  it("omits the orphan note when everything is mounted", () => {
    renderTimeline([PARENT, CHILD]);

    expect(screen.queryByText(/unmounted sub-sessions/)).toBeNull();
  });
});
