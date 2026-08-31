/**
 * Pure reducers and derivations behind the reader's two-level content filter.
 * No React: the hook in `use-session-filters.ts` only binds these to state.
 *
 * Only explicit exclusions are stored. New content kinds and tools remain
 * visible when a live session grows; selection is derived from its current toc.
 */
import {
  TOC_CONTENT_FILTER_IDS,
  type SessionDetailToc,
  type TocContentFilterId,
  type ToolFilterItem,
} from "./toc";

export interface SessionFilterState {
  excluded: Set<string>;
  toolQuery: string;
  toolsExpanded: boolean;
}

export type ToolsParentState = "all" | "none" | "partial";

export function createFilterState(): SessionFilterState {
  return { excluded: new Set(), toolQuery: "", toolsExpanded: true };
}

export function deriveSelectedFilters(
  toc: SessionDetailToc,
  excluded: ReadonlySet<string>,
): Set<string> {
  return new Set([...toc.filterIds].filter((id) => !excluded.has(id)));
}

function toggleId(state: SessionFilterState, id: string): SessionFilterState {
  const excluded = new Set(state.excluded);
  if (!excluded.delete(id)) excluded.add(id);
  return { ...state, excluded };
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
  const excluded = new Set(state.excluded);
  for (const tool of deriveVisibleTools(toc, state)) {
    if (checked) excluded.delete(tool.id);
    else excluded.add(tool.id);
  }
  return { ...state, excluded };
}

export function selectWriteToolsOnly(
  state: SessionFilterState,
  toc: SessionDetailToc,
): SessionFilterState {
  const excluded = new Set(state.excluded);
  for (const tool of toc.tools) {
    if (tool.kind === "write") excluded.delete(tool.id);
    else excluded.add(tool.id);
  }
  return { ...state, excluded };
}

export function setToolQuery(state: SessionFilterState, toolQuery: string): SessionFilterState {
  return { ...state, toolQuery };
}

export function toggleToolsExpanded(state: SessionFilterState): SessionFilterState {
  return { ...state, toolsExpanded: !state.toolsExpanded };
}

export function resetAll(state: SessionFilterState): SessionFilterState {
  return { ...state, excluded: new Set(), toolQuery: "" };
}

export function countSelectedTools(toc: SessionDetailToc, state: SessionFilterState): number {
  return toc.tools.reduce((total, tool) => total + (state.excluded.has(tool.id) ? 0 : 1), 0);
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
    .filter((tool) => !state.excluded.has(tool.id))
    .map((tool) => ({ id: tool.id, label: tool.label }));
}

export function deriveHiddenTools(
  toc: SessionDetailToc,
  state: SessionFilterState,
): Array<{ label: string; count: number }> {
  return toc.tools
    .filter((tool) => state.excluded.has(tool.id))
    .map((tool) => ({ label: tool.label, count: tool.count }));
}

export function deriveHiddenCount(toc: SessionDetailToc, state: SessionFilterState): number {
  let hidden = 0;
  for (const id of TOC_CONTENT_FILTER_IDS) {
    if (state.excluded.has(id)) hidden += toc.counts[id];
  }
  for (const tool of toc.tools) {
    if (state.excluded.has(tool.id)) hidden += tool.count;
  }
  return hidden;
}
