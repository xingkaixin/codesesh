import { useCallback, useEffect, useEffectEvent, useState } from "react";
import type { SessionHead } from "../lib/api";
import { isEditableTarget } from "../lib/keyboard";
import {
  getSessionReferenceKey,
  getSessionRouteKey,
  type SidebarSessionLookup,
} from "../lib/session-indexes";
import type { ViewState } from "../lib/view-state";

interface SidebarKeyboardNavigationOptions {
  viewState: ViewState;
  sessions: SessionHead[];
  sessionLookup: SidebarSessionLookup;
  isSearchMode: boolean;
  shortcutHelpOpen: boolean;
  dismissShortcutHint: () => void;
  onOpenSession: (session: SessionHead) => void;
}

export function useSidebarKeyboardNavigation({
  viewState,
  sessions,
  sessionLookup,
  isSearchMode,
  shortcutHelpOpen,
  dismissShortcutHint,
  onOpenSession,
}: SidebarKeyboardNavigationOptions) {
  const [selectedSessionReference, setSelectedSessionReference] = useState<string | null>(null);

  useEffect(() => {
    if (isSearchMode) return;
    if (viewState.mode === "session") {
      setSelectedSessionReference(
        getSessionRouteKey(viewState.activeAgentKey, viewState.activeSessionId),
      );
      return;
    }
    setSelectedSessionReference(null);
  }, [isSearchMode, viewState.mode, viewState.activeAgentKey, viewState.activeSessionId]);

  const selectSession = useCallback((session: SessionHead) => {
    setSelectedSessionReference(getSessionReferenceKey(session));
  }, []);

  const handleKeydown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing || isEditableTarget(event.target)) return;
    if (isSearchMode || shortcutHelpOpen || sessions.length === 0) return;

    const moveSelection = (offset: number) => {
      dismissShortcutHint();
      const currentIndex =
        selectedSessionReference == null
          ? -1
          : (sessionLookup.indexByReference.get(selectedSessionReference) ?? -1);
      const baseIndex = currentIndex >= 0 ? currentIndex : offset >= 0 ? -1 : sessions.length;
      const nextIndex = Math.max(0, Math.min(baseIndex + offset, sessions.length - 1));
      const nextSession = sessions[nextIndex];
      setSelectedSessionReference(nextSession ? getSessionReferenceKey(nextSession) : null);
    };

    if (event.key === "j") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "k") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "g") {
      event.preventDefault();
      dismissShortcutHint();
      const first = sessions[0];
      setSelectedSessionReference(first ? getSessionReferenceKey(first) : null);
      return;
    }
    if (event.key === "G") {
      event.preventDefault();
      dismissShortcutHint();
      const last = sessions.at(-1);
      setSelectedSessionReference(last ? getSessionReferenceKey(last) : null);
      return;
    }
    if (event.key !== "Enter" || selectedSessionReference == null) return;

    const selected = sessionLookup.byReference.get(selectedSessionReference);
    if (!selected) return;
    event.preventDefault();
    dismissShortcutHint();
    onOpenSession(selected);
  });

  useEffect(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

  return { selectedSessionReference, selectSession };
}
