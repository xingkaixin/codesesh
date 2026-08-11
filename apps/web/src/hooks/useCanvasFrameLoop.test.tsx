import { useEffect, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames } from "../test/canvas-stub";
import { useCanvasFrameLoop, type CanvasFrameDemand } from "./useCanvasFrameLoop";

function Harness({
  onFrame,
  reducedMotion = false,
}: {
  onFrame: (time: number) => CanvasFrameDemand;
  reducedMotion?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const frames = useCanvasFrameLoop(ref, reducedMotion);

  useEffect(() => {
    frames.setFrameHandler(onFrame);
    return () => frames.setFrameHandler(null);
  }, [frames, onFrame]);

  return <div ref={ref} />;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useCanvasFrameLoop", () => {
  it("runs active frames immediately, throttles idle frames, and stops", () => {
    vi.useFakeTimers();
    const frames = stubAnimationFrames();
    const onFrame = vi
      .fn<() => CanvasFrameDemand>()
      .mockReturnValueOnce("active")
      .mockReturnValueOnce("idle")
      .mockReturnValue("stop");

    render(<Harness onFrame={onFrame} />);
    expect(frames.pendingCount()).toBe(1);

    act(() => frames.runNext(0));
    expect(frames.pendingCount()).toBe(1);

    act(() => frames.runNext(16));
    expect(frames.pendingCount()).toBe(0);

    act(() => vi.advanceTimersByTime(49));
    expect(frames.pendingCount()).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(frames.pendingCount()).toBe(1);

    act(() => frames.runNext(66));
    expect(frames.pendingCount()).toBe(0);
    expect(onFrame).toHaveBeenCalledTimes(3);
  });

  it("suspends frames while offscreen or hidden and wakes when visible", () => {
    let intersectionCallback: IntersectionObserverCallback | undefined;
    let observer: IntersectionObserver | undefined;
    const disconnect = vi.fn();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
          observer = this as unknown as IntersectionObserver;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const frames = stubAnimationFrames();

    render(<Harness onFrame={() => "active"} />);
    expect(frames.pendingCount()).toBe(1);

    act(() => {
      intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry], observer!);
    });
    expect(frames.pendingCount()).toBe(0);

    act(() => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry], observer!);
    });
    expect(frames.pendingCount()).toBe(1);

    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.pendingCount()).toBe(0);

    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(frames.pendingCount()).toBe(1);

    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("does not schedule frames when reduced motion is enabled", () => {
    const frames = stubAnimationFrames();

    render(<Harness onFrame={() => "active"} reducedMotion />);

    expect(frames.pendingCount()).toBe(0);
  });
});
