import { afterEach, describe, expect, it, vi } from "vitest";
import { addCalendarDays, startOfCalendarDay } from "@codesesh/core/contract";
import { resolveTimeWindow } from "./time-window-resolution.js";

const NOW = new Date("2026-07-17T08:00:00.000Z").getTime();

describe("resolveTimeWindow", () => {
  it("gives an explicit CLI from value priority over days", () => {
    const from = "2026-07-01T00:00:00.000Z";

    expect(resolveTimeWindow({ mode: "cli", from, days: "7", now: NOW })).toEqual({
      from: new Date(from).getTime(),
      to: undefined,
    });
  });

  it("resolves positive CLI days as inclusive local calendar days", () => {
    expect(resolveTimeWindow({ mode: "cli", days: "7", now: NOW })).toEqual({
      from: addCalendarDays(startOfCalendarDay(NOW), -6),
      to: undefined,
      days: 7,
    });
  });

  it("preserves CLI all-time and date validation semantics", () => {
    expect(resolveTimeWindow({ mode: "cli", days: "0", now: NOW })).toEqual({
      to: undefined,
      days: 0,
    });
    expect(() => resolveTimeWindow({ mode: "cli", from: "not-a-date" })).toThrow(
      "Invalid date: not-a-date",
    );
  });

  // `days` counts the calendar days the window covers, matching one bucket per day.
  it("derives dashboard days from an explicit query window", () => {
    const from = new Date("2026-07-10T00:00:00.000Z").getTime();
    const to = new Date("2026-07-13T00:00:00.000Z").getTime();

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from, to, hasExplicitFrom: true },
      }),
    ).toEqual({ from, to, days: 4 });
  });

  it("lets dashboard query days override inherited CLI bounds", () => {
    const defaultFrom = addCalendarDays(startOfCalendarDay(NOW), -6);

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from: defaultFrom, hasExplicitFrom: false },
        days: "3",
        defaultDays: 7,
        now: NOW,
      }),
    ).toEqual({ from: addCalendarDays(startOfCalendarDay(NOW), -2), to: NOW, days: 3 });
  });

  it("supports explicit all-time dashboard windows", () => {
    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from: addCalendarDays(startOfCalendarDay(NOW), -6), hasExplicitFrom: false },
        days: "0",
        defaultDays: 7,
        now: NOW,
      }),
    ).toEqual({ to: NOW, days: 0 });
  });

  it("uses the 30-day dashboard fallback from the local day boundary", () => {
    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { hasExplicitFrom: false },
        now: NOW,
      }),
    ).toEqual({
      from: addCalendarDays(startOfCalendarDay(NOW), -29),
      to: NOW,
      days: 30,
    });
  });

  it("normalizes relative dashboard defaults to their calendar range", () => {
    const defaultFrom = NOW - 5 * 24 * 60 * 60 * 1000;

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from: defaultFrom, to: NOW, hasExplicitFrom: false },
        defaultDays: 5,
      }),
    ).toEqual({ from: addCalendarDays(startOfCalendarDay(NOW), -4), to: NOW, days: 5 });
  });

  it("derives the day count from exact inherited bounds", () => {
    const from = addCalendarDays(startOfCalendarDay(NOW), -4);

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from, to: NOW, hasExplicitFrom: false },
      }),
    ).toEqual({ from, to: NOW, days: 5 });
  });
});

describe("CS-133: dashboard windows are calendar ranges", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The web preset builds the same window from calendar fields; both must land
  // on the same local midnight even when a DST transition sits inside the range.
  it.each([
    { name: "spring forward", now: [2026, 2, 10, 8], days: 7 },
    { name: "fall back", now: [2026, 10, 3, 8], days: 7 },
    { name: "no transition", now: [2026, 5, 10, 8], days: 30 },
  ])("matches the web preset boundary for $name", ({ now, days }) => {
    vi.stubEnv("TZ", "America/New_York");
    const nowMs = new Date(now[0]!, now[1]!, now[2]!, now[3]!).getTime();
    const webPresetFrom = new Date(now[0]!, now[1]!, now[2]! - days + 1).getTime();

    const resolved = resolveTimeWindow({
      mode: "dashboard",
      window: { hasExplicitFrom: false },
      days: String(days),
      now: nowMs,
    });

    expect(resolved.from).toBe(webPresetFrom);
    expect(new Date(resolved.from!).getHours()).toBe(0);
  });

  it("treats CLI date-only bounds as inclusive local calendar dates", () => {
    vi.stubEnv("TZ", "America/New_York");

    expect(resolveTimeWindow({ mode: "cli", from: "2026-03-07", to: "2026-03-09" })).toEqual({
      from: new Date(2026, 2, 7).getTime(),
      to: new Date(2026, 2, 10).getTime() - 1,
    });
  });

  it("reports elapsed days as calendar days across a transition", () => {
    vi.stubEnv("TZ", "America/New_York");
    const from = new Date(2026, 2, 7).getTime();
    const to = new Date(2026, 2, 9, 23, 59).getTime();

    expect(
      resolveTimeWindow({
        mode: "dashboard",
        window: { from, hasExplicitFrom: true },
        now: to,
      }).days,
    ).toBe(3);
  });
});
