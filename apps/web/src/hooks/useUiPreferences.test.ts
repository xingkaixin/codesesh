import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_PREFERENCES_STORAGE_KEY, useUiPreferences } from "./useUiPreferences";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useUiPreferences", () => {
  it.each([
    "not-json",
    JSON.stringify({ version: 2, state: {} }),
    JSON.stringify({
      version: 1,
      state: { sidebarCollapsed: "yes" },
    }),
    JSON.stringify({
      version: 1,
      state: { sidebarCollapsed: false, theme: "blue" },
    }),
  ])("falls back for invalid stored data", (raw) => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, raw);
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.sidebarCollapsed).toBe(false);
  });

  it("falls back when storage reads fail", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useUiPreferences());
    expect(result.current.sidebarCollapsed).toBe(false);
  });
});
