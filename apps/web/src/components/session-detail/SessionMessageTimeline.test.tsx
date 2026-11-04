import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import type { SessionTimelineEntry } from "./timeline";
import { createTimelineAnchorRegistry } from "./TimelineAnchorRegistry";

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
    kind: "tool-read",
    anchorId: "tool-1",
    messageIndex: 2,
    tooltip: "Read · Read",
  },
];

afterEach(cleanup);

function renderTimeline(timelineEntries = entries) {
  const onNavigate = vi.fn();
  const view = render(
    <SessionMessageTimeline
      entries={timelineEntries}
      anchorRegistry={createTimelineAnchorRegistry()}
      onNavigate={onNavigate}
    />,
  );
  const track = view.getByTestId("session-timeline-track");
  Object.defineProperties(track, {
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ left: 0, width: 300 }),
    },
    hasPointerCapture: { value: () => false },
    releasePointerCapture: { value: vi.fn() },
    setPointerCapture: { value: vi.fn() },
  });
  return { ...view, onNavigate };
}

describe("SessionMessageTimeline", () => {
  it("keeps a color block clickable after a pointer press", () => {
    const { getAllByRole, onNavigate } = renderTimeline();
    const target = getAllByRole("button")[2]!;

    fireEvent.pointerDown(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.click(target, { clientX: 250, detail: 1 });

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(entries[2], "smooth");
  });
});
