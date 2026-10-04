import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames, stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
import { useTileField } from "./useTileField";

const WIDTH = 360;
const HEIGHT = 80;

let canvas: StubbedCanvas;

function Harness({
  values,
  max,
  reducedMotion = true,
}: {
  values: number[];
  max: number;
  reducedMotion?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useTileField(ref, { values, max, reducedMotion });

  return (
    <div>
      <canvas ref={ref} />
    </div>
  );
}

beforeEach(() => {
  canvas = stubCanvas({ width: WIDTH, height: HEIGHT });
});

afterEach(() => {
  cleanup();
  canvas.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useTileField", () => {
  it("stops after reshaping and wakes locally without rereading its palette", () => {
    const frames = stubAnimationFrames();
    const readStyle = vi.spyOn(window, "getComputedStyle");
    const { container, rerender } = render(
      <Harness values={[1, 1]} max={1} reducedMotion={false} />,
    );
    const host = container.querySelector("canvas")!.parentElement!;
    let now = performance.now() + 1_000;

    act(() => frames.runNext(now));
    expect(frames.pendingCount()).toBe(0);
    expect(readStyle).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 180, clientY: 40 }));
    expect(frames.pendingCount()).toBe(0);

    host.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 40 }));
    expect(frames.pendingCount()).toBe(1);
    act(() => frames.runNext((now += 50)));
    expect(readStyle).toHaveBeenCalledTimes(1);

    host.dispatchEvent(new MouseEvent("pointerleave"));
    rerender(<Harness values={[0.5, 0.5]} max={1} reducedMotion={false} />);
    expect(frames.pendingCount()).toBe(1);

    act(() => canvas.resize());
    expect(frames.pendingCount()).toBe(1);
  });
});
