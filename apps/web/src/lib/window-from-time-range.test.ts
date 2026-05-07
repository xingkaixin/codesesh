import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowFromTimeRange } from "./api";

describe("windowFromTimeRange", () => {
  it("returns empty window for null/undefined (no filter)", () => {
    expect(windowFromTimeRange(null)).toEqual({});
    expect(windowFromTimeRange(undefined)).toEqual({});
  });

  it("returns empty window for { kind: 'all' } (no filter)", () => {
    expect(windowFromTimeRange({ kind: "all" })).toEqual({});
  });

  it("returns days-only window for preset (lets backend resolve from/to)", () => {
    expect(windowFromTimeRange({ kind: "preset", days: 7 })).toEqual({ days: 7 });
    expect(windowFromTimeRange({ kind: "preset", days: 30 })).toEqual({ days: 30 });
  });

  it("translates yesterday into a closed inclusive 24-hour window", () => {
    // Pin "now" so the test isn't time-of-day flaky.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 8, 14, 30, 0)); // 2026-05-08 14:30 local

    const window = windowFromTimeRange({ kind: "yesterday" });
    expect(window.from).toBeDefined();
    expect(window.to).toBeDefined();
    const fromDate = new Date(window.from!);
    const toDate = new Date(window.to!);
    expect(fromDate.getFullYear()).toBe(2026);
    expect(fromDate.getMonth()).toBe(4); // May
    expect(fromDate.getDate()).toBe(7); // yesterday
    expect(fromDate.getHours()).toBe(0);
    expect(toDate.getDate()).toBe(7);
    expect(toDate.getHours()).toBe(23);
    expect(toDate.getMinutes()).toBe(59);
    // Closed-inclusive window: 24 hours - 1ms.
    expect(window.to! - window.from!).toBe(86400000 - 1);
  });

  it("translates custom { from } only into open-ended window from start-of-day", () => {
    const window = windowFromTimeRange({ kind: "custom", from: "2026-04-15" });
    expect(window.from).toBeDefined();
    expect(window.to).toBeUndefined();
    const fromDate = new Date(window.from!);
    expect(fromDate.getFullYear()).toBe(2026);
    expect(fromDate.getMonth()).toBe(3); // April (0-indexed)
    expect(fromDate.getDate()).toBe(15);
    expect(fromDate.getHours()).toBe(0);
  });

  it("translates custom { from, to } into a closed inclusive window (to = end-of-day)", () => {
    const window = windowFromTimeRange({
      kind: "custom",
      from: "2026-04-15",
      to: "2026-04-20",
    });
    const fromDate = new Date(window.from!);
    const toDate = new Date(window.to!);
    expect(fromDate.getDate()).toBe(15);
    expect(fromDate.getHours()).toBe(0);
    expect(toDate.getDate()).toBe(20);
    expect(toDate.getHours()).toBe(23);
    expect(toDate.getMinutes()).toBe(59);
    expect(toDate.getSeconds()).toBe(59);
    // Same-day "from = to" is a 24-hour closed window for that calendar day.
    const sameDay = windowFromTimeRange({
      kind: "custom",
      from: "2026-04-15",
      to: "2026-04-15",
    });
    expect(sameDay.to! - sameDay.from!).toBe(86400000 - 1);
  });

  it("returns empty window when custom 'from' is malformed (degrades safely)", () => {
    expect(windowFromTimeRange({ kind: "custom", from: "not-a-date" })).toEqual({});
  });

  it("ignores malformed custom 'to' but still returns 'from'", () => {
    const window = windowFromTimeRange({
      kind: "custom",
      from: "2026-04-15",
      to: "garbage",
    });
    expect(window.from).toBeDefined();
    expect(window.to).toBeUndefined();
  });

  beforeEach(() => {
    // Each test starts with real timers; the yesterday case opts into fakes.
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
