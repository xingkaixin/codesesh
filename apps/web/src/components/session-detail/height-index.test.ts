import { describe, expect, it } from "vitest";
import { HeightIndex } from "./height-index";

const ESTIMATE = 280;
const GAP = 16;

/** Straightforward O(N) model of the same layout, used as the oracle. */
function referenceOffsets(heights: Array<number | undefined>): {
  starts: number[];
  ends: number[];
  total: number;
} {
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index] ?? ESTIMATE;
    starts.push(offset);
    ends.push(offset + height);
    offset += height + (index === heights.length - 1 ? 0 : GAP);
  }
  return { starts, ends, total: offset };
}

describe("CS-143: HeightIndex", () => {
  it("matches the reference layout while heights are unmeasured", () => {
    const index = new HeightIndex(5, ESTIMATE, GAP);
    const reference = referenceOffsets(Array.from({ length: 5 }));

    expect([0, 1, 2, 3, 4].map((i) => index.startAt(i))).toEqual(reference.starts);
    expect([0, 1, 2, 3, 4].map((i) => index.endAt(i))).toEqual(reference.ends);
    expect(index.totalSize).toBe(reference.total);
  });

  it("matches the reference layout after arbitrary measurements", () => {
    const heights = [120, undefined, 640, 90, undefined, 310];
    const index = new HeightIndex(heights.length, ESTIMATE, GAP);
    heights.forEach((height, position) => {
      if (height != null) index.setHeight(position, height);
    });
    const reference = referenceOffsets(heights);

    expect(heights.map((_, i) => index.startAt(i))).toEqual(reference.starts);
    expect(heights.map((_, i) => index.endAt(i))).toEqual(reference.ends);
    expect(index.totalSize).toBe(reference.total);
  });

  it("ignores a repeat measurement within a pixel", () => {
    const index = new HeightIndex(3, ESTIMATE, GAP);

    expect(index.setHeight(1, 300)).toBe(true);
    expect(index.setHeight(1, 300.4)).toBe(false);
    expect(index.setHeight(1, 340)).toBe(true);
  });

  it.each([
    ["out of range low", -1],
    ["out of range high", 99],
  ])("ignores a measurement %s", (_name, position) => {
    const index = new HeightIndex(3, ESTIMATE, GAP);

    expect(index.setHeight(position, 200)).toBe(false);
    expect(index.totalSize).toBe(referenceOffsets(Array.from({ length: 3 })).total);
  });

  it.each([
    ["zero", 0],
    ["negative", -5],
    ["not a number", Number.NaN],
  ])("ignores a %s height", (_name, height) => {
    const index = new HeightIndex(3, ESTIMATE, GAP);

    expect(index.setHeight(0, height)).toBe(false);
  });

  it("locates the items overlapping a viewport", () => {
    const heights = [100, 200, 300, 400];
    const index = new HeightIndex(heights.length, ESTIMATE, GAP);
    heights.forEach((height, position) => index.setHeight(position, height));
    const reference = referenceOffsets(heights);

    // Viewport starting inside item 1 and ending inside item 2.
    const start = reference.starts[1]! + 10;
    const end = reference.starts[2]! + 10;

    expect(index.firstEndAfter(start)).toBe(1);
    expect(index.firstStartAfter(end)).toBe(3);
  });

  it("keeps offsets correct for a large list with scattered measurements", () => {
    const count = 10_000;
    const heights: Array<number | undefined> = Array.from({ length: count });
    const index = new HeightIndex(count, ESTIMATE, GAP);

    for (let position = 0; position < count; position += 7) {
      const height = 100 + (position % 500);
      heights[position] = height;
      index.setHeight(position, height);
    }
    const reference = referenceOffsets(heights);

    expect(index.totalSize).toBe(reference.total);
    for (const position of [0, 1, 7, 1234, 5000, 9998, 9999]) {
      expect(index.startAt(position)).toBe(reference.starts[position]);
      expect(index.endAt(position)).toBe(reference.ends[position]);
    }
  });

  // Rebuilding a prefix array per measurement is O(N) each, so measuring every
  // row of a 10k transcript costs O(N²) — around 10^8 operations. A logarithmic
  // update finishes this in milliseconds; the bound is loose on purpose.
  it("measures every row of a 10k list without quadratic work", () => {
    const count = 10_000;
    const index = new HeightIndex(count, ESTIMATE, GAP);
    const heights: number[] = [];

    const started = performance.now();
    for (let position = 0; position < count; position += 1) {
      const height = 80 + (position % 400);
      heights.push(height);
      index.setHeight(position, height);
    }
    const durationMs = performance.now() - started;

    expect(index.totalSize).toBe(referenceOffsets(heights).total);
    expect(durationMs).toBeLessThan(1_000);
  });
});
