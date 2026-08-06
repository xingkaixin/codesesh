/**
 * Pure reducers and derivations behind the reader's two-level content filter.
 * No React: the hook in `use-session-filters.ts` only binds these to state.
 *
 * `selected` holds content-kind ids and `tool:<key>` ids. It NEVER holds
 * `tools_all` — the tool group's tri-state is derived from the tool subset,
 * so the two can no longer drift apart.
 */
import {
  TOC_CONTENT_FILTER_IDS,
  type SessionDetailToc,
  type TocContentFilterId,
  type ToolFilterItem,
} from "./toc";

export interface SessionFilterState {
  selected: Set<string>;
  toolQuery: string;
  toolsExpanded: boolean;
}

export type ToolsParentState = "all" | "none" | "partial";

export function createFilterState(toc: SessionDetailToc): SessionFilterState {
  return { selected: new Set(toc.filterIds), toolQuery: "", toolsExpanded: true };
}

function toggleId(state: SessionFilterState, id: string): SessionFilterState {
  const selected = new Set(state.selected);
  if (!selected.delete(id)) selected.add(id);
  return { ...state, selected };
}

export function toggleContentKind(
  state: SessionFilterState,
  id: TocContentFilterId,
): SessionFilterState {
  return toggleId(state, id);
}

export function toggleTool(state: SessionFilterState, id: `tool:${string}`): SessionFilterState {
  return toggleId(state, id);
}

export function setAllTools(
  state: SessionFilterState,
  toc: SessionDetailToc,
  checked: boolean,
): SessionFilterState {
  const selected = new Set(state.selected);
  for (const tool of deriveVisibleTools(toc, state)) {
    if (checked) selected.add(tool.id);
    else selected.delete(tool.id);
  }
  return { ...state, selected };
}

export function selectWriteToolsOnly(
  state: SessionFilterState,
  toc: SessionDetailToc,
): SessionFilterState {
  const selected = new Set(state.selected);
  for (const tool of toc.tools) {
    if (tool.kind === "write") selected.add(tool.id);
    else selected.delete(tool.id);
  }
  return { ...state, selected };
}

export function setToolQuery(state: SessionFilterState, toolQuery: string): SessionFilterState {
  return { ...state, toolQuery };
}

export function toggleToolsExpanded(state: SessionFilterState): SessionFilterState {
  return { ...state, toolsExpanded: !state.toolsExpanded };
}

export function resetAll(state: SessionFilterState, toc: SessionDetailToc): SessionFilterState {
  return { ...state, selected: new Set(toc.filterIds), toolQuery: "" };
}

export function countSelectedTools(toc: SessionDetailToc, state: SessionFilterState): number {
  return toc.tools.reduce((total, tool) => total + (state.selected.has(tool.id) ? 1 : 0), 0);
}

export function deriveToolsParentState(
  toc: SessionDetailToc,
  state: SessionFilterState,
): ToolsParentState {
  const selected = countSelectedTools(toc, state);
  if (selected === 0) return "none";
  return selected === toc.tools.length ? "all" : "partial";
}

export function deriveVisibleTools(
  toc: SessionDetailToc,
  state: SessionFilterState,
): ToolFilterItem[] {
  const query = state.toolQuery.trim().toLowerCase();
  if (!query) return toc.tools;
  return toc.tools.filter((tool) => tool.label.toLowerCase().includes(query));
}

/** Chips show the *deviation* from all-on: the tools still selected while at
 *  least one is not. With everything on there is nothing to report. */
export function deriveActiveChips(
  toc: SessionDetailToc,
  state: SessionFilterState,
): Array<{ id: `tool:${string}`; label: string }> {
  if (deriveToolsParentState(toc, state) === "all") return [];
  return toc.tools
    .filter((tool) => state.selected.has(tool.id))
    .map((tool) => ({ id: tool.id, label: tool.label }));
}

export function deriveHiddenTools(
  toc: SessionDetailToc,
  state: SessionFilterState,
): Array<{ label: string; count: number }> {
  return toc.tools
    .filter((tool) => !state.selected.has(tool.id))
    .map((tool) => ({ label: tool.label, count: tool.count }));
}

export function deriveHiddenCount(toc: SessionDetailToc, state: SessionFilterState): number {
  let hidden = 0;
  for (const id of TOC_CONTENT_FILTER_IDS) {
    if (!state.selected.has(id)) hidden += toc.counts[id];
  }
  for (const tool of toc.tools) {
    if (!state.selected.has(tool.id)) hidden += tool.count;
  }
  return hidden;
}
