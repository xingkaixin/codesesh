import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";
import type { Theme } from "./useUiPreferences";

function mockMatchMedia(initialMatches: boolean) {
  let changeListener: ((event: MediaQueryListEvent) => void) | null = null;
  const mediaQueryList = {
    matches: initialMatches,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_event: string, listener: (event: MediaQueryListEvent) => void) => {
      changeListener = listener;
    }),
    removeEventListener: vi.fn(() => {
      changeListener = null;
    }),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(mediaQueryList as unknown as MediaQueryList);
  return {
    emitChange(matches: boolean) {
      mediaQueryList.matches = matches;
      changeListener?.({ matches } as MediaQueryListEvent);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.classList.remove("dark");
});

describe("useTheme", () => {
  it("applies the .dark class for the dark theme", () => {
    mockMatchMedia(false);
    renderHook(() => useTheme("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("removes the .dark class for the light theme", () => {
    mockMatchMedia(true);
    document.documentElement.classList.add("dark");
    renderHook(() => useTheme("light"));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("follows the OS preference for the system theme", () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme("system"));
    expect(result.current).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("reacts to matchMedia change events while on the system theme", () => {
    const media = mockMatchMedia(false);
    const { result, rerender } = renderHook(() => useTheme("system"));
    expect(result.current).toBe("light");

    act(() => media.emitChange(true));
    rerender();

    expect(result.current).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("ignores matchMedia changes once the theme is no longer system", () => {
    const media = mockMatchMedia(false);
    const { rerender, unmount } = renderHook(({ theme }: { theme: Theme }) => useTheme(theme), {
      initialProps: { theme: "system" },
    });
    rerender({ theme: "light" });
    unmount();

    act(() => media.emitChange(true));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("returns the effective theme unchanged for explicit light/dark", () => {
    mockMatchMedia(false);
    const { result: lightResult } = renderHook(() => useTheme("light"));
    expect(lightResult.current).toBe("light");

    const { result: darkResult } = renderHook(() => useTheme("dark"));
    expect(darkResult.current).toBe("dark");
  });
});
