import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionFilterPanel } from "./filter-panel";
import { useSessionFilters } from "./use-session-filters";
import type { SessionDetailToc, ToolFilterItem } from "./toc";

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

function toolCheckboxNames() {
  return TOOLS.filter((tool) => screen.queryByRole("checkbox", { name: tool.label })).map(
    (tool) => tool.label,
  );
}

afterEach(cleanup);

describe("SessionFilterPanel", () => {
  it("renders every content kind and tool with its count", () => {
    render(<Harness />);

    expect(checkbox("你的消息").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Agent 回复")).toBeTruthy();
    expect(toolCheckboxNames()).toEqual(["Bash", "Edit", "Grep", "Read", "Write"]);
    expect(screen.getByText("5 / 5 选中")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("reports the tool parent as mixed once part of the subset is off", () => {
    render(<Harness />);
    const parent = checkbox("全部工具");
    expect(parent.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(checkbox("Grep"));
    fireEvent.click(checkbox("Bash"));

    expect(parent.getAttribute("aria-checked")).toBe("mixed");
    expect(screen.getByText("3 / 5 选中")).toBeTruthy();

    fireEvent.click(parent);
    expect(parent.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(parent);
    expect(parent.getAttribute("aria-checked")).toBe("false");
  });

  it("narrows the tool list by query without changing any checked state", () => {
    render(<Harness />);
    fireEvent.click(checkbox("Grep"));

    fireEvent.change(screen.getByRole("searchbox", { name: "过滤工具名" }), {
      target: { value: "re" },
    });

    expect(toolCheckboxNames()).toEqual(["Grep", "Read"]);
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Read").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("4 / 5 选中")).toBeTruthy();
  });

  it("scopes the quick actions to the queried subset", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("searchbox", { name: "过滤工具名" }), {
      target: { value: "re" },
    });

    fireEvent.click(screen.getByRole("button", { name: "全不选（当前 2 项）" }));

    expect(screen.getByText("3 / 5 选中")).toBeTruthy();
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("Read").getAttribute("aria-checked")).toBe("false");
  });

  it("keeps only the write tools behind 只看写操作", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "只看写操作" }));

    expect(checkbox("Edit").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Write").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("Bash").getAttribute("aria-checked")).toBe("false");
    expect(checkbox("你的消息").getAttribute("aria-checked")).toBe("true");
  });

  it("collapses the tool group without losing the selection", () => {
    render(<Harness />);
    fireEvent.click(checkbox("Grep"));
    const header = screen.getByRole("button", { expanded: true });

    fireEvent.click(header);
    expect(screen.queryByRole("searchbox", { name: "过滤工具名" })).toBeNull();

    fireEvent.click(header);
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("false");
  });

  it("restores every filter and clears the query on 重置", () => {
    render(<Harness />);
    fireEvent.click(checkbox("思考过程"));
    fireEvent.click(screen.getByRole("button", { name: "只看写操作" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "过滤工具名" }), {
      target: { value: "wr" },
    });

    fireEvent.click(screen.getByRole("button", { name: "重置" }));

    expect(checkbox("思考过程").getAttribute("aria-checked")).toBe("true");
    expect(checkbox("全部工具").getAttribute("aria-checked")).toBe("true");
    expect(toolCheckboxNames()).toEqual(["Bash", "Edit", "Grep", "Read", "Write"]);
  });

  it("names the tools the current filter hides", () => {
    render(<Harness />);
    fireEvent.click(checkbox("Grep"));
    fireEvent.click(checkbox("Bash"));

    expect(screen.getByText(/隐藏了 Bash、Grep/)).toBeTruthy();
  });

  it("rebuilds the filter set when the session changes", () => {
    const { rerender } = render(<Harness sessionId="s1" />);
    fireEvent.click(checkbox("Grep"));
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("false");

    rerender(<Harness sessionId="s2" />);
    expect(checkbox("Grep").getAttribute("aria-checked")).toBe("true");
  });
});
