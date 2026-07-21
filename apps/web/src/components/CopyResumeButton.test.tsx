import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyResumeButton } from "./CopyResumeButton";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CopyResumeButton", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("announces and resets the copy confirmation via the live region", async () => {
    vi.useFakeTimers();
    render(
      <CopyResumeButton agentName="claudecode" sessionId="abc-123" directory="/tmp/project" />,
    );

    const button = screen.getByRole("button", { name: /Copy resume command/ });
    const liveRegion = button.querySelector('[aria-live="polite"]');
    expect(liveRegion?.textContent).toBe("");

    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });

    expect(liveRegion?.textContent).toBe("Resume command copied");
    expect(screen.getByRole("button", { name: /Resume command copied/ })).toBeTruthy();

    act(() => vi.advanceTimersByTime(1500));

    expect(liveRegion?.textContent).toBe("");
  });
});
