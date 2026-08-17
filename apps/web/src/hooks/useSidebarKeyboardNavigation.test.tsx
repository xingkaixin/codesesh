import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionIdentity } from "@codesesh/core/contract";
import type { SessionHead } from "../lib/api";
import { buildSidebarSessionLookup, getSessionReferenceKey } from "../lib/session-indexes";
import type { ViewState } from "../lib/view-state";
import { useSidebarKeyboardNavigation } from "./useSidebarKeyboardNavigation";

afterEach(cleanup);

function makeSession(id: string, agentName = "codex"): SessionHead {
  return {
    ...createSessionIdentity({ agentName, sessionId: id }),
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

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    viewState: {
      mode: "root",
      activeAgentKey: null,
      activeSessionId: null,
    } satisfies ViewState,
    sessions,
    sessionLookup: buildSidebarSessionLookup(sessions),
    isSearchMode: false,
    shortcutHelpOpen: false,
    dismissShortcutHint: vi.fn(),
    onOpenSession: vi.fn(),
    ...overrides,
  };
}

function dispatchKey(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => window.dispatchEvent(event));
  return event;
}

describe("useSidebarKeyboardNavigation", () => {
  it("keeps j/k selection local and opens the selected session", () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useSidebarKeyboardNavigation(deps));

    expect(dispatchKey("j").defaultPrevented).toBe(true);
    expect(result.current.selectedSessionReference).toBe("codex/s1");
    dispatchKey("G");
    expect(result.current.selectedSessionReference).toBe("codex/s3");
    dispatchKey("k");
    expect(result.current.selectedSessionReference).toBe("codex/s2");
    dispatchKey("g");
    expect(result.current.selectedSessionReference).toBe("codex/s1");

    expect(dispatchKey("Enter").defaultPrevented).toBe(true);
    expect(deps.onOpenSession).toHaveBeenCalledWith(sessions[0]);
  });

  it("uses the session reference when native ids overlap", () => {
    const codex = makeSession("same");
    const claude = makeSession("same", "claude");
    const projectSessions = [codex, claude];
    const deps = makeDeps({
      sessions: projectSessions,
      sessionLookup: buildSidebarSessionLookup(projectSessions),
      viewState: {
        mode: "session",
        activeAgentKey: "claude",
        activeSessionId: "same",
      } satisfies ViewState,
    });
    const { result } = renderHook(() => useSidebarKeyboardNavigation(deps));

    expect(result.current.selectedSessionReference).toBe(getSessionReferenceKey(claude));
    dispatchKey("Enter");
    expect(deps.onOpenSession).toHaveBeenCalledWith(claude);
  });

  it("does not handle keys while search, help, or an editable control is active", () => {
    const searchDeps = makeDeps({ isSearchMode: true });
    const { result, unmount } = renderHook(() => useSidebarKeyboardNavigation(searchDeps));
    dispatchKey("j");
    expect(result.current.selectedSessionReference).toBeNull();
    unmount();

    const helpDeps = makeDeps({ shortcutHelpOpen: true });
    const helpHook = renderHook(() => useSidebarKeyboardNavigation(helpDeps));
    dispatchKey("j");
    expect(helpHook.result.current.selectedSessionReference).toBeNull();
    helpHook.unmount();

    const deps = makeDeps();
    renderHook(() => useSidebarKeyboardNavigation(deps));
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "j" });
    expect(deps.dismissShortcutHint).not.toHaveBeenCalled();
    input.remove();
  });
});
