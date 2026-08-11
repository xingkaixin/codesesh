import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
import { DEFAULT_BAR_LAYOUT, useBarField, type BarHover } from "./useBarField";

const WIDTH = 400;
const HEIGHT = 200;

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

let hitTest: (x: number, y: number) => BarHover | null;
let canvas: StubbedCanvas;

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
  hitTest = field.hitTest;

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
});
