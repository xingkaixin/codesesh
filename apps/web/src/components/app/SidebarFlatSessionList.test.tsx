import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { SidebarFlatSessionList, VIRTUALIZED_SESSION_THRESHOLD } from "./SidebarFlatSessionList";

afterEach(cleanup);

const session: SessionHead = {
  id: "session-1",
  slug: "codex/session-1",
  title: "Test session",
  directory: "/repo",
  time_created: 1,
  stats: {
    message_count: 1,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cost: 0,
  },
};

function makeSessions(count: number): SessionHead[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    slug: `codex/session-${index}`,
    title: `Session ${index}`,
    directory: "/repo",
    time_created: index,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  }));
}

describe("SidebarFlatSessionList", () => {
  it("forwards session menu actions without selecting the row", () => {
    const onSelectSession = vi.fn();
    const onRenameSession = vi.fn();
    const onToggleBookmark = vi.fn();

    render(
      <SidebarFlatSessionList
        sessions={[session]}
        agentCatalog={createAgentCatalog([])}
        activeSessionId={null}
        selectedSessionId={null}
        bookmarkedSessionIds={new Set()}
        onSelectSession={onSelectSession}
        onRenameSession={onRenameSession}
        onToggleBookmark={onToggleBookmark}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRenameSession).toHaveBeenCalledWith(session);

    fireEvent.click(screen.getByRole("button", { name: "Session options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add bookmark" }));
    expect(onToggleBookmark).toHaveBeenCalledWith(session);
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

describe("SidebarFlatSessionList virtualization", () => {
  it("renders every row when at or below the threshold", () => {
    const sessions = makeSessions(VIRTUALIZED_SESSION_THRESHOLD);

    render(
      <SidebarFlatSessionList
        sessions={sessions}
        agentCatalog={createAgentCatalog([])}
        activeSessionId={null}
        selectedSessionId={null}
        bookmarkedSessionIds={new Set()}
        onSelectSession={vi.fn()}
        onRenameSession={vi.fn()}
        onToggleBookmark={vi.fn()}
      />,
    );

    expect(screen.getAllByRole("listitem")).toHaveLength(VIRTUALIZED_SESSION_THRESHOLD);
  });

  it("keeps the rendered DOM node count bounded once past the threshold", () => {
    const sessions = makeSessions(VIRTUALIZED_SESSION_THRESHOLD * 20);

    const view = render(
      <SidebarFlatSessionList
        sessions={sessions}
        agentCatalog={createAgentCatalog([])}
        activeSessionId={null}
        selectedSessionId={null}
        bookmarkedSessionIds={new Set()}
        onSelectSession={vi.fn()}
        onRenameSession={vi.fn()}
        onToggleBookmark={vi.fn()}
      />,
    );

    const rendered = view.container.querySelectorAll("li").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(sessions.length / 2);
  });

  it("still reflects selection and forwards actions for a virtualized row that is scrolled into view", () => {
    const sessions = makeSessions(VIRTUALIZED_SESSION_THRESHOLD * 5);
    const onSelectSession = vi.fn();
    const onRenameSession = vi.fn();
    const targetSession = sessions[0]!;

    render(
      <SidebarFlatSessionList
        sessions={sessions}
        agentCatalog={createAgentCatalog([])}
        activeSessionId={targetSession.id}
        selectedSessionId={targetSession.id}
        bookmarkedSessionIds={new Set()}
        onSelectSession={onSelectSession}
        onRenameSession={onRenameSession}
        onToggleBookmark={vi.fn()}
      />,
    );

    const title = screen.getByText("Session 0");
    fireEvent.click(title);
    expect(onSelectSession).toHaveBeenCalledWith(targetSession);
  });
});
