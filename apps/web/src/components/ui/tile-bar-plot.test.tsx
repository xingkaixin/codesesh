import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubCanvas, type StubbedCanvas } from "../../test/canvas-stub";
import { TileBarPlot } from "./tile-bar-plot";

let canvas: StubbedCanvas;

beforeEach(() => {
  canvas = stubCanvas({ width: 200, height: 100 });
});

afterEach(() => {
  cleanup();
  canvas.restore();
  vi.restoreAllMocks();
});

describe("TileBarPlot", () => {
  it("reports a bar only when the pointer target changes", () => {
    const onHover = vi.fn();
    render(
      <TileBarPlot
        values={[[100], [100]]}
        axisMax={100}
        colors={["#fff"]}
        hovered={null}
        onHover={onHover}
        height={100}
        ariaLabel="Usage"
        itemLabels={["Day one", "Day two"]}
      />,
    );
    const surface = screen.getByRole("listbox", { name: "Usage" }).parentElement!;

    fireEvent.pointerMove(surface, { clientX: 50, clientY: 50 });
    fireEvent.pointerMove(surface, { clientX: 50, clientY: 50 });

    expect(onHover).toHaveBeenCalledOnce();
    expect(onHover).toHaveBeenLastCalledWith({ column: 0, band: null });

    fireEvent.pointerMove(surface, { clientX: 150, clientY: 50 });
    expect(onHover).toHaveBeenCalledTimes(2);
    expect(onHover).toHaveBeenLastCalledWith({ column: 1, band: null });
  });
});
