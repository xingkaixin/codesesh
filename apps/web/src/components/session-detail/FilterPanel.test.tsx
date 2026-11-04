import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@codesesh/contract";
import { buildSessionDetailDisplayModel } from "./display-model";
import { SessionFilterPanel } from "./FilterPanel";
import { deriveSelectedFilters } from "./filter-state";
import { useSessionFilters } from "./useSessionFilters";
import {
  buildSessionDetailToc,
  filterSessionMessages,
  type SessionDetailToc,
  type ToolFilterItem,
} from "./toc";

const TOOLS: ToolFilterItem[] = [
  { id: "tool:bash", toolKey: "bash", label: "Bash", count: 4, kind: "execute" },
  { id: "tool:edit", toolKey: "edit", label: "Edit", count: 2, kind: "write" },
  { id: "tool:grep", toolKey: "grep", label: "Grep", count: 9, kind: "execute" },
  { id: "tool:read", toolKey: "read", label: "Read", count: 6, kind: "read" },
  { id: "tool:write", toolKey: "write", label: "Write", count: 1, kind: "write" },
];

const toc: SessionDetailToc = {
  filterIds: new Set<string>([
    "user",
    "agent_message",
    "thinking",
    "plan",
    ...TOOLS.map((tool) => tool.id),
  ]),
  counts: { user: 3, agent_message: 5, thinking: 2, plan: 1, tools_all: 22 },
  tools: TOOLS,
  maxToolCount: 9,
  totalUnitCount: 33,
};

function Harness({ sessionId = "s1" }: { sessionId?: string }) {
  const { state, actions } = useSessionFilters(toc, sessionId);
  return <SessionFilterPanel toc={toc} state={state} actions={actions} visibleUnitCount={20} />;
}

function checkbox(name: string) {
  return screen.getByRole("checkbox", { name });
}

afterEach(cleanup);

describe("SessionFilterPanel", () => {
  it("keeps only the write tools behind Writes only", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Writes only" }));

    expect(checkbox("Edit").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Write").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Bash").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Your messages").getAttribute("aria-checked")).toBe("true");
  });

  it("rebuilds the filter set when the session changes", () => {
    const { rerender } = render(<Harness sessionId="s1" />);
    fireEvent.click(checkbox("Grep"));
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("false");

    rerender(<Harness sessionId="s2" />);
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("true");
  });

  it("shows new replies, content kinds and tools as the same session grows", () => {
    const initial: Message[] = [
      { id: "question", role: "user", time_created: 1, parts: [{ type: "text", text: "Help" }] },
    ];
    const next: Message[] = [
      ...initial,
      {
        id: "reply",
        role: "assistant",
        time_created: 2,
        parts: [
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "Thinking" },
          { type: "plan", text: "Plan", approval_status: "success" },
          { type: "tool", tool: "Read", state: { status: "completed", input: { path: "a.ts" } } },
        ],
      },
    ];
    const models = buildSessionDetailDisplayModel({
      messages: next,
      agentName: "claudecode",
    }).messages;
    const nextToc = buildSessionDetailToc(models);
    const { result, rerender } = renderHook(
      ({ messages }) => {
        const display = buildSessionDetailDisplayModel({ messages, agentName: "claudecode" });
        return useSessionFilters(buildSessionDetailToc(display.messages), "same-session");
      },
      { initialProps: { messages: initial } },
    );

    rerender({ messages: next });

    const visible = filterSessionMessages(
      models,
      deriveSelectedFilters(nextToc, result.current.state.excluded),
    );
    expect(visible.messages.map(({ msg }) => msg.id)).toEqual(["question", "reply"]);
    expect(visible.visibleUnitCount).toBe(nextToc.totalUnitCount);
    expect(visible.visibleUnitCount).toBe(5);
  });

  it("preserves explicit exclusions while new categories appear and old ones return", () => {
    const initialToc: SessionDetailToc = {
      ...toc,
      filterIds: new Set(["user", "tool:read"]),
      counts: { user: 1, agent_message: 0, thinking: 0, plan: 0, tools_all: 1 },
      tools: TOOLS.filter(({ toolKey }) => toolKey === "read"),
      totalUnitCount: 2,
    };
    const { result, rerender } = renderHook(
      ({ currentToc }) => useSessionFilters(currentToc, "same-session"),
      {
        initialProps: { currentToc: initialToc },
      },
    );
    act(() => {
      result.current.actions.toggleContentKind("user");
      result.current.actions.toggleTool("tool:read");
    });

    rerender({ currentToc: buildSessionDetailToc([]) });
    rerender({ currentToc: toc });

    const selected = deriveSelectedFilters(toc, result.current.state.excluded);
    expect(selected.has("user")).toBe(false);
    expect(selected.has("tool:read")).toBe(false);
    expect(selected.has("agent_message")).toBe(true);
    expect(selected.has("tool:write")).toBe(true);
    act(() => result.current.actions.resetAll());
    expect(deriveSelectedFilters(toc, result.current.state.excluded)).toEqual(toc.filterIds);
  });
});
