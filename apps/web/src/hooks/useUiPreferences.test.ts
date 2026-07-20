import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_SHORTCUT_HINT_STORAGE_KEY,
  UI_PREFERENCES_STORAGE_KEY,
  parseUiPreferences,
  useUiPreferences,
} from "./useUiPreferences";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUiPreferences", () => {
  it("uses defaults on first render", () => {
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.shortcutHintDismissed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("hydrates valid preferences synchronously", () => {
    window.localStorage.setItem(
      UI_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: { shortcutHintDismissed: true, sidebarCollapsed: true },
      }),
    );

    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.shortcutHintDismissed).toBe(true);
    expect(result.current.sidebarCollapsed).toBe(true);
  });

  it("persists semantic actions across hook instances", () => {
    const first = renderHook(() => useUiPreferences());
    act(() => {
      first.result.current.dismissShortcutHint();
      first.result.current.setSidebarCollapsed(true);
    });
    first.unmount();

    const second = renderHook(() => useUiPreferences());
    expect(second.result.current.shortcutHintDismissed).toBe(true);
    expect(second.result.current.sidebarCollapsed).toBe(true);
  });

  it("imports the legacy shortcut preference", () => {
    window.localStorage.setItem(LEGACY_SHORTCUT_HINT_STORAGE_KEY, "1");
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.shortcutHintDismissed).toBe(true);
  });

  it.each([
    "not-json",
    JSON.stringify({ version: 2, state: {} }),
    JSON.stringify({
      version: 1,
      state: { shortcutHintDismissed: "yes", sidebarCollapsed: false },
    }),
  ])("falls back for invalid stored data", (raw) => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, raw);
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.shortcutHintDismissed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("falls back when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.shortcutHintDismissed).toBe(false);
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("keeps in-memory updates when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const { result } = renderHook(() => useUiPreferences());
    act(() => result.current.setSidebarCollapsed(true));
    expect(result.current.sidebarCollapsed).toBe(true);
  });

  it("writes only the versioned preference whitelist", () => {
    const { result } = renderHook(() => useUiPreferences());
    act(() => result.current.dismissShortcutHint());

    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY)!)).toEqual({
      version: 1,
      state: { shortcutHintDismissed: true, sidebarCollapsed: false },
    });
  });
});

describe("parseUiPreferences", () => {
  it("ignores unrelated persisted fields", () => {
    expect(
      parseUiPreferences(
        JSON.stringify({
          version: 1,
          state: {
            shortcutHintDismissed: true,
            sidebarCollapsed: false,
            transientSelection: "session-1",
          },
        }),
      ),
    ).toEqual({ shortcutHintDismissed: true, sidebarCollapsed: false });
  });
});
