import { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stubCanvas, type StubbedCanvas } from "../test/canvas-stub";
import { useDonutRing } from "./useDonutRing";

/** The ring's logical space, so a client coordinate is also a ring coordinate. */
const SIZE = 200;
const CENTRE = 100;
/** Between the inner (55) and outer (86) radius. */
const ON_RING = 70;

async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

let hitTest: (x: number, y: number) => number | null;
let canvas: StubbedCanvas;

function Harness({
  shares,
  hovered = null,
  reducedMotion = true,
}: {
  shares: number[];
  hovered?: number | null;
  reducedMotion?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ring = useDonutRing(ref, {
    shares,
    colors: ["var(--chart-1)", "#7c5cff"],
    hovered,
    reducedMotion,
  });
  hitTest = ring.hitTest;

  return (
    <div>
      <canvas ref={ref} />
    </div>
  );
}

beforeEach(() => {
  canvas = stubCanvas({ width: SIZE, height: SIZE });
});

afterEach(() => {
  cleanup();
  canvas.restore();
});

describe("useDonutRing", () => {
  it("traces one clipped wedge per share", () => {
    render(<Harness shares={[0.5, 0.5]} />);

    expect(canvas.context.clip).toHaveBeenCalledTimes(2);
    expect(canvas.context.fill).toHaveBeenCalledTimes(2);
  });

  it("skips a share too thin to draw", () => {
    render(<Harness shares={[1, 0]} />);

    expect(canvas.context.clip).toHaveBeenCalledTimes(1);
  });

  it("offsets the hovered slice so it reads as lifted", () => {
    render(<Harness shares={[0.5, 0.5]} hovered={1} />);

    expect(canvas.context.translate).toHaveBeenCalledTimes(1);
  });

  it("maps a pointer on the ring to its slice", () => {
    render(<Harness shares={[0.5, 0.5]} />);

    // The first share starts at 12 o'clock, so its middle points right.
    expect(hitTest(CENTRE + ON_RING, CENTRE)).toBe(0);
    expect(hitTest(CENTRE - ON_RING, CENTRE)).toBe(1);
  });

  it("ignores the hole and everything past the rim", () => {
    render(<Harness shares={[0.5, 0.5]} />);

    expect(hitTest(CENTRE, CENTRE)).toBeNull();
    expect(hitTest(CENTRE + SIZE, CENTRE)).toBeNull();
  });

  it("eases into a new set of shares on an animation frame", async () => {
    const { rerender } = render(<Harness shares={[0.5, 0.5]} reducedMotion={false} />);
    expect(canvas.context.clearRect).not.toHaveBeenCalled();

    rerender(<Harness shares={[0.8, 0.2]} reducedMotion={false} />);
    await nextFrame();

    expect(canvas.context.clearRect).toHaveBeenCalled();
  });
});
