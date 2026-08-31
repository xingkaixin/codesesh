import { describe, expect, it } from "vitest";
import {
  countSelectedTools,
  createFilterState,
  deriveActiveChips,
  deriveHiddenCount,
  deriveHiddenTools,
  deriveSelectedFilters,
  deriveToolsParentState,
  deriveVisibleTools,
  resetAll,
  selectWriteToolsOnly,
  setAllTools,
  setToolQuery,
  toggleContentKind,
  toggleTool,
  toggleToolsExpanded,
  type SessionFilterState,
} from "./filter-state";
import type { SessionDetailToc, ToolFilterItem } from "./toc";

const TOOLS: ToolFilterItem[] = [
  { id: "tool:bash", toolKey: "bash", label: "Bash", count: 4, kind: "execute" },
  { id: "tool:edit", toolKey: "edit", label: "Edit", count: 2, kind: "write" },
  { id: "tool:grep", toolKey: "grep", label: "Grep", count: 9, kind: "execute" },
  { id: "tool:read", toolKey: "read", label: "Read", count: 6, kind: "read" },
  { id: "tool:write", toolKey: "write", label: "Write", count: 1, kind: "write" },
];

function createToc(): SessionDetailToc {
  const counts = { user: 3, agent_message: 5, thinking: 2, plan: 1, tools_all: 22 };
  return {
    filterIds: new Set<string>([
      "user",
      "agent_message",
      "thinking",
      "plan",
      ...TOOLS.map((tool) => tool.id),
    ]),
    counts,
    tools: TOOLS,
    maxToolCount: 9,
    totalUnitCount: 33,
  };
}

const toc = createToc();

function selectedIds(state: SessionFilterState) {
  return [...deriveSelectedFilters(toc, state.excluded)].toSorted();
}

describe("createFilterState", () => {
  it("starts with every filter on, no query and the tool group open", () => {
    const state = createFilterState();
    expect(selectedIds(state)).toEqual([...toc.filterIds].toSorted());
    expect(deriveSelectedFilters(toc, state.excluded).has("tools_all")).toBe(false);
    expect(state.toolQuery).toBe("");
    expect(state.toolsExpanded).toBe(true);
  });
});

describe("reducers", () => {
  it("toggles a content kind off and back on without touching tools", () => {
    const off = toggleContentKind(createFilterState(), "thinking");
    expect(selectedIds(off)).not.toContain("thinking");
    expect(countSelectedTools(toc, off)).toBe(TOOLS.length);
    expect(selectedIds(toggleContentKind(off, "thinking"))).toContain("thinking");
  });

  it("toggles a single tool", () => {
    const off = toggleTool(createFilterState(), "tool:grep");
    expect(selectedIds(off)).not.toContain("tool:grep");
    expect(selectedIds(toggleTool(off, "tool:grep"))).toContain("tool:grep");
  });

  it("scopes select-all / clear-all to the queried tool subset", () => {
    const none = setAllTools(createFilterState(), toc, false);
    expect(countSelectedTools(toc, none)).toBe(0);

    const queried = setToolQuery(none, "re");
    expect(deriveVisibleTools(toc, queried).map((tool) => tool.label)).toEqual(["Grep", "Read"]);

    const some = setAllTools(queried, toc, true);
    expect(selectedIds(some).filter((id) => id.startsWith("tool:"))).toEqual([
      "tool:grep",
      "tool:read",
    ]);

    const cleared = setAllTools(some, toc, false);
    expect(countSelectedTools(toc, cleared)).toBe(0);
  });

  it("applies select-all to every tool when the query is empty", () => {
    const none = setAllTools(createFilterState(), toc, false);
    expect(countSelectedTools(toc, setAllTools(none, toc, true))).toBe(TOOLS.length);
  });

  it("selects exactly the write tools and leaves content kinds alone", () => {
    const state = selectWriteToolsOnly(toggleContentKind(createFilterState(), "user"), toc);
    expect(selectedIds(state).filter((id) => id.startsWith("tool:"))).toEqual([
      "tool:edit",
      "tool:write",
    ]);
    expect(selectedIds(state)).toContain("agent_message");
    expect(selectedIds(state)).not.toContain("user");
  });

  it.each([
    { action: "clear all", apply: (state: SessionFilterState) => setAllTools(state, toc, false) },
    {
      action: "writes only",
      apply: (state: SessionFilterState) => selectWriteToolsOnly(state, toc),
    },
  ])("keeps $action limited to tools present when invoked", ({ apply }) => {
    const state = apply(createFilterState());
    const updatedToc = { ...toc, filterIds: new Set([...toc.filterIds, "tool:search"]) };
    const selected = deriveSelectedFilters(updatedToc, state.excluded);

    expect(selected.has("tool:read")).toBe(false);
    expect(selected.has("tool:search")).toBe(true);
  });

  it("stores the tool query and the group collapse flag", () => {
    const queried = setToolQuery(createFilterState(), "Ba");
    expect(queried.toolQuery).toBe("Ba");
    expect(toggleToolsExpanded(queried).toolsExpanded).toBe(false);
  });

  it("resets every filter and the query while keeping the group open state", () => {
    const messy = toggleToolsExpanded(
      setToolQuery(selectWriteToolsOnly(toggleContentKind(createFilterState(), "plan"), toc), "x"),
    );
    const reset = resetAll(messy);
    expect(selectedIds(reset)).toEqual([...toc.filterIds].toSorted());
    expect(reset.toolQuery).toBe("");
    expect(reset.toolsExpanded).toBe(false);
  });
});

