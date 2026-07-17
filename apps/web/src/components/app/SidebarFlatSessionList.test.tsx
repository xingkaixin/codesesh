import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "../../lib/api";
import { createAgentCatalog } from "../../lib/agents";
import { SidebarFlatSessionList } from "./SidebarFlatSessionList";

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
