import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMessageTimeline, VIRTUALIZED_TIMELINE_THRESHOLD } from "./session-message-timeline";
import type { SessionTimelineEntry } from "./timeline";
import { createTimelineAnchorRegistry } from "./timeline-anchor-registry";

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
  const view = render(
    <SessionMessageTimeline
      entries={timelineEntries}
      anchorRegistry={createTimelineAnchorRegistry()}
      onNavigate={onNavigate}
    />,
  );
  const timeline = view.getByRole("navigation", { name: "Session message timeline" });
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
  return { ...view, onNavigate, timeline, track };
}

describe("SessionMessageTimeline", () => {
  it("tags read, write, and execute tools with distinct timeline kinds", () => {
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

    expect(getByRole("button", { name: "Go to Read · Read" }).dataset.timelineKind).toBe(
      "tool-read",
    );
    expect(getByRole("button", { name: "Go to Write · Edit" }).dataset.timelineKind).toBe(
      "tool-write",
    );
    expect(getByRole("button", { name: "Go to Execute · Bash" }).dataset.timelineKind).toBe(
      "tool-execute",
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
    expect(track.style.gridTemplateColumns).toBe("");
    expect(track.querySelectorAll("[data-timeline-index]")).toHaveLength(34);
    const firstSegment = track.firstElementChild as HTMLElement;
    expect(firstSegment.style.position).toBe("absolute");
    expect(firstSegment.style.top).toBe("0px");
    expect(firstSegment.style.bottom).toBe("0px");
    expect(firstSegment.style.width).toBe("calc(1% - 0.99px)");

    fireEvent.click(getByRole("button", { name: "Scroll timeline right" }));

    expect(timeline.scrollLeft).toBe(225);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("bounds segment DOM to the horizontal window while preserving full-track pointer mapping", () => {
    const longEntries = Array.from({ length: VIRTUALIZED_TIMELINE_THRESHOLD * 25 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { onNavigate, timeline, track } = renderTimeline(longEntries);
    const scrollWidth = 21_999;
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 330 },
      scrollWidth: { configurable: true, value: scrollWidth },
      scrollLeft: { configurable: true, value: 11_000, writable: true },
    });
    Object.defineProperty(track, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: -11_000, width: scrollWidth }),
    });

    fireEvent.scroll(timeline);

    const segments = track.querySelectorAll<HTMLElement>("[data-timeline-index]");
    expect(segments).toHaveLength(43);
    expect(segments.length).toBeLessThan(VIRTUALIZED_TIMELINE_THRESHOLD);
    expect(segments[0]?.dataset.timelineIndex).toBe("994");
    expect(segments[42]?.dataset.timelineIndex).toBe("1036");
    expect(segments[0]?.parentElement?.style.left).toContain("49.7%");

    fireEvent.click(track, { clientX: 100, detail: 1 });

    expect(onNavigate).toHaveBeenCalledWith(longEntries[1_009], "smooth");
  });

  it("keeps every virtualized entry reachable by keyboard", async () => {
    const longEntries = Array.from({ length: VIRTUALIZED_TIMELINE_THRESHOLD * 25 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const { onNavigate, timeline, track } = renderTimeline(longEntries);
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 330 },
      scrollWidth: { configurable: true, value: 21_999 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(timeline);
    const firstSegment = track.querySelector<HTMLButtonElement>("[data-timeline-index='0']")!;

    firstSegment.focus();
    fireEvent.keyDown(firstSegment, { key: "End" });

    await waitFor(() => {
      expect((document.activeElement as HTMLElement).dataset.timelineIndex).toBe("1999");
    });
    fireEvent.click(document.activeElement!, { detail: 0 });

    expect(onNavigate).toHaveBeenCalledWith(longEntries[1_999], "auto");
    expect(track.querySelectorAll("[data-timeline-index]").length).toBeLessThan(
      VIRTUALIZED_TIMELINE_THRESHOLD,
    );
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
        anchor.id = entry.anchorId;
        detail.appendChild(anchor);
        return [entry.anchorId, anchor] as const;
      }),
    );

    const anchorRegistry = createTimelineAnchorRegistry();
    anchorElements.forEach((anchor, anchorId) => anchorRegistry.register(anchorId, anchor));
    render(
      <SessionMessageTimeline
        entries={entries}
        anchorRegistry={anchorRegistry}
        onNavigate={vi.fn()}
      />,
      { container: detail },
    );

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

  it("tracks anchors mounted and unmounted by the virtual message list", () => {
    IntersectionObserverMock.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    const anchorRegistry = createTimelineAnchorRegistry();
    render(
      <SessionMessageTimeline
        entries={entries}
        anchorRegistry={anchorRegistry}
        onNavigate={vi.fn()}
      />,
    );
    const observer = IntersectionObserverMock.instances[0]!;
    const anchor = document.createElement("div");

    act(() => anchorRegistry.register("agent-1", anchor));
    expect(observer.targets.has(anchor)).toBe(true);

    act(() => anchorRegistry.register("agent-1", null));
    expect(observer.targets.has(anchor)).toBe(false);
  });

  it("reveals an active entry outside the virtualized render range", async () => {
    IntersectionObserverMock.instances = [];
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("innerHeight", 400);
    vi.stubGlobal("scrollY", 300);
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 1_000,
    });
    const longEntries = Array.from({ length: VIRTUALIZED_TIMELINE_THRESHOLD * 25 }, (_, index) => ({
      ...entries[index % entries.length]!,
      id: `entry-${index}`,
      anchorId: `entry-${index}`,
    }));
    const detail = document.createElement("div");
    detail.setAttribute("data-testid", "session-detail");
    const anchor = document.createElement("div");
    anchor.id = "entry-1500";
    anchor.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    detail.appendChild(anchor);
    document.body.appendChild(detail);

    const anchorRegistry = createTimelineAnchorRegistry();
    anchorRegistry.register("entry-1500", anchor);
    const view = render(
      <SessionMessageTimeline
        entries={longEntries}
        anchorRegistry={anchorRegistry}
        onNavigate={vi.fn()}
      />,
      { container: detail },
    );
    const timeline = view.getByRole("navigation", { name: "Session message timeline" });
    const track = view.getByTestId("session-timeline-track");
    Object.defineProperties(timeline, {
      clientWidth: { configurable: true, value: 330 },
      scrollWidth: { configurable: true, value: 21_999 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(timeline);

    act(() => {
      IntersectionObserverMock.instances[0]!.trigger([{ target: anchor, isIntersecting: true }]);
    });

    await waitFor(() => {
      expect(
        track.querySelector('[data-timeline-index="1500"]')?.getAttribute("aria-current"),
      ).toBe("location");
    });
    expect(timeline.scrollLeft).toBeGreaterThan(0);
    expect(track.querySelectorAll("[data-timeline-index]").length).toBeLessThan(
      VIRTUALIZED_TIMELINE_THRESHOLD,
    );

    detail.remove();
  });
});
