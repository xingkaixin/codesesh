import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { SessionDetail as SessionDetailData } from "@codesesh/contract";
import { fetchSessionMatches } from "../../lib/api";
import { isEditableTarget } from "../../lib/keyboard";
import type { SessionDetailDisplayModel } from "./display-model";
import type { SessionAnchorScrollBehavior } from "./scroll-behavior";
import {
  collectLoadedSessionFindMatches,
  type LoadedSessionFindMatch,
  type SessionFindMatch,
} from "./session-find";
import type { FilteredSessionMessage } from "./toc";

const REMOTE_MATCH_DEBOUNCE_MS = 120;

interface SessionFindState {
  sessionReference: string;
  open: boolean;
  query: string;
  activeIndex: number;
  pendingSourceMessageIndex: number | null;
}

interface UseSessionFindParams {
  findState: ReturnType<typeof useSessionFindState>;
  session: SessionDetailData;
  sessionReference: string;
  displayModel: SessionDetailDisplayModel;
  filteredMessages: FilteredSessionMessage[];
  effectiveHighlightQuery: string;
  onJumpToLoadedMatch: (
    match: LoadedSessionFindMatch,
    behavior: SessionAnchorScrollBehavior,
  ) => void;
}

function emptyFindState(sessionReference: string): SessionFindState {
  return {
    sessionReference,
    open: false,
    query: "",
    activeIndex: 0,
    pendingSourceMessageIndex: null,
  };
}

export function useSessionFindState(sessionReference: string) {
  const [rawState, setRawState] = useState<SessionFindState>(() =>
    emptyFindState(sessionReference),
  );
  const state =
    rawState.sessionReference === sessionReference ? rawState : emptyFindState(sessionReference);
  return { state, setRawState };
}

