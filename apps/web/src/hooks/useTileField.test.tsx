import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubAnimationFrames, stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
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
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it("lights the field around the pointer and decays on idle frames", () => {
    vi.useFakeTimers();
    const frames = stubAnimationFrames();
    const { container } = render(<Harness values={[0, 0]} max={1} reducedMotion={false} />);
    const host = container.querySelector("canvas")!.parentElement!;
    let now = performance.now() + 1_000;

    act(() => frames.runNext(now));
    expect(frames.pendingCount()).toBe(0);

    host.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 40 }));
    resetDraws();
    act(() => frames.runNext((now += 50)));
    const glowing = litCellCount();
    expect(glowing).toBeGreaterThan(0);

    host.dispatchEvent(new MouseEvent("pointerleave"));
    let decayed = glowing;
    for (let i = 0; i < 12; i++) {
      if (frames.pendingCount() === 0) act(() => vi.advanceTimersByTime(51));
      resetDraws();
      act(() => frames.runNext((now += 50)));
      decayed = litCellCount();
    }

    expect(decayed).toBeLessThan(glowing);
  });

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
