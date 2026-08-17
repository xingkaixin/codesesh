import { cleanup, fireEvent, renderHook } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult, SessionHead } from "../lib/api";
import type { ViewState } from "../lib/view-state";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

afterEach(cleanup);

function makeSession(id: string): SessionHead {
  return {
    reference: { agentName: "codex", sessionId: id },
    id,
    slug: `codex/${id}`,
    title: id,
    directory: "/workspace",
    time_created: 1,
    stats: {
      message_count: 1,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost: 0,
    },
  };
}

const sessions = [makeSession("s1"), makeSession("s2"), makeSession("s3")];
const searchResults: SearchResult[] = sessions.slice(0, 2).map((session) => ({
  reference: { agentName: "Codex", sessionId: session.id },
  session,
  snippet: session.title,
  snippetHighlights: [],
  matchType: "title",
}));

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    viewState: {
      mode: "root",
      activeAgentKey: null,
      activeSessionId: null,
    } satisfies ViewState,
    navigate: vi.fn() as unknown as NavigateFunction,
    selectedProjectNavigationIdentity: null,
    shortcutHelpOpen: false,
    setShortcutHelpOpen: vi.fn(),
    dismissShortcutHint: vi.fn(),
    isSearchMode: false,
    activeSearchQuery: "needle",
    searchResults,
    selectedSearchIndex: 0,
    setSelectedSearchIndex: vi.fn(),
    clearSearchInput: vi.fn(),
    openSearch: vi.fn(),
    closeSearch: vi.fn(),
    ...overrides,
  };
}

function dispatchKey(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts", () => {
  it("opens search and shortcut help from global commands", () => {
    const deps = makeDeps();
    renderHook(() => useKeyboardShortcuts(deps));

    expect(dispatchKey("k", { metaKey: true }).defaultPrevented).toBe(true);
    expect(deps.openSearch).toHaveBeenCalledOnce();
    expect(deps.setSelectedSearchIndex).toHaveBeenCalledWith(0);

    expect(dispatchKey("/").defaultPrevented).toBe(true);
    expect(deps.openSearch).toHaveBeenCalledTimes(2);
    expect(deps.dismissShortcutHint).toHaveBeenCalledOnce();

    expect(dispatchKey("?").defaultPrevented).toBe(true);
    expect(deps.setShortcutHelpOpen).toHaveBeenCalledWith(true);
    expect(deps.dismissShortcutHint).toHaveBeenCalledTimes(2);
  });

  it("ignores modified, composing, and already-handled events", () => {
    const deps = makeDeps();
    renderHook(() => useKeyboardShortcuts(deps));

    dispatchKey("?", { altKey: true });
    dispatchKey("?", { isComposing: true });
    const handled = new KeyboardEvent("keydown", { key: "?", bubbles: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);

    expect(deps.setShortcutHelpOpen).not.toHaveBeenCalled();
  });

  it("closes help and protects keyboard input in editable controls", () => {
    const helpDeps = makeDeps({ shortcutHelpOpen: true });
    const { unmount } = renderHook(() => useKeyboardShortcuts(helpDeps));

    dispatchKey("j");
    expect(dispatchKey("Escape").defaultPrevented).toBe(true);
    expect(helpDeps.setShortcutHelpOpen).toHaveBeenCalledWith(false);
    unmount();

    const editableDeps = makeDeps();
    renderHook(() => useKeyboardShortcuts(editableDeps));
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();

    fireEvent.keyDown(input, { key: "j" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(document.activeElement).not.toBe(input);
    input.remove();
  });

  it("backs out of search and session views", () => {
    const searchDeps = makeDeps({ isSearchMode: true });
    const { unmount } = renderHook(() => useKeyboardShortcuts(searchDeps));

    dispatchKey("Escape");
    expect(searchDeps.closeSearch).toHaveBeenCalledOnce();
    expect(searchDeps.clearSearchInput).toHaveBeenCalledOnce();
    unmount();

    const projectDeps = makeDeps({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "s1",
      } satisfies ViewState,
      selectedProjectNavigationIdentity: { kind: "path" as const, key: "/workspace" },
    });
    const projectHook = renderHook(() => useKeyboardShortcuts(projectDeps));
    dispatchKey("Escape");
    expect(projectDeps.navigate).toHaveBeenCalledWith("/projects/path/%2Fworkspace");
    projectHook.unmount();

    const agentDeps = makeDeps({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "s1",
      } satisfies ViewState,
    });
    renderHook(() => useKeyboardShortcuts(agentDeps));
    dispatchKey("Escape");
    expect(agentDeps.navigate).toHaveBeenCalledWith("/codex");
  });

  it("moves through search results and opens the selected result", () => {
    const deps = makeDeps({ isSearchMode: true, selectedSearchIndex: 1 });
    renderHook(() => useKeyboardShortcuts(deps));

    dispatchKey("j");
    const moveDown = deps.setSelectedSearchIndex.mock.calls[0]?.[0] as (value: number) => number;
    expect(moveDown(1)).toBe(1);
    dispatchKey("k");
    const moveUp = deps.setSelectedSearchIndex.mock.calls[1]?.[0] as (value: number) => number;
    expect(moveUp(0)).toBe(0);
    dispatchKey("g");
    dispatchKey("G");
    expect(deps.setSelectedSearchIndex).toHaveBeenNthCalledWith(3, 0);
    expect(deps.setSelectedSearchIndex).toHaveBeenNthCalledWith(4, 1);

    expect(dispatchKey("Enter").defaultPrevented).toBe(true);
    expect(deps.closeSearch).toHaveBeenCalledOnce();
    expect(deps.navigate).toHaveBeenCalledWith("/codex/s2", {
      state: { searchQuery: "needle" },
    });
  });

  it("does nothing without navigable search results", () => {
    const deps = makeDeps({
      isSearchMode: true,
      searchResults: [],
    });
    renderHook(() => useKeyboardShortcuts(deps));

    dispatchKey("j");
    dispatchKey("Enter");

    expect(deps.navigate).not.toHaveBeenCalled();
  });
});
