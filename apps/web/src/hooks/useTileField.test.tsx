import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
import { useTileField } from "./useTileField";

const WIDTH = 360;
const HEIGHT = 80;

let canvas: StubbedCanvas;

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

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
});

const CELL = Math.max(3, Math.round(WIDTH / 180));
const GRID_CELLS = Math.ceil(WIDTH / CELL) * Math.ceil(HEIGHT / CELL);

/**
 * Squares painted beyond the resting one every cell always gets. Every draw
 * starts with a clearRect, so that is the frame counter — the field may paint
 * more than one frame per awaited animation frame.
 */
function litCellCount(): number {
  const draws = canvas.context.clearRect.mock.calls.length;
  return canvas.context.fillRect.mock.calls.length - draws * GRID_CELLS;
}

function resetDraws() {
  canvas.context.fillRect.mockClear();
  canvas.context.clearRect.mockClear();
}

async function litInNextFrame(): Promise<number> {
  resetDraws();
  await nextFrame();
  return litCellCount();
}

describe("useTileField", () => {
  it("lays a resting square under every cell of the grid", () => {
    render(<Harness values={[0, 0, 0]} max={1} />);

    expect(litCellCount()).toBe(0);
  });

  it("lights the cells under the curve", () => {
    render(<Harness values={[1, 1, 1]} max={1} />);

    expect(litCellCount()).toBeGreaterThan(0);
  });

  it("lights more of the field as the curve rises", () => {
    render(<Harness values={[0.2, 0.2, 0.2]} max={1} />);
    const low = litCellCount();

    cleanup();
    resetDraws();
    render(<Harness values={[1, 1, 1]} max={1} />);

    expect(litCellCount()).toBeGreaterThan(low);
  });

  it("reshapes on animation frames when motion is allowed", async () => {
    const { rerender } = render(<Harness values={[0, 0]} max={1} reducedMotion={false} />);
    expect(canvas.context.fillRect).not.toHaveBeenCalled();

    rerender(<Harness values={[1, 1]} max={1} reducedMotion={false} />);
    await nextFrame();

    expect(canvas.context.fillRect).toHaveBeenCalled();
  });

  it("draws nothing for an empty scale beyond the resting grid", () => {
    render(<Harness values={[5, 5]} max={0} />);

    expect(litCellCount()).toBe(0);
  });

  it("lights the field around the pointer and lets it decay again", async () => {
    render(<Harness values={[0, 0]} max={1} reducedMotion={false} />);
    await nextFrame();
    expect(await litInNextFrame()).toBe(0);

    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 180, clientY: 40 }));
    await nextFrame();
    const glowing = await litInNextFrame();
    expect(glowing).toBeGreaterThan(0);

    document.dispatchEvent(new MouseEvent("pointerleave"));
    for (let i = 0; i < 12; i++) await nextFrame();

    expect(await litInNextFrame()).toBeLessThan(glowing);
  });
});
