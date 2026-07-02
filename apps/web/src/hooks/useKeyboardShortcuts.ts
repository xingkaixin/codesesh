import { useEffect, useEffectEvent } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { SearchResult, SessionHead } from "../lib/api";
import type { SidebarSessionLookup } from "../lib/session-indexes";
import { getProjectPath, type ProjectRouteIdentity } from "../lib/projects";
import type { ViewState } from "../lib/view-state";
import type { BrowseBy } from "../components/app/types";

interface KeyboardShortcutsDeps {
  viewState: ViewState;
  browseBy: BrowseBy;
  navigate: NavigateFunction;
  activeAgentKey: string | null;
  sidebarSessions: SessionHead[];
  sidebarSessionLookup: SidebarSessionLookup;
  selectedSidebarSessionId: string | null;
  setSelectedSidebarSessionId: (id: string | null) => void;
  selectedProjectNavigationIdentity: ProjectRouteIdentity | null;
  shortcutHelpOpen: boolean;
  setShortcutHelpOpen: (open: boolean) => void;
  dismissShortcutHint: () => void;
  isSearchMode: boolean;
  activeSearchQuery: string;
  searchResults: SearchResult[];
  selectedSearchIndex: number;
  setSelectedSearchIndex: React.Dispatch<React.SetStateAction<number>>;
  setDraftSearchQuery: (query: string) => void;
  openSearch: () => void;
  closeSearch: () => void;
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable
  );
}

/**
 * Owns the global keydown listener: Cmd/Ctrl+K opens search, `/` focuses search,
 * `?` toggles the shortcuts panel, Esc backs out of search/detail/help, and
 * j/k/g/G/Enter move through either the search results or the sidebar session
 * list depending on the current mode.
 */
export function useKeyboardShortcuts(deps: KeyboardShortcutsDeps) {
  const {
    viewState,
    browseBy,
    navigate,
    activeAgentKey,
    sidebarSessions,
    sidebarSessionLookup,
    selectedSidebarSessionId,
    setSelectedSidebarSessionId,
    selectedProjectNavigationIdentity,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    dismissShortcutHint,
    isSearchMode,
    activeSearchQuery,
    searchResults,
    selectedSearchIndex,
    setSelectedSearchIndex,
    setDraftSearchQuery,
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
        setDraftSearchQuery("");
        return;
      }
      if (viewState.mode === "session" && viewState.activeAgentKey) {
        if (browseBy === "projects" && selectedProjectNavigationIdentity) {
          navigate(getProjectPath(selectedProjectNavigationIdentity));
          return;
        }
        navigate(`/${viewState.activeAgentKey}`);
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
        navigate(`/${result.agentName.toLowerCase()}/${result.session.id}`, {
          state: { searchQuery: activeSearchQuery },
        });
      }
      return;
    }

    if (browseBy === "agents" && !activeAgentKey) return;
    if (sidebarSessions.length === 0) return;

    const moveSidebarSelection = (offset: number) => {
      dismissShortcutHint();
      const currentIndex =
        selectedSidebarSessionId != null
          ? (sidebarSessionLookup.indexById.get(selectedSidebarSessionId) ?? -1)
          : -1;
      const baseIndex =
        currentIndex >= 0 ? currentIndex : offset >= 0 ? -1 : sidebarSessions.length;
      const nextIndex = Math.max(0, Math.min(baseIndex + offset, sidebarSessions.length - 1));
      setSelectedSidebarSessionId(sidebarSessions[nextIndex]?.id ?? null);
    };

    if (key === "j") {
      event.preventDefault();
      moveSidebarSelection(1);
      return;
    }
    if (key === "k") {
      event.preventDefault();
      moveSidebarSelection(-1);
      return;
    }
    if (key === "g") {
      event.preventDefault();
      dismissShortcutHint();
      setSelectedSidebarSessionId(sidebarSessions[0]?.id ?? null);
      return;
    }
    if (key === "G") {
      event.preventDefault();
      dismissShortcutHint();
      setSelectedSidebarSessionId(sidebarSessions.at(-1)?.id ?? null);
      return;
    }
    if (key === "Enter") {
      const selected =
        selectedSidebarSessionId != null
          ? sidebarSessionLookup.byId.get(selectedSidebarSessionId)
          : null;
      if (!selected) return;
      event.preventDefault();
      dismissShortcutHint();
      navigate(browseBy === "projects" ? `/${selected.slug}` : `/${activeAgentKey}/${selected.id}`);
    }
  });

  useEffect(() => {
    window.addEventListener("keydown", handleGlobalKeydown);
    return () => window.removeEventListener("keydown", handleGlobalKeydown);
  }, []);
}
