import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sparkline } from "./sparkline";

afterEach(cleanup);

function barHeights(label: string): string[] {
  return Array.from(screen.getByRole("img", { name: label }).children).map(
    (bar) => (bar as HTMLElement).style.height,
  );
}

describe("Sparkline", () => {
  it("scales bars against the peak value", () => {
    render(<Sparkline values={[0, 5, 10]} height={20} label="14-day cost" />);

    expect(barHeights("14-day cost")).toEqual(["2px", "10px", "20px"]);
  });

  it("keeps empty days visible with a 2px floor", () => {
    render(<Sparkline values={[0, 0, 100]} height={20} label="floor" />);

    expect(barHeights("floor")).toEqual(["2px", "2px", "20px"]);
  });

  it("renders every bar at the floor when the peak is zero", () => {
    render(<Sparkline values={[0, 0, 0]} height={20} label="empty" />);

    expect(barHeights("empty")).toEqual(["2px", "2px", "2px"]);
  });
});
