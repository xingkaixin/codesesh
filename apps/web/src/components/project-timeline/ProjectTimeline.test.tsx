import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionHead } from "@codesesh/core/contract";
import { createAgentCatalog } from "../../lib/agents";
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
  it("summarises main and sub sessions in the header", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    expect(screen.getByText("2 主会话 · 1 子会话 · 450 tokens")).not.toBeNull();
    expect(screen.getByRole("region", { name: "workspace-a 时间线" })).not.toBeNull();
  });

  it("keeps a mounted child off the main axis and marks the parent as inclusive", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    const parent = screen.getByRole("button", { name: /Refactor the scanner/ });
    expect(parent.textContent).toContain("含 1 子会话");
    expect(parent.textContent).toContain("8 msgs");
    expect(screen.getByText(/含子/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
  });

  it("omits the 含子 suffixes for a childless session", () => {
    renderTimeline([SOLO]);

    const row = screen.getByRole("button", { name: /Tidy the docs/ });
    expect(row.textContent).not.toContain("含");
    expect(screen.queryByText(/含子/)).toBeNull();
  });

  it("expands one row at a time in 折叠 mode without navigating", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));

    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/projects/a");
  });

  it("expands every row in 全部展开 mode and restores per-row state when returning to 折叠", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("radio", { name: "全部展开" }));
    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "折叠" }));
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
  });

  it("keeps a row opened in 折叠 mode open after a round trip through 全部展开", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));
    fireEvent.click(screen.getByRole("radio", { name: "全部展开" }));
    fireEvent.click(screen.getByRole("radio", { name: "折叠" }));

    expect(screen.getByRole("button", { name: /Probe the cache/ })).not.toBeNull();
  });

  it("hides the pill and panel in 隐藏 mode without changing the parent's numbers", () => {
    renderTimeline([PARENT, CHILD, SOLO]);

    fireEvent.click(screen.getByRole("button", { name: /⑂/ }));
    fireEvent.click(screen.getByRole("radio", { name: "隐藏" }));

    expect(screen.queryByRole("button", { name: /⑂/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Probe the cache/ })).toBeNull();
    const parent = screen.getByRole("button", { name: /Refactor the scanner/ });
    expect(parent.textContent).toContain("含 1 子会话");
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
    expect(screen.getByText("未挂载")).not.toBeNull();
    expect(screen.getByText("未挂载子会话 1 · 父会话文件已不存在")).not.toBeNull();
  });

  it("omits the orphan note when everything is mounted", () => {
    renderTimeline([PARENT, CHILD]);

    expect(screen.queryByText(/未挂载子会话/)).toBeNull();
  });
});
