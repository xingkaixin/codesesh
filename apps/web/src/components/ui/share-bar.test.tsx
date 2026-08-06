import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ShareBar, StackedShareBar } from "./share-bar";

afterEach(cleanup);

function segmentWidths(label: string): number[] {
  return Array.from(screen.getByRole("img", { name: label }).children).map((segment) =>
    Number.parseFloat((segment as HTMLElement).style.width),
  );
}

describe("ShareBar", () => {
  it("renders the fill at the given ratio", () => {
    const { container } = render(<ShareBar ratio={0.25} />);
    const fill = container.children[0]!.children[0] as HTMLElement;

    expect(fill.style.width).toBe("25%");
  });

  it("clamps out-of-range and non-finite ratios", () => {
    const { container } = render(
      <>
        <ShareBar ratio={2} />
        <ShareBar ratio={-1} />
        <ShareBar ratio={Number.NaN} />
      </>,
    );
    const fills = Array.from(container.children).map(
      (track) => (track.firstElementChild as HTMLElement).style.width,
    );

    expect(fills).toEqual(["100%", "0%", "0%"]);
  });
});

describe("StackedShareBar", () => {
  it("splits the track proportionally", () => {
    render(
      <StackedShareBar
        label="花费构成"
        segments={[
          { key: "a", value: 75, color: "var(--chart-1)" },
          { key: "b", value: 25, color: "var(--chart-2)" },
        ]}
      />,
    );

    expect(segmentWidths("花费构成")).toEqual([75, 25]);
  });

  it("lets the last segment absorb rounding so the widths sum to 100", () => {
    render(
      <StackedShareBar
        label="thirds"
        segments={[
          { key: "a", value: 1, color: "var(--chart-1)" },
          { key: "b", value: 1, color: "var(--chart-2)" },
          { key: "c", value: 1, color: "var(--chart-3)" },
        ]}
      />,
    );
    const widths = segmentWidths("thirds");

    expect(widths[0]).toBe(33.33);
    expect(widths[1]).toBe(33.33);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 6);
  });

  it("collapses to zero-width segments when the total is zero", () => {
    render(
      <StackedShareBar
        label="empty"
        segments={[
          { key: "a", value: 0, color: "var(--chart-1)" },
          { key: "b", value: 0, color: "var(--chart-2)" },
        ]}
      />,
    );

    expect(segmentWidths("empty")).toEqual([0, 0]);
  });
});
