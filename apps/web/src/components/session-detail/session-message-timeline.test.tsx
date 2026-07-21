import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessageTimeline } from "./session-message-timeline";
import type { SessionTimelineEntry } from "./timeline";

// Mirrors the ResizeObserverMock pattern used in message-list.test.tsx: a controllable
// stand-in so tests can drive which anchors are "visible" without a real layout engine.
class IntersectionObserverMock {
  static instances: IntersectionObserverMock[] = [];

  readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    IntersectionObserverMock.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  trigger(changes: Array<{ target: Element; isIntersecting: boolean }>) {
    this.callback(
      changes as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
  it("uses distinct colors for read, write, and execute tools", () => {
    const toolEntries: SessionTimelineEntry[] = [
      { ...entries[2]!, id: "read", anchorId: "read", kind: "tool-read", tooltip: "Read · Read" },
      {
        ...entries[2]!,
        id: "write",
        anchorId: "write",
        kind: "tool-write",
        tooltip: "Write · Edit",
      },
      {
        ...entries[2]!,
        id: "execute",
        anchorId: "execute",
        kind: "tool-execute",
        tooltip: "Execute · Bash",
      },
    ];
    const { getByRole } = renderTimeline(toolEntries);

    expect(getByRole("button", { name: "Go to Read · Read" }).className).toContain(
      "--timeline-tool-read",
    );
    expect(getByRole("button", { name: "Go to Write · Edit" }).className).toContain(
      "--timeline-tool-write",
    );
    expect(getByRole("button", { name: "Go to Execute · Bash" }).className).toContain(
      "--timeline-tool-execute",
    );
  });

  it("keeps a color block clickable after a pointer press", () => {
    const { getAllByRole, onNavigate } = renderTimeline();
    const target = getAllByRole("button")[2]!;

    fireEvent.pointerDown(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerUp(target, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.click(target, { clientX: 250, detail: 1 });

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(entries[2], "smooth");
  });

  it("maps clicks between blocks to the timeline position", () => {
    const { onNavigate, track } = renderTimeline();

    fireEvent.click(track, { clientX: 250, detail: 1 });

    expect(onNavigate).toHaveBeenCalledWith(entries[2], "smooth");
  });

  it("uses immediate scrolling for keyboard activation", () => {
    const { getAllByRole, onNavigate } = renderTimeline();
    const target = getAllByRole("button")[1]!;

    fireEvent.click(target, { detail: 0 });

    expect(onNavigate).toHaveBeenCalledWith(entries[1], "auto");
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

  it("shows a minimap window mirroring the visible range when the track overflows", () => {
    const longEntries = Array.from({ length: 100 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { getByTestId, timeline } = renderTimeline(longEntries);
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1_200 },
      scrollLeft: { configurable: true, value: 300, writable: true },
    });
    fireEvent.scroll(timeline);

    const window = getByTestId("session-timeline-minimap-window");
    expect(window.style.left).toBe("25%");
    expect(window.style.width).toBe("25%");
  });

  it("scrolls the minimap with standard scrollbar keys", () => {
    const longEntries = Array.from({ length: 100 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { getByTestId, timeline } = renderTimeline(longEntries);
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1_200 },
      scrollLeft: { configurable: true, value: 300, writable: true },
    });
    fireEvent.scroll(timeline);
    const minimap = getByTestId("session-timeline-minimap");

    minimap.focus();
    fireEvent.keyDown(minimap, { key: "ArrowRight" });
    expect(timeline.scrollLeft).toBeGreaterThan(300);
    fireEvent.keyDown(minimap, { key: "Home" });
    expect(timeline.scrollLeft).toBe(0);
    fireEvent.keyDown(minimap, { key: "End" });
    expect(timeline.scrollLeft).toBe(900);
  });

  it("hides the minimap when the track fits the viewport", () => {
    const { queryByTestId, timeline } = renderTimeline();

    fireEvent.scroll(timeline);

    expect(queryByTestId("session-timeline-minimap")).toBeNull();
  });

  it("drags the minimap window to scroll the timeline", () => {
    const longEntries = Array.from({ length: 100 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { getByTestId, timeline } = renderTimeline(longEntries);
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 1_200 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(timeline);

    const minimap = getByTestId("session-timeline-minimap");
    Object.defineProperties(minimap, {
      getBoundingClientRect: {
        value: () => ({ left: 0, width: 300 }),
      },
      hasPointerCapture: { value: () => false },
      releasePointerCapture: { value: vi.fn() },
      setPointerCapture: { value: vi.fn() },
    });

    // Press outside the window: the window centers on the pointer.
    fireEvent.pointerDown(minimap, { button: 0, clientX: 150, pointerId: 1 });
    expect(timeline.scrollLeft).toBe(450);

    fireEvent.pointerMove(minimap, { clientX: 300, pointerId: 1 });
    expect(timeline.scrollLeft).toBe(1_050);
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

  it("derives the active entry from the IntersectionObserver-tracked visible set", async () => {
    IntersectionObserverMock.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    // Mid-scroll geometry: away from both edges so findTimelineEdgeIndex returns null
    // and the visible-set-driven activeIndex logic under test actually runs.
    vi.stubGlobal("innerHeight", 400);
    vi.stubGlobal("scrollY", 300);
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });

    const detail = document.createElement("div");
    detail.setAttribute("data-testid", "session-detail");
    document.body.appendChild(detail);

    const anchorElements = new Map(
      entries.map((entry) => {
        const anchor = document.createElement("div");
        anchor.dataset.sessionTimelineAnchor = entry.anchorId;
        detail.appendChild(anchor);
        return [entry.anchorId, anchor] as const;
      }),
    );

    render(<SessionMessageTimeline entries={entries} onNavigate={vi.fn()} />, {
      container: detail,
    });

    const observer = IntersectionObserverMock.instances[0]!;
    const agentAnchor = anchorElements.get("agent-1")!;
    const toolAnchor = anchorElements.get("tool-1")!;
    agentAnchor.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    toolAnchor.getBoundingClientRect = () => ({ top: 300 }) as DOMRect;

    // Viewport center is 200: only agent-1 (top 100) and tool-1 (top 300) are visible,
    // and agent-1 is the closest one at-or-above center.
    act(() => {
      observer.trigger([
        { target: agentAnchor, isIntersecting: true },
        { target: toolAnchor, isIntersecting: true },
      ]);
    });
    await waitFor(() =>
      expect(document.querySelector('[aria-current="location"]')?.getAttribute("aria-label")).toBe(
        "Go to Agent · Second",
      ),
    );

    // agent-1 scrolls out of view; tool-1 (top 50, now above center) becomes active.
    toolAnchor.getBoundingClientRect = () => ({ top: 50 }) as DOMRect;
    act(() => {
      observer.trigger([
        { target: agentAnchor, isIntersecting: false },
        { target: toolAnchor, isIntersecting: true },
      ]);
    });
    await waitFor(() =>
      expect(document.querySelector('[aria-current="location"]')?.getAttribute("aria-label")).toBe(
        "Go to Read · Read",
      ),
    );

    detail.remove();
  });
});
