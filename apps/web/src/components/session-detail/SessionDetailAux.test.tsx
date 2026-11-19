import { SAMPLE_SESSION_HEAD } from "@codesesh/contract/test-fixtures";
import type { SessionDetail } from "@codesesh/contract";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredInteractiveReceipt } from "./SessionDetailAux";

const session: SessionDetail = {
  ...SAMPLE_SESSION_HEAD,
  messages: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeferredInteractiveReceipt", () => {
  it("opens and stays open on narrow viewports without force-closing below 1025px", () => {
    const changeListeners = new Set<() => void>();
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
            if (typeof listener === "function")
              changeListeners.add(() => listener(new Event("change")));
          },
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          dispatchEvent: vi.fn(() => true),
        }) as MediaQueryList,
    );

    render(<DeferredInteractiveReceipt session={session} />);

    const trigger = screen.getByRole("button", { name: "Open session receipt" });
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog", { name: "Session Receipt" })).toBeTruthy();

    act(() => {
      for (const listener of changeListeners) listener();
    });

    expect(screen.getByRole("dialog", { name: "Session Receipt" })).toBeTruthy();
  });
});