describe("deriveToolsParentState", () => {
  it("covers the tri-state truth table", () => {
    const all = createFilterState();
    expect(deriveToolsParentState(toc, all)).toBe("all");
    expect(deriveToolsParentState(toc, toggleTool(all, "tool:grep"))).toBe("partial");
    expect(deriveToolsParentState(toc, setAllTools(all, toc, false))).toBe("none");
  });

  it("reports none when the session used no tools", () => {
    const toolless: SessionDetailToc = { ...toc, tools: [], maxToolCount: 0 };
    expect(deriveToolsParentState(toolless, createFilterState())).toBe("none");
  });
});

describe("deriveVisibleTools", () => {
  it("matches case-insensitively and returns every tool for a blank query", () => {
    const state = createFilterState();
    expect(deriveVisibleTools(toc, state)).toBe(toc.tools);
    expect(deriveVisibleTools(toc, setToolQuery(state, "  ")).length).toBe(TOOLS.length);
    expect(deriveVisibleTools(toc, setToolQuery(state, "wRi")).map((t) => t.label)).toEqual([
      "Write",
    ]);
  });
});

describe("deriveActiveChips", () => {
  it("is empty while every tool is on, and lists the survivors otherwise", () => {
    const all = createFilterState();
    expect(deriveActiveChips(toc, all)).toEqual([]);

    const withoutGrep = toggleTool(all, "tool:grep");
    expect(deriveActiveChips(toc, withoutGrep).map((chip) => chip.label)).toEqual([
      "Bash",
      "Edit",
      "Read",
      "Write",
    ]);

    const readOnly = setAllTools(setToolQuery(setAllTools(all, toc, false), "read"), toc, true);
    expect(deriveActiveChips(toc, readOnly)).toEqual([{ id: "tool:read", label: "Read" }]);
  });
});

describe("hidden derivations", () => {
  it("lists the unselected tools with their counts", () => {
    const state = toggleTool(toggleTool(createFilterState(), "tool:grep"), "tool:bash");
    expect(deriveHiddenTools(toc, state)).toEqual([
      { label: "Bash", count: 4 },
      { label: "Grep", count: 9 },
    ]);
  });

  it("counts hidden units across content kinds and tools", () => {
    const all = createFilterState();
    expect(deriveHiddenCount(toc, all)).toBe(0);
    expect(deriveHiddenCount(toc, toggleContentKind(all, "thinking"))).toBe(toc.counts.thinking);
    expect(deriveHiddenCount(toc, toggleTool(all, "tool:grep"))).toBe(9);
    expect(deriveHiddenCount(toc, setAllTools(all, toc, false))).toBe(toc.counts.tools_all);
  });
});
