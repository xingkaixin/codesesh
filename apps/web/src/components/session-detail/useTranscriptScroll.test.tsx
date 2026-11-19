import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "./useTranscriptScroll";

function Transcript({ revision, followTail = true }: { revision: number; followTail?: boolean }) {
  const ref = useTranscriptScroll(revision, followTail);
  return (
    <div ref={ref}>
      <div data-message-id="first">First {revision}</div>
      <div data-message-id="second">Second {revision}</div>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("coalesces rapid scroll events into one animation-frame anchor capture", () => {
  vi.useFakeTimers();
  const rafQueue: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  Object.defineProperty(parent, "scrollHeight", { value: 2000 });
  Object.defineProperty(parent, "clientHeight", { value: 400 });

  const view = render(<Transcript revision={0} />, { container: parent });
  const container = view.container.firstElementChild as HTMLElement;
  const querySpy = vi.spyOn(container, "querySelectorAll");

  fireEvent.scroll(parent);
  fireEvent.scroll(parent);
  fireEvent.scroll(parent);

  expect(querySpy).not.toHaveBeenCalled();
  expect(rafQueue).toHaveLength(1);

  act(() => {
    rafQueue.shift()?.(16);
  });

  expect(querySpy).toHaveBeenCalledTimes(1);
  view.unmount();
  parent.remove();
});

it("does not fight active user scrolling when ResizeObserver fires", () => {
  vi.useFakeTimers();
  let resizeCallback: ResizeObserverCallback | null = null;
  class StubResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", StubResizeObserver);

  const rafQueue: FrameRequestCallback[] = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  let height = 2000;
  Object.defineProperty(parent, "scrollHeight", { get: () => height });
  Object.defineProperty(parent, "clientHeight", { value: 400 });
  const scrollTo = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object") parent.scrollTop = options.top ?? parent.scrollTop;
  });
  parent.scrollTo = scrollTo;

  const view = render(<Transcript revision={0} />, { container: parent });
  const firstRow = view.getByText("First 0");
  let firstTop = 0;
  vi.spyOn(firstRow, "getBoundingClientRect").mockImplementation(
    () => ({ top: firstTop, bottom: firstTop + 100 }) as DOMRect,
  );

  // User scrolls down while virtualized rows mount and shift container height.
  parent.scrollTop = 300;
  fireEvent.scroll(parent);
  height = 2400;
  firstTop = 80;
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });

  expect(scrollTo).not.toHaveBeenCalled();

  // Flush the coalesced rAF capture and let active scroll settle.
  act(() => {
    while (rafQueue.length > 0) rafQueue.shift()?.(16);
    vi.advanceTimersByTime(200);
  });

  // After scrolling settles, an unexpected layout shift restores the anchored row.
  firstTop = 140;
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });

  expect(scrollTo).toHaveBeenCalledWith({ top: 360, behavior: "auto" });
  view.unmount();
  parent.remove();
});

it("keeps history pages in place and follows live appends after reaching the end", () => {
  const parent = document.createElement("div");
  parent.style.overflowY = "auto";
  document.body.append(parent);
  let height = 1000;
  Object.defineProperty(parent, "scrollHeight", { get: () => height });
  Object.defineProperty(parent, "clientHeight", { value: 200 });
  parent.scrollTop = 800;
  const scroll = vi.fn((options?: ScrollToOptions | number) => {
    if (typeof options === "object") parent.scrollTop = options.top ?? parent.scrollTop;
  });
  parent.scrollTo = scroll;

  const view = render(<Transcript revision={0} followTail={false} />, { container: parent });
  scroll.mockClear();
  height = 1400;
  view.rerender(<Transcript revision={1} followTail={false} />);
  expect(scroll).not.toHaveBeenCalled();

  act(() => {
    parent.scrollTop = 1200;
    fireEvent.scroll(parent);
  });
  height = 1800;
  view.rerender(<Transcript revision={2} />);
  expect(scroll).not.toHaveBeenCalled();

  act(() => {
    parent.scrollTop = 1600;
    fireEvent.scroll(parent);
  });
  height = 2000;
  view.rerender(<Transcript revision={3} />);
  expect(scroll).toHaveBeenLastCalledWith({ top: 1800, behavior: "auto" });
  view.unmount();
  parent.remove();
});
