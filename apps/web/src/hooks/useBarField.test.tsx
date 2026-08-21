import { createRef, useImperativeHandle, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames, stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
import { columnProgress, DEFAULT_BAR_LAYOUT, useBarField, type BarHover } from "./useBarField";

const WIDTH = 400;
const HEIGHT = 200;

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

const harnessRef = createRef<{ hitTest: (x: number, y: number) => BarHover | null }>();
let canvas: StubbedCanvas;

function hitTest(x: number, y: number) {
  if (!harnessRef.current) throw new Error("Bar field harness is not mounted");
  return harnessRef.current.hitTest(x, y);
}

function Harness({
  values,
  hovered = null,
  reducedMotion = true,
}: {
  values: number[][];
  hovered?: BarHover | null;
  reducedMotion?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const field = useBarField(ref, {
    values,
    axisMax: 100,
    colors: ["var(--chart-1)", "#7c5cff"],
    highlight: "var(--brand)",
    hovered,
    layout: DEFAULT_BAR_LAYOUT,
    reducedMotion,
  });
  useImperativeHandle(harnessRef, () => ({ hitTest: field.hitTest }), [field.hitTest]);

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
});

describe("useBarField", () => {
  it("paints one rounded band per value", () => {
    render(<Harness values={[[100], [50]]} />);

    expect(canvas.context.roundRect).toHaveBeenCalled();
    expect(canvas.context.fill).toHaveBeenCalled();
    // Two columns, each clipped to its band before the tiles are filled.
    expect(canvas.context.clip).toHaveBeenCalledTimes(2);
  });

  it("outlines the hovered band and leaves the others alone", () => {
    render(<Harness values={[[100], [50]]} hovered={{ column: 0, band: 0 }} />);

    expect(canvas.context.stroke).toHaveBeenCalledTimes(1);
  });

  it("skips a zero value instead of drawing a floor-height band", () => {
    render(<Harness values={[[0], [50]]} />);

    expect(canvas.context.clip).toHaveBeenCalledTimes(1);
    expect(hitTest(100, HEIGHT - 2)).toEqual({ column: 0, band: null });
  });

  it("maps a pointer to the column and band under it", () => {
    render(<Harness values={[[50, 50], [50]]} />);

    // Column 0 spans 0..200 with a 76px bar centred at 100; the top band covers
    // the upper half of the two-band stack.
    expect(hitTest(100, 40)).toEqual({ column: 0, band: 1 });
    expect(hitTest(100, 180)).toEqual({ column: 0, band: 0 });
    expect(hitTest(300, 150)).toEqual({ column: 1, band: 0 });
  });

  it("reports the column but no band beside or above a bar", () => {
    render(<Harness values={[[100], [50]]} />);

    expect(hitTest(10, 100)).toEqual({ column: 0, band: null });
    expect(hitTest(300, 20)).toEqual({ column: 1, band: null });
  });

  it("reports nothing outside the plot", () => {
    render(<Harness values={[[100], [50]]} />);

    expect(hitTest(-10, 100)).toBeNull();
    expect(hitTest(WIDTH + 10, 100)).toBeNull();
  });

  it("draws nothing without data", () => {
    render(<Harness values={[]} />);

    expect(canvas.context.roundRect).not.toHaveBeenCalled();
    expect(hitTest(10, 10)).toBeNull();
  });

  it("grows the bars on animation frames when motion is allowed", async () => {
    render(<Harness values={[[100]]} reducedMotion={false} />);
    expect(canvas.context.roundRect).not.toHaveBeenCalled();

    await nextFrame();

    expect(canvas.context.roundRect).toHaveBeenCalled();
  });

  it("stops after growth settles and reuses its resolved palette", () => {
    const frames = stubAnimationFrames();
    const readStyle = vi.spyOn(window, "getComputedStyle");

    render(<Harness values={[[100]]} reducedMotion={false} />);
    expect(frames.pendingCount()).toBe(1);

    act(() => {
      frames.runNext(performance.now() + 1_000);
    });

    expect(canvas.context.clearRect).toHaveBeenCalledTimes(1);
    expect(frames.pendingCount()).toBe(0);
    expect(readStyle).toHaveBeenCalledTimes(1);
  });

  it("wakes a settled field for data, hover, and resize changes", () => {
    const frames = stubAnimationFrames();
    const { rerender } = render(<Harness values={[[100]]} reducedMotion={false} />);
    let now = performance.now() + 1_000;
    act(() => frames.runNext(now));
    expect(frames.pendingCount()).toBe(0);

    rerender(<Harness values={[[50]]} reducedMotion={false} />);
    expect(frames.pendingCount()).toBe(1);
    act(() => frames.runNext((now += 1_000)));
    expect(frames.pendingCount()).toBe(0);

    rerender(<Harness values={[[50]]} hovered={{ column: 0, band: 0 }} reducedMotion={false} />);
    expect(frames.pendingCount()).toBe(1);
    act(() => frames.runNext((now += 16)));
    expect(canvas.context.stroke).toHaveBeenCalled();

    rerender(<Harness values={[[50]]} reducedMotion={false} />);
    expect(frames.pendingCount()).toBe(1);
    act(() => frames.runNext((now += 16)));
    expect(frames.pendingCount()).toBe(0);

    act(() => canvas.resize());
    expect(frames.pendingCount()).toBe(1);
  });
});

describe.each([21, 90])("columnProgress with %i columns", (count) => {
  it("stays finite, bounded, and monotonic for every column", () => {
    const timeline = Array.from({ length: 101 }, (_, step) => step / 100);

    for (let column = 0; column < count; column++) {
      const values = timeline.map((progress) => columnProgress(column, count, progress));

      expect(values.every(Number.isFinite)).toBe(true);
      expect(values.every((value) => value >= 0 && value <= 1)).toBe(true);
      expect(values.at(-1)).toBe(1);
      for (let index = 1; index < values.length; index++) {
        expect(values[index]).toBeGreaterThanOrEqual(values[index - 1]!);
      }
    }
  });
});
