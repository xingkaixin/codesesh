/**
 * Binds `filter-state.ts` to React state for one session.
 *
 * The filter set is rebuilt on `sessionId` change only. Keying it on the toc
 * would reset it on every live-sync rebuild (`toc.filterIds` is a fresh Set
 * each time), which silently threw away the reader's filters.
 */
import { useMemo, useState } from "react";

import {
  createFilterState,
  resetAll,
  selectWriteToolsOnly,
  setAllTools,
  setToolQuery,
  toggleContentKind,
  toggleTool,
  toggleToolsExpanded,
  type SessionFilterState,
} from "./filter-state";
import type { SessionDetailToc, TocContentFilterId } from "./toc";

export interface SessionFilterActions {
  toggleContentKind(id: TocContentFilterId): void;
  toggleTool(id: `tool:${string}`): void;
  setAllTools(checked: boolean): void;
  selectWriteToolsOnly(): void;
  setToolQuery(query: string): void;
  toggleToolsExpanded(): void;
  resetAll(): void;
}

export function useSessionFilters(
  toc: SessionDetailToc,
  sessionId: string,
): { state: SessionFilterState; actions: SessionFilterActions } {
  const [state, setState] = useState(() => createFilterState(toc));
  const [renderedSessionId, setRenderedSessionId] = useState(sessionId);

  // React's "adjust state during render" pattern: cheaper and flash-free
  // compared with an effect, which would paint the new session once through
  // the previous session's filter set.
  if (renderedSessionId !== sessionId) {
    setRenderedSessionId(sessionId);
    setState(createFilterState(toc));
  }

  const actions = useMemo<SessionFilterActions>(
    () => ({
      toggleContentKind: (id) => setState((s) => toggleContentKind(s, id)),
      toggleTool: (id) => setState((s) => toggleTool(s, id)),
      setAllTools: (checked) => setState((s) => setAllTools(s, toc, checked)),
      selectWriteToolsOnly: () => setState((s) => selectWriteToolsOnly(s, toc)),
      setToolQuery: (query) => setState((s) => setToolQuery(s, query)),
      toggleToolsExpanded: () => setState((s) => toggleToolsExpanded(s)),
      resetAll: () => setState((s) => resetAll(s, toc)),
    }),
    [toc],
  );

  return { state, actions };
}
