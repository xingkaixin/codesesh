import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
      slug: "codex/s1",
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
      reference: { agentName: "codex", sessionId: "child" },
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

describe("SessionDetail content filtering", () => {
  function renderFiltered() {
    displayModelMocks.build.mockReturnValue({
      messages: [{ msg: { id: "m1", role: "assistant" }, blocks: [], index: 0 }],
      toc: {
        filterIds: new Set(["agent_message", "tool:bash", "tool:read"]),
        counts: { user: 0, agent_message: 2, thinking: 0, plan: 0, tools_all: 8 },
        tools: [
          { id: "tool:bash", toolKey: "bash", label: "Bash", count: 2, kind: "execute" },
          { id: "tool:read", toolKey: "read", label: "Read", count: 6, kind: "read" },
        ],
        maxToolCount: 6,
        totalUnitCount: 10,
      },
      fileChangeSummary: { read: [], edit: [], write: [], delete: [] },
      resolveMessageIndex: vi.fn(),
      select: vi.fn(() => ({
        messages: [],
        visibleUnitCount: 0,
        timelineEntries: [],
        resolveListIndex: vi.fn(),
      })),
    });
    const session: Api.SessionDetail = {
      reference: { agentName: "codex", sessionId: "s1" },
      id: "s1",
      slug: "codex/s1",
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

    return render(<SessionDetail session={session} agentCatalog={createAgentCatalog([])} />);
  }

  it("renders the filter aside with the tool group", () => {
    renderFiltered();

    expect(screen.getByRole("checkbox", { name: "All tools" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Read" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });

  it("surfaces a removable chip and the hidden-count footer once a tool is filtered out", () => {
    renderFiltered();
    fireEvent.click(screen.getByRole("checkbox", { name: "Bash" }));

    expect(screen.getByRole("button", { name: "Remove filter Read" })).toBeTruthy();
    expect(screen.getByText(/2 hidden by filters \(Bash 2\)/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter Read" }));
    expect(screen.getByRole("checkbox", { name: "Read" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(screen.getByText(/8 hidden by filters/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show all" }));

    expect(screen.getByRole("checkbox", { name: "Read" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "Show all" })).toBeNull();
  });
});
