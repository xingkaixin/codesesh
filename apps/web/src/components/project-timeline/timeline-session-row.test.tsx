import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSessionTree } from "@codesesh/core/contract";
import { createAgentCatalog } from "../../lib/agents";
import type { TimelineRow } from "../../lib/session-timeline";
import { TimelineSessionRow } from "./timeline-session-row";

const AGENT_CATALOG = createAgentCatalog([
  {
    name: "codex",
    displayName: "Codex",
    count: 2,
    icon: "/icon/agent/codex.svg",
    resumeCommandPrefix: null,
  },
]);

function createRow(overrides: Partial<TimelineRow> = {}): TimelineRow {
  return {
    routeKey: "codex/root",
    reference: { agentName: "codex", sessionId: "root" },
    time: new Date(2026, 7, 6, 9, 5).getTime(),
    title: "Refactor the scanner",
    agentKey: "codex",
    childCount: 0,
    childRoots: [],
    messageCount: 12,
    tokens: 34_000,
    cost: 1.25,
    isOrphan: false,
    ...overrides,
  };
}

const CHILD = buildSessionTree([
  {
    reference: { agentName: "codex", sessionId: "child" },
    title: "Probe the cache",
    directory: "/workspace/a",
    time_created: new Date(2026, 7, 6, 9, 30).getTime(),
    stats: {
      message_count: 3,
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_cost: 0.25,
    },
  },
]).roots[0]!;

afterEach(cleanup);

function renderRow(props: Partial<Parameters<typeof TimelineSessionRow>[0]> = {}) {
  const onToggle = vi.fn();
  const onOpen = vi.fn();
  const view = render(
    <TimelineSessionRow
      row={createRow()}
      mode="collapsed"
      expanded={false}
      agentCatalog={AGENT_CATALOG}
      onToggle={onToggle}
      onOpen={onOpen}
      {...props}
    />,
  );
  return { onToggle, onOpen, view };
}

describe("TimelineSessionRow", () => {
  it("reports the pill's expansion state and the panel it controls", () => {
    const row = createRow({ childCount: 1, childRoots: [CHILD] });
    const { onToggle, view } = renderRow({ row });

    const pill = screen.getByRole("button", { name: /⑂/ });
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Probe the cache")).toBeNull();

    fireEvent.click(pill);
    expect(onToggle).toHaveBeenCalledWith("codex/root");

    view.rerender(
      <TimelineSessionRow
        row={row}
        mode="collapsed"
        expanded
        agentCatalog={AGENT_CATALOG}
        onToggle={onToggle}
        onOpen={vi.fn()}
      />,
    );

    const expandedPill = screen.getByRole("button", { name: /⑂/ });
    expect(expandedPill.getAttribute("aria-expanded")).toBe("true");
    expect(
      document.getElementById(expandedPill.getAttribute("aria-controls") ?? ""),
    ).not.toBeNull();
    expect(screen.getByText("Probe the cache")).not.toBeNull();
  });

  it("opens the session from the title block without toggling the panel", () => {
    const { onOpen, onToggle } = renderRow({
      row: createRow({ childCount: 1, childRoots: [CHILD] }),
    });

    fireEvent.click(screen.getByRole("button", { name: /Refactor the scanner/ }));

    expect(onOpen).toHaveBeenCalledWith({ agentName: "codex", sessionId: "root" });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("opens a sub-session from the child panel", () => {
    const { onOpen } = renderRow({
      row: createRow({ childCount: 1, childRoots: [CHILD] }),
      expanded: true,
    });

    fireEvent.click(screen.getByRole("button", { name: /Probe the cache/ }));

    expect(onOpen).toHaveBeenCalledWith({ agentName: "codex", sessionId: "child" });
  });

  it("marks an orphan row as Unmounted", () => {
    renderRow({ row: createRow({ isOrphan: true }) });

    expect(screen.getByText("Unmounted")).not.toBeNull();
  });

  it("omits the Unmounted badge for a mounted row", () => {
    renderRow();

    expect(screen.queryByText("Unmounted")).toBeNull();
  });

  it("omits a kind badge when the adapter reports none", () => {
    renderRow({ row: createRow({ childCount: 1, childRoots: [CHILD] }), expanded: true });

    const childRow = screen.getByRole("button", { name: /Probe the cache/ });
    expect(childRow.textContent).toBe("09:30Probe the cache3 msgs · $0.25");
  });
});
