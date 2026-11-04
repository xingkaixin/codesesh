import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

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
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: This media-query fixture implements the state and listener methods used by the hook.
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
  it("reacts to matchMedia change events while on the system theme", () => {
    const media = mockMatchMedia(false);
    const { result, rerender } = renderHook(() => useTheme("system"));
    expect(result.current).toBe("light");

    act(() => media.emitChange(true));
    rerender();

    expect(result.current).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