export function useSessionFind({
  findState,
  session,
  sessionReference,
  displayModel,
  filteredMessages,
  effectiveHighlightQuery,
  onJumpToLoadedMatch,
}: UseSessionFindParams) {
  const { state, setRawState } = findState;
  const [remoteState, setRemoteState] = useState<{ scope: string; indices: number[] | null }>({
    scope: "",
    indices: [],
  });
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastAutoScrolledScopeRef = useRef("");
  const lastScrolledPendingRef = useRef("");

  const trimmedQuery = state.open ? state.query.trim() : "";
  const messageTotal = session.message_total ?? session.messages.length;
  const isPaged = session.messages.length < messageTotal;
  const queryScope = trimmedQuery ? `${sessionReference}\0${trimmedQuery}` : "";

  const loadedMatches = useMemo(
    () => (trimmedQuery ? collectLoadedSessionFindMatches(filteredMessages, trimmedQuery) : []),
    [filteredMessages, trimmedQuery],
  );

  const agentName = session.reference.agentName;
  const sessionId = session.reference.sessionId;
  const sourceNodeId = session.reference.sourceNodeId;

  useEffect(() => {
    if (!queryScope || !isPaged) return;

    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetchSessionMatches(agentName, sessionId, trimmedQuery, {
        sourceNodeId,
        signal: controller.signal,
      })
        .then((response) => {
          if (controller.signal.aborted) return;
          setRemoteState({ scope: queryScope, indices: response.messageIndices });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setRemoteState({ scope: queryScope, indices: null });
        });
    }, REMOTE_MATCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, agentName, isPaged, queryScope, sessionId, sourceNodeId, trimmedQuery]);

  const unpagedMatches = useMemo<SessionFindMatch[]>(() => {
    if (!queryScope || !isPaged || remoteState.scope !== queryScope) return [];
    const loadedCount = session.messages.length;
    const result: SessionFindMatch[] = [];
    for (const index of remoteState.indices ?? []) {
      if (index >= loadedCount) {
        result.push({ kind: "unpaged", sourceMessageIndex: index });
      }
    }
    return result;
  }, [isPaged, queryScope, remoteState.indices, remoteState.scope, session.messages.length]);

  const matches = useMemo<SessionFindMatch[]>(
    () => [...loadedMatches, ...unpagedMatches],
    [loadedMatches, unpagedMatches],
  );

  const pendingSourceMessageIndex =
    state.pendingSourceMessageIndex != null &&
    state.pendingSourceMessageIndex >= session.messages.length
      ? state.pendingSourceMessageIndex
      : null;

  const arrivedPendingTarget = useMemo(() => {
    if (
      state.pendingSourceMessageIndex == null ||
      state.pendingSourceMessageIndex >= session.messages.length
    ) {
      return null;
    }
    const anchor = displayModel.resolveSourceMessageAnchor(state.pendingSourceMessageIndex);
    if (!anchor) return null;
    const matchIndex = loadedMatches.findIndex(
      (match) => match.displayMessageIndex === anchor.messageIndex,
    );
    const match: LoadedSessionFindMatch =
      matchIndex >= 0
        ? loadedMatches[matchIndex]!
        : { kind: "loaded", displayMessageIndex: anchor.messageIndex, anchorId: anchor.anchorId };
    return {
      key: `${queryScope}\0${state.pendingSourceMessageIndex}`,
      matchIndex,
      match,
    };
  }, [
    displayModel,
    loadedMatches,
    queryScope,
    session.messages.length,
    state.pendingSourceMessageIndex,
  ]);

  const resolvedActiveIndex =
    arrivedPendingTarget && arrivedPendingTarget.matchIndex >= 0
      ? arrivedPendingTarget.matchIndex
      : matches.length === 0
        ? -1
        : Math.min(state.activeIndex, matches.length - 1);
  const activeMatch = resolvedActiveIndex >= 0 ? matches[resolvedActiveIndex] : undefined;
  const activeDisplayMessageIndex =
    arrivedPendingTarget?.match.displayMessageIndex ??
    (activeMatch?.kind === "loaded" ? activeMatch.displayMessageIndex : undefined);
  const remoteLoading = Boolean(queryScope && isPaged) && remoteState.scope !== queryScope;

  const focusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.select();
    });
  }, []);

  const openFind = useCallback(() => {
    setRawState((previous) => {
      const current =
        previous.sessionReference === sessionReference
          ? previous
          : emptyFindState(sessionReference);
      if (!current.open && !current.query && effectiveHighlightQuery) {
        return {
          ...current,
          open: true,
          query: effectiveHighlightQuery,
          activeIndex: 0,
          pendingSourceMessageIndex: null,
        };
      }
      return { ...current, open: true };
    });
    focusInput();
  }, [effectiveHighlightQuery, focusInput, sessionReference, setRawState]);

  const closeFind = useCallback(() => {
    setRawState(emptyFindState(sessionReference));
    lastAutoScrolledScopeRef.current = "";
    lastScrolledPendingRef.current = "";
  }, [sessionReference, setRawState]);

  const updateQuery = useCallback(
    (nextQuery: string) => {
      setRawState({
        sessionReference,
        open: true,
        query: nextQuery,
        activeIndex: 0,
        pendingSourceMessageIndex: null,
      });
      lastScrolledPendingRef.current = "";
    },
    [sessionReference, setRawState],
  );

  const jumpToMatch = useCallback(
    (nextIndex: number, behavior: SessionAnchorScrollBehavior) => {
      const target = matches[nextIndex];
      if (!target) return;
      if (target.kind === "loaded") {
        setRawState((previous) => ({
          ...(previous.sessionReference === sessionReference
            ? previous
            : emptyFindState(sessionReference)),
          open: true,
          activeIndex: nextIndex,
          pendingSourceMessageIndex: null,
        }));
        onJumpToLoadedMatch(target, behavior);
      } else {
        lastScrolledPendingRef.current = "";
        setRawState((previous) => ({
          ...(previous.sessionReference === sessionReference
            ? previous
            : emptyFindState(sessionReference)),
          open: true,
          activeIndex: nextIndex,
          pendingSourceMessageIndex: target.sourceMessageIndex,
        }));
      }
    },
    [matches, onJumpToLoadedMatch, sessionReference, setRawState],
  );

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    if (activeMatch?.kind === "unpaged" && pendingSourceMessageIndex == null) {
      jumpToMatch(resolvedActiveIndex, "smooth");
      return;
    }
    jumpToMatch((resolvedActiveIndex + 1) % matches.length, "smooth");
  }, [activeMatch, jumpToMatch, matches.length, pendingSourceMessageIndex, resolvedActiveIndex]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    if (activeMatch?.kind === "unpaged" && pendingSourceMessageIndex == null) {
      jumpToMatch(resolvedActiveIndex, "smooth");
      return;
    }
    jumpToMatch((resolvedActiveIndex - 1 + matches.length) % matches.length, "smooth");
  }, [activeMatch, jumpToMatch, matches.length, pendingSourceMessageIndex, resolvedActiveIndex]);

  const autoScrollFirstMatch = useEffectEvent(() => {
    if (!queryScope || loadedMatches.length === 0) return;
    if (lastAutoScrolledScopeRef.current === queryScope) return;
    lastAutoScrolledScopeRef.current = queryScope;
    onJumpToLoadedMatch(loadedMatches[0]!, "auto");
  });

  useEffect(() => {
    if (!queryScope) {
      lastAutoScrolledScopeRef.current = "";
      return;
    }
    autoScrollFirstMatch();
  }, [queryScope, loadedMatches.length]);

  const scrollArrivedPendingMatch = useEffectEvent(() => {
    if (!arrivedPendingTarget) return;
    if (lastScrolledPendingRef.current === arrivedPendingTarget.key) return;
    lastScrolledPendingRef.current = arrivedPendingTarget.key;
    onJumpToLoadedMatch(arrivedPendingTarget.match, "auto");
  });

  useEffect(() => {
    scrollArrivedPendingMatch();
  }, [arrivedPendingTarget]);

  const handleWindowKeydown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing) return;
    if (typeof document !== "undefined" && document.querySelector('[role="dialog"]')) return;

    if (state.open && event.key === "Escape") {
      event.preventDefault();
      closeFind();
      return;
    }
    if (!isEditableTarget(event.target) && event.key === "f") {
      event.preventDefault();
      openFind();
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleWindowKeydown, { capture: true });
    return () => window.removeEventListener("keydown", handleWindowKeydown, { capture: true });
  }, []);

  return {
    failed: Boolean(
      queryScope && isPaged && remoteState.scope === queryScope && remoteState.indices === null,
    ),
    retry: () => {
      setRemoteState({ scope: "", indices: [] });
      setAttempt((previous) => previous + 1);
    },
    open: state.open,
    query: state.query,
    trimmedQuery,
    inputRef,
    matchCount: matches.length,
    activeIndex: resolvedActiveIndex,
    activeDisplayMessageIndex,
    pendingSourceMessageIndex,
    searching: remoteLoading || pendingSourceMessageIndex != null,
    openFind,
    closeFind,
    updateQuery,
    goNext,
    goPrev,
  };
}
