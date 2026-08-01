import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Api from "../lib/api";
import { createAgentCatalog } from "../lib/agents";

const displayModelMocks = vi.hoisted(() => ({
  build: vi.fn(),
}));

vi.mock("./session-detail/display-model", () => ({
  buildSessionDetailDisplayModel: displayModelMocks.build,
}));

import { SessionDetail } from "./SessionDetail";

afterEach(() => {
  cleanup();
  displayModelMocks.build.mockReset();
});

describe("SessionDetail identity", () => {
  it("uses the authoritative reference when slug is absent", () => {
    displayModelMocks.build.mockReturnValue({
      messages: [],
      toc: { filterIds: [] },
      fileChangeSummary: null,
      resolveMessageIndex: vi.fn(),
      select: vi.fn(() => ({ messages: [], timelineEntries: [], resolveListIndex: vi.fn() })),
    });
    const session: Api.SessionDetail = {
      reference: { agentName: "codex", sessionId: "s1" },
      id: "s1",
      slug: null,
      title: "Session",
      directory: "/repo",
      time_created: 1,
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
      messages: [],
    };

    render(<SessionDetail session={session} agentCatalog={createAgentCatalog([])} />);

    expect(screen.getByTestId("session-detail")).toBeTruthy();
    expect(displayModelMocks.build).toHaveBeenCalledWith({
      messages: [],
      agentName: "codex",
      fileActivity: undefined,
    });
  });

  it("does not render a session relationships panel", () => {
    displayModelMocks.build.mockReturnValue({
      messages: [],
      toc: { filterIds: [] },
      fileChangeSummary: null,
      resolveMessageIndex: vi.fn(),
      select: vi.fn(() => ({ messages: [], timelineEntries: [], resolveListIndex: vi.fn() })),
    });
    const session: Api.SessionDetail = {
      reference: { agentName: "codex", sessionId: "parent" },
      id: "parent",
      slug: "codex/parent",
      title: "Parent",
      directory: "/repo",
      parent_reference: { agentName: "codex", sessionId: "root" },
      time_created: 1,
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
      messages: [],
    };
    const child: Api.SessionHead = {
      id: "child",
      slug: "codex/child",
      title: "Child",
      directory: "/repo",
      time_created: 1,
      stats: {
        message_count: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0,
      },
    };

    render(
      <SessionDetail
        session={session}
        childSessions={[child]}
        agentCatalog={createAgentCatalog([])}
      />,
    );

    expect(screen.queryByRole("navigation", { name: "Session relationships" })).toBeNull();
  });
});
