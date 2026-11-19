import { useEffect } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "./useTranscriptScroll";

function Transcript({
  revision,
  followTail = true,
  layoutVersion = 0,
  onCaptureReady,
}: {
  revision: number;
  followTail?: boolean;
  layoutVersion?: number;
  onCaptureReady?: (capture: () => void) => void;
}) {
  const { containerRef, captureAnchor } = useTranscriptScroll(revision, followTail, layoutVersion);
  useEffect(() => {
    onCaptureReady?.(captureAnchor);
  }, [captureAnchor, onCaptureReady]);
  return (
    <div ref={containerRef}>
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

it("does not fight user scrolling on ResizeObserver height changes, while compensating shifts above the anchor", () => {
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
  let contentTop = 0;
  // Simulate real browser geometry where viewport top = contentTop - parent.scrollTop.
  vi.spyOn(firstRow, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        top: contentTop - parent.scrollTop,
        bottom: contentTop - parent.scrollTop + 400,
      }) as DOMRect,
  );

  // User scrolls down while rows below grow container height (contentTop of firstRow unchanged).
  parent.scrollTop = 300;
  fireEvent.scroll(parent);
  height = 2400;
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });

  expect(scrollTo).not.toHaveBeenCalled();

  // When rows above the visible anchor shrink (e.g. virtualized row measurements after a hash jump),
  // scrollTop adjusts by the exact delta so the anchor stays in the viewport.
  contentTop = -140;
  act(() => {
    resizeCallback?.([], {} as ResizeObserver);
  });

  expect(scrollTo).toHaveBeenCalledWith({ top: 160, behavior: "auto" });
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

it("keeps a jumped-to virtualized target in view when newly mounted rows above shrink", () => {
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
  let height = 140000;
  Object.defineProperty(parent, "scrollHeight", { get: () => height });
  Object.defineProperty(parent, "clientHeight", { value: 720 });
  parent.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object" && options.top != null) parent.scrollTop = options.top;
  };

  let flushCapture = () => {};
  let targetContentTop = 131000;
  const view = render(
    <Transcript
      revision={0}
      layoutVersion={0}
      onCaptureReady={(fn) => {
        flushCapture = fn;
      }}
    />,
    { container: parent },
  );
  const firstRow = view.getByText("First 0");
  vi.spyOn(firstRow, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        top: targetContentTop - parent.scrollTop,
        bottom: targetContentTop - parent.scrollTop + 90,
      }) as DOMRect,
  );

  // Jump to distant row (simulating scrollToIndex + scrollIntoView) before rAF capture runs.
  parent.scrollTop = 130700;
  fireEvent.scroll(parent);
  expect(targetContentTop - parent.scrollTop).toBe(300);

  // Measurement commit flushes capture before updating row positions (-1140px shrink above).
  flushCapture();
  targetContentTop -= 1140;
  height -= 1140;
  view.rerender(
    <Transcript
      revision={0}
      layoutVersion={1}
      onCaptureReady={(fn) => {
        flushCapture = fn;
      }}
    />,
  );

  // Target stays at the exact same viewport offset (300px) inside the 720px viewport.
  expect(parent.scrollTop).toBe(129560);
  expect(targetContentTop - parent.scrollTop).toBe(300);
  view.unmount();
  parent.remove();
});
