import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bootstrapSource from "../../public/theme-bootstrap.js?raw";
import { useUiPreferences, type Theme } from "./useUiPreferences";

// public/ sits outside tsconfig, so nothing links the bootstrap's hardcoded
// storage key / envelope shape / theme literals to useUiPreferences. This
// contract test persists preferences through the hook's own path and then
// executes the real bootstrap source against the result — a version bump or
// key rename that degrades every dark-theme user to a light-palette flash
// fails here instead of shipping silently.

function runBootstrap(prefersDark: boolean): boolean {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: prefersDark })),
  );
  document.documentElement.classList.remove("dark");
  // eslint-disable-next-line no-eval -- executing the shipped inline script verbatim
  (0, eval)(bootstrapSource);
  return document.documentElement.classList.contains("dark");
}

function persistTheme(theme: Theme): void {
  const { result, unmount } = renderHook(() => useUiPreferences());
  act(() => result.current.setTheme(theme));
  unmount();
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

describe("theme-bootstrap ↔ useUiPreferences contract", () => {
  it("applies a persisted dark theme before hydration", () => {
    persistTheme("dark");
    expect(runBootstrap(false)).toBe(true);
  });

  it("keeps a persisted light theme light even when the OS prefers dark", () => {
    persistTheme("light");
    expect(runBootstrap(true)).toBe(false);
  });

  it("follows the OS preference for the system theme", () => {
    persistTheme("system");
    expect(runBootstrap(true)).toBe(true);
    expect(runBootstrap(false)).toBe(false);
  });

  it("falls back to system when nothing was persisted", () => {
    expect(runBootstrap(true)).toBe(true);
  });
});
