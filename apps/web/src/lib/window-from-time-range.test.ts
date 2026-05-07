import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowFromTimeRange } from "./api";
import { isValidIsoDate } from "./useTimeRange";

describe("windowFromTimeRange", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty window for null/undefined (no override, falls through to defaults)", () => {
    expect(windowFromTimeRange(null)).toEqual({});
    expect(windowFromTimeRange(undefined)).toEqual({});
  });

  it("emits an explicit wide window for { kind: 'all' } so backend defaults don't reassert", () => {
    // The dropdown's "All time" label must mean what it says — without an
    // explicit override, /api/dashboard would still apply its 30-day default
    // and /api/sessions would fall back to CLI defaults, both of which would
    // contradict the UI label.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 8, 14, 30, 0));
    const window = windowFromTimeRange({ kind: "all" });
    expect(window.from).toBe(0);
    expect(window.to).toBe(Date.now());
  });

  it("preset returns days AND from/to so /sessions /search /agents (no days parser) all filter correctly", () => {
    // Backend /sessions, /search, /agents handlers parse from/to but NOT days.
    // Without explicit from/to a "Last 7d" preset would only narrow the
    // dashboard; sessions list would still show everything. We send all three
    // so every endpoint is consistent with the dropdown selection.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 8, 14, 30, 0));
    const window = windowFromTimeRange({ kind: "preset", days: 7 });
    expect(window.days).toBe(7);
    expect(window.from).toBeDefined();
    expect(window.to).toBe(Date.now());
    const fromDate = new Date(window.from!);
    expect(fromDate.getDate()).toBe(2); // 2026-05-08 - 6 days = 2026-05-02 (start-of-day)
    expect(fromDate.getHours()).toBe(0);
  });

  it("translates yesterday into a closed inclusive 24-hour window via end-of-local-day", () => {
    // Pin to a non-DST date so a baseline day is exactly 86400000 - 1 ms long;
    // the DST-safe path is exercised by the next test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 8, 14, 30, 0));
    const window = windowFromTimeRange({ kind: "yesterday" });
    expect(window.from).toBeDefined();
    expect(window.to).toBeDefined();
    const fromDate = new Date(window.from!);
    const toDate = new Date(window.to!);
    expect(fromDate.getDate()).toBe(7);
    expect(fromDate.getHours()).toBe(0);
    expect(toDate.getDate()).toBe(7);
    expect(toDate.getHours()).toBe(23);
    expect(toDate.getMinutes()).toBe(59);
    expect(toDate.getMilliseconds()).toBe(999);
  });

  it("yesterday boundary is the last millisecond of yesterday in local time, not from + 86400000 - 1", () => {
    // Regression for the DST bug where we used a fixed 24h delta. Even on a
    // non-DST day we now derive `to` via setDate(+1)+setMilliseconds(-1), so
    // a date crossing midnight always lands at the local 23:59:59.999 of the
    // previous day rather than risk shifting 1 hour on DST transition days.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 9, 14, 0, 0)); // 2026-03-09 (US spring DST started 2026-03-08)
    const window = windowFromTimeRange({ kind: "yesterday" });
    const toDate = new Date(window.to!);
    expect(toDate.getFullYear()).toBe(2026);
    expect(toDate.getMonth()).toBe(2);
    expect(toDate.getDate()).toBe(8);
    expect(toDate.getHours()).toBe(23);
    expect(toDate.getMinutes()).toBe(59);
    expect(toDate.getSeconds()).toBe(59);
    expect(toDate.getMilliseconds()).toBe(999);
  });

  it("translates custom { from } only into open-ended window from start-of-day", () => {
    const window = windowFromTimeRange({ kind: "custom", from: "2026-04-15" });
    expect(window.from).toBeDefined();
    expect(window.to).toBeUndefined();
    const fromDate = new Date(window.from!);
    expect(fromDate.getFullYear()).toBe(2026);
    expect(fromDate.getMonth()).toBe(3);
    expect(fromDate.getDate()).toBe(15);
    expect(fromDate.getHours()).toBe(0);
  });

  it("translates custom { from, to } into closed inclusive end-of-local-day window", () => {
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
    expect(toDate.getMilliseconds()).toBe(999);
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
});

describe("isValidIsoDate", () => {
  it("accepts well-formed YYYY-MM-DD dates that exist on the calendar", () => {
    expect(isValidIsoDate("2026-04-15")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true); // leap year
    expect(isValidIsoDate("2026-12-31")).toBe(true);
  });

  it("rejects format mismatches", () => {
    expect(isValidIsoDate("2026/04/15")).toBe(false);
    expect(isValidIsoDate("2026-4-15")).toBe(false);
    expect(isValidIsoDate("not-a-date")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });

  it("rejects calendar-impossible dates that JS Date silently normalizes (round-trip check)", () => {
    // Without the round-trip check, `new Date("2026-02-31")` produces 2026-03-03
    // and `getTime()` is a finite number — so the URL ?from=2026-02-31 would
    // silently query March 3rd instead of being rejected.
    expect(isValidIsoDate("2026-02-31")).toBe(false);
    expect(isValidIsoDate("2026-13-01")).toBe(false); // month 13
    expect(isValidIsoDate("2026-04-31")).toBe(false); // April has 30 days
    expect(isValidIsoDate("2025-02-29")).toBe(false); // 2025 is not a leap year
  });
});
