import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion";

function mockMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const media = {
    matches,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);

  return {
    set(next: boolean) {
      media.matches = next;
      for (const listener of listeners) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("usePrefersReducedMotion", () => {
  it("reports the current preference", () => {
    mockMedia(true);

    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(true);
  });

  it("follows the preference and stops listening on unmount", () => {
    const media = mockMedia(false);
    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => media.set(true));
    expect(result.current).toBe(true);

    unmount();
    expect(media.listenerCount).toBe(0);
  });
});
