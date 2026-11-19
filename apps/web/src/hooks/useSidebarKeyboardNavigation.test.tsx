import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionIdentity, type SessionHead } from "@codesesh/contract";
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

  it("does not hijack Enter when focus is on an interactive control", () => {
    const deps = makeDeps({
      viewState: {
        mode: "session",
        activeAgentKey: "codex",
        activeSessionId: "s1",
      } satisfies ViewState,
    });
    renderHook(() => useSidebarKeyboardNavigation(deps));

    const button = document.createElement("button");
    const link = document.createElement("a");
    link.href = "/projects";
    const menuItem = document.createElement("div");
    menuItem.setAttribute("role", "menuitem");
    document.body.append(button, link, menuItem);

    for (const target of [button, link, menuItem]) {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      act(() => target.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(false);
    }

    expect(deps.onOpenSession).not.toHaveBeenCalled();

    button.remove();
    link.remove();
    menuItem.remove();
  });
});
