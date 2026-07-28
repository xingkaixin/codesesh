import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addCalendarDays,
  countCalendarDays,
  startOfCalendarDay,
  toCalendarDayKey,
} from "../calendar-day.js";

/**
 * Node re-reads the zone when TZ changes, so each case owns its timezone for the
 * duration of the test and the stub is cleared afterwards.
 */
function useTimeZone(timeZone: string): void {
  vi.stubEnv("TZ", timeZone);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

interface CalendarCase {
  name: string;
  timeZone: string;
  from: [number, number, number];
  to: [number, number, number];
  expected: string[];
}

const CASES: CalendarCase[] = [
  {
    name: "no DST transition",
    timeZone: "UTC",
    from: [2026, 5, 1],
    to: [2026, 5, 3],
    expected: ["2026-06-01", "2026-06-02", "2026-06-03"],
  },
  {
    // The two local midnights are 47 hours apart, so a 24h stride skips 03-09.
    name: "spring forward",
    timeZone: "America/New_York",
    from: [2026, 2, 7],
    to: [2026, 2, 9],
    expected: ["2026-03-07", "2026-03-08", "2026-03-09"],
  },
  {
    // 49 hours apart: a 24h stride repeats 11-01 and never reaches 11-02.
    name: "fall back",
    timeZone: "America/New_York",
    from: [2026, 9, 31],
    to: [2026, 10, 2],
    expected: ["2026-10-31", "2026-11-01", "2026-11-02"],
  },
  {
    name: "southern hemisphere transition",
    timeZone: "Australia/Sydney",
    from: [2026, 3, 4],
    to: [2026, 3, 6],
    expected: ["2026-04-04", "2026-04-05", "2026-04-06"],
  },
];

describe("CS-133: calendar days across DST transitions", () => {
  it.each(CASES)(
    "enumerates each day exactly once for $name",
    ({ timeZone, from, to, expected }) => {
      useTimeZone(timeZone);
      const start = new Date(from[0], from[1], from[2], 12).getTime();
      const end = new Date(to[0], to[1], to[2], 12).getTime();

      const count = countCalendarDays(start, end);
      const keys = Array.from({ length: count }, (_, index) =>
        toCalendarDayKey(addCalendarDays(start, index)),
      );

      expect(keys).toEqual(expected);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );

  it.each(CASES)("lands on local midnight for $name", ({ timeZone, from }) => {
    useTimeZone(timeZone);
    const noon = new Date(from[0], from[1], from[2], 12).getTime();

    for (let offset = -2; offset <= 2; offset += 1) {
      const midnight = new Date(addCalendarDays(noon, offset));
      expect(midnight.getHours()).toBe(0);
      expect(midnight.getMinutes()).toBe(0);
      expect(midnight.getSeconds()).toBe(0);
      expect(midnight.getMilliseconds()).toBe(0);
    }
  });

  it("counts a single day for a range inside one calendar day", () => {
    useTimeZone("America/New_York");
    const noon = new Date(2026, 2, 8, 12).getTime();

    expect(countCalendarDays(startOfCalendarDay(noon), noon)).toBe(1);
  });
});
