import { useEffect, useEffectEvent } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { SearchResult } from "../lib/api";
import { agentRoutePath, sessionRoutePath } from "../lib/session-indexes";
import { isEditableTarget } from "../lib/keyboard";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import type { ViewState } from "../lib/view-state";

interface KeyboardShortcutsDeps {
  viewState: ViewState;
  navigate: NavigateFunction;
  selectedProjectNavigationIdentity: ProjectRouteIdentity | null;
  shortcutHelpOpen: boolean;
  setShortcutHelpOpen: (open: boolean) => void;
  dismissShortcutHint: () => void;
  isSearchMode: boolean;
  activeSearchQuery: string;
  searchResults: SearchResult[];
  selectedSearchIndex: number;
  setSelectedSearchIndex: React.Dispatch<React.SetStateAction<number>>;
  clearSearchInput: () => void;
  openSearch: () => void;
  closeSearch: () => void;
}

/**
 * Owns the global keydown listener: Cmd/Ctrl+K opens search, `/` focuses search,
 * `?` toggles the shortcuts panel, Esc backs out of search/detail/help, and
 * j/k/g/G/Enter move through search results. Sidebar navigation is local to
 * the sidebar so selection does not rerender route content.
 */
export function useKeyboardShortcuts(deps: KeyboardShortcutsDeps) {
  const {
    viewState,
    navigate,
    selectedProjectNavigationIdentity,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    dismissShortcutHint,
    isSearchMode,
    activeSearchQuery,
    searchResults,
    selectedSearchIndex,
    setSelectedSearchIndex,
    clearSearchInput,
    openSearch,
    closeSearch,
  } = deps;

  const handleGlobalKeydown = useEffectEvent((event: KeyboardEvent) => {
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
      setSelectedSearchIndex(0);
      return;
    }

    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.isComposing) return;

    const target = event.target;
    const inEditable = isEditableTarget(target);

    if (shortcutHelpOpen) {
      if (key === "Escape") {
        event.preventDefault();
        setShortcutHelpOpen(false);
      }
      return;
    }

    if (inEditable) {
      if (key === "Escape") {
        event.preventDefault();
        if (target instanceof HTMLElement) target.blur();
      }
      return;
    }

    if (key === "?") {
      event.preventDefault();
      setShortcutHelpOpen(true);
      dismissShortcutHint();
      return;
    }

    if (key === "/") {
      event.preventDefault();
      dismissShortcutHint();
      openSearch();
      return;
    }

    if (key === "Escape") {
      event.preventDefault();
      if (isSearchMode) {
        closeSearch();
        clearSearchInput();
        return;
      }
      if (viewState.mode === "session" && viewState.activeAgentKey) {
        if (selectedProjectNavigationIdentity) {
          navigate(getProjectPath(selectedProjectNavigationIdentity));
          return;
        }
        navigate(agentRoutePath(viewState.activeAgentKey));
      }
      return;
    }

    if (isSearchMode) {
      if (searchResults.length === 0) return;

      if (key === "j") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex((current) => Math.min(current + 1, searchResults.length - 1));
        return;
      }
      if (key === "k") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex((current) => Math.max(current - 1, 0));
        return;
      }
      if (key === "g") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex(0);
        return;
      }
      if (key === "G") {
        event.preventDefault();
        dismissShortcutHint();
        setSelectedSearchIndex(searchResults.length - 1);
        return;
      }
      if (key === "Enter") {
        const result = searchResults[selectedSearchIndex];
        if (!result) return;
        event.preventDefault();
        dismissShortcutHint();
        closeSearch();
        navigate(sessionRoutePath(result.reference), {
          state: { searchQuery: activeSearchQuery },
        });
      }
      return;
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, []);
}
