/**
 * Binds `filter-state.ts` to React state for one session.
 *
 * User exclusions reset only when the session changes. Live toc updates do
 * not change those decisions and provide the current targets for bulk actions.
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
  sessionKey: string,
): { state: SessionFilterState; actions: SessionFilterActions } {
  const [state, setState] = useState(createFilterState);
  const [renderedSessionKey, setRenderedSessionKey] = useState(sessionKey);

  // React's "adjust state during render" pattern: cheaper and flash-free
  // compared with an effect, which would paint the new session once through
  // the previous session's filter set.
  if (renderedSessionKey !== sessionKey) {
    setRenderedSessionKey(sessionKey);
    setState(createFilterState());
  }

  const actions = useMemo<SessionFilterActions>(
    () => ({
      toggleContentKind: (id) => setState((s) => toggleContentKind(s, id)),
      toggleTool: (id) => setState((s) => toggleTool(s, id)),
      setAllTools: (checked) => setState((s) => setAllTools(s, toc, checked)),
      selectWriteToolsOnly: () => setState((s) => selectWriteToolsOnly(s, toc)),
      setToolQuery: (query) => setState((s) => setToolQuery(s, query)),
      toggleToolsExpanded: () => setState((s) => toggleToolsExpanded(s)),
      resetAll: () => setState(resetAll),
    }),
    [toc],
  );

  return { state, actions };
}
