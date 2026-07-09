import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessageTimeline } from "./session-message-timeline";
import type { SessionTimelineEntry } from "./timeline";

const entries: SessionTimelineEntry[] = [
  {
    id: "user-1",
    kind: "user",
    anchorId: "user-1",
    messageIndex: 0,
    tooltip: "User · First",
  },
  {
    id: "agent-1",
    kind: "agent",
    anchorId: "agent-1",
    messageIndex: 1,
    tooltip: "Agent · Second",
  },
  {
    id: "tool-1",
    kind: "tool",
    anchorId: "tool-1",
    messageIndex: 2,
    tooltip: "Tool · Read",
  },
];

afterEach(cleanup);

function renderTimeline(timelineEntries = entries) {
  const onNavigate = vi.fn();
  const view = render(<SessionMessageTimeline entries={timelineEntries} onNavigate={onNavigate} />);
  const timeline = view.getByRole("navigation", { name: "Session message timeline" });
  const track = view.getByTestId("session-timeline-track");
  Object.defineProperties(track, {
    getBoundingClientRect: {
      value: () => ({ left: 0, width: 300 }),
    },
    hasPointerCapture: { value: () => false },
    releasePointerCapture: { value: vi.fn() },
    setPointerCapture: { value: vi.fn() },
  });
  return { ...view, onNavigate, timeline, track };
}

describe("SessionMessageTimeline", () => {
  it("keeps a color block clickable after a pointer press", () => {
    const { getAllByRole, onNavigate } = renderTimeline();
    const target = getAllByRole("button")[2]!;

    fireEvent.pointerDown(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.click(target, { clientX: 250 });

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(entries[2], "smooth");
  });

  it("maps clicks between blocks to the timeline position", () => {
    const { onNavigate, track } = renderTimeline();

    fireEvent.click(track, { clientX: 250 });

    expect(onNavigate).toHaveBeenCalledWith(entries[2], "smooth");
  });

  it("captures the pointer only after drag intent is clear", () => {
    const { getAllByRole, onNavigate, track } = renderTimeline();
    const target = getAllByRole("button")[0]!;

    fireEvent.pointerDown(target, { button: 0, clientX: 10, pointerId: 1 });
    expect(track.setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerMove(track, { clientX: 250, pointerId: 1 });

    expect(track.setPointerCapture).toHaveBeenCalledWith(1);
    expect(onNavigate).toHaveBeenCalledWith(entries[2], "auto");
  });

  it("preserves a readable segment width and exposes horizontal scrolling", () => {
    const longEntries = Array.from({ length: 100 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { getByRole, onNavigate, timeline, track } = renderTimeline(longEntries);
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1_099 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(timeline);

    expect(timeline.className).toContain("overflow-x-auto");
    expect(timeline.className).toContain("overflow-y-hidden");
    expect(track.style.minWidth).toBe("1099px");
    expect(track.style.gridTemplateColumns).toBe("repeat(100, minmax(10px, 1fr))");

    fireEvent.click(getByRole("button", { name: "Scroll timeline right" }));

    expect(timeline.scrollLeft).toBe(225);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("renders one unclipped tooltip and hides it while scrolling", () => {
    const { getAllByRole, getByRole, queryByRole, timeline } = renderTimeline();
    const target = getAllByRole("button")[1]!;

    fireEvent.pointerEnter(target);

    const tooltip = getByRole("tooltip");
    expect(tooltip.textContent).toBe("Agent · Second");
    expect(tooltip.parentElement).toBe(document.body);

    fireEvent.scroll(timeline);
    expect(queryByRole("tooltip")).toBeNull();
  });

  it("keeps a focused tooltip aligned while the timeline scrolls", () => {
    const { getAllByRole, getByRole, timeline } = renderTimeline();
    const target = getAllByRole("button")[1]!;

    target.focus();
    fireEvent.scroll(timeline);

    expect(getByRole("tooltip").textContent).toBe("Agent · Second");
  });
});
